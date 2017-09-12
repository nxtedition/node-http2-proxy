const http2 = require('http2')
const http = require('http')
const net = require('net')
const reusify = require('reusify')

const {
  HTTP2_HEADER_CONNECTION,
  HTTP2_HEADER_UPGRADE,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_HOST,
  HTTP2_HEADER_KEEP_ALIVE,
  HTTP2_HEADER_PROXY_CONNECTION,
  HTTP2_HEADER_TRANSFER_ENCODING,
  HTTP2_HEADER_TE,
  HTTP2_HEADER_PROXY_AUTHORIZATION,
  HTTP2_HEADER_HTTP2_SETTINGS,
  HTTP2_HEADER_VIA,
  // XXX https://github.com/nodejs/node/issues/15337
  HTTP2_HEADER_FORWARDED = 'forwarded'
} = http2.constants

const NODE_VER = process.version.match(/v(\d+).(\d+).(\d+)(?:-(.*))/).slice(1)

if (NODE_VER[0] < 9 && (NODE_VER[0] !== 8 || NODE_VER[1] > 4)) {
  throw new Error(`unsupported node version (${process.version} < 8.5.0)`)
}

module.exports = {
  ws (req, socket, head, options, callback) {
    impl(req, socket, head, options, callback)
  },
  web (req, res, options, callback) {
    impl(req, res, null, options, callback)
  }
}

const onResponsePool = reusify(OnResponse)
const onUpgradePool = reusify(OnUpgrade)
const onErrorPool = reusify(OnError)
const onProxyErrorPool = reusify(OnProxyError)

function impl (req, resOrSocket, headOrNil, {
  hostname,
  port,
  timeout,
  proxyTimeout,
  proxyName,
  onReq,
  onRes
}, callback) {
  const onErrorObj = onErrorPool.get()
  onErrorObj.hasError = false
  onErrorObj.resOrSocket = resOrSocket
  onErrorObj.req = req
  onErrorObj.callback = callback

  const onError = onErrorObj.run

  resOrSocket.on('error', onError)

  const incoming = req.stream || req
  incoming.on('error', onError)

  try {
    if (resOrSocket instanceof net.Socket) {
      if (req.method !== 'GET') {
        throw createError('method not allowed', null, 405)
      }

      if (!req.headers[HTTP2_HEADER_UPGRADE] ||
          req.headers[HTTP2_HEADER_UPGRADE].toLowerCase() !== 'websocket') {
        throw createError('bad request', null, 400)
      }
    }

    if (!/1\.1|2\.\d/.test(req.httpVersion)) {
      throw createError('http version not supported', null, 505)
    }

    if (proxyName &&
        req.headers[HTTP2_HEADER_VIA] &&
        req.headers[HTTP2_HEADER_VIA]
          .split(',')
          .some(name => sanitize(name).endsWith(proxyName.toLowerCase()))
    ) {
      throw createError('loop detected', null, 508)
    }

    if (timeout) {
      req.setTimeout(timeout, () => onError(createError('request timeout', null, 408)))
    }

    if (resOrSocket instanceof net.Socket) {
      if (headOrNil && headOrNil.length) {
        resOrSocket.unshift(headOrNil)
      }

      setupSocket(resOrSocket)
    }

    const headers = getRequestHeaders(req)

    if (proxyName) {
      if (headers[HTTP2_HEADER_VIA]) {
        headers[HTTP2_HEADER_VIA] += `,${proxyName}`
      } else {
        headers[HTTP2_HEADER_VIA] = proxyName
      }
    }

    const options = {
      method: req.method,
      hostname,
      port,
      path: req.url,
      headers,
      timeout: proxyTimeout
    }

    if (onReq) {
      onReq(req, options)
    }

    return proxy(req, resOrSocket, options, onRes, onError)
  } catch (err) {
    return onError.run(err)
  }
}

function proxy (req, resOrSocket, options, onRes, onError) {
  const proxyReq = http.request(options)

  const onProxyErrorObj = onProxyErrorPool.get()
  onProxyErrorObj.proxyReq = proxyReq
  onProxyErrorObj.hasError = false
  onProxyErrorObj.req = req
  onProxyErrorObj.onError = onError

  req.on('close', onProxyErrorObj.release)
  req.on('close', onProxyErrorObj.abort)

  const onRequestObj = onResponsePool.get()
  onRequestObj.req = req
  onRequestObj.resOrSocket = resOrSocket
  onRequestObj.onProxyError = onProxyErrorObj.run
  onRequestObj.onRes = onRes

  req.on('close', onRequestObj.release)

  req
    .pipe(proxyReq)
    .on('error', onProxyErrorObj.run)
    // NOTE http.ClientRequest emits "socket hang up" error when aborted
    // before having received a response, i.e. there is no need to listen for
    // proxyReq.on('aborted', ...).
    .on('timeout', () => onProxyErrorObj.run(createError('gateway timeout', null, 504)))
    .on('response', onRequestObj.run)

  if (resOrSocket instanceof net.Socket) {
    const onUpgradeObj = onUpgradePool.get()
    onUpgradeObj.onProxyError = onProxyErrorObj.run
    onUpgradeObj.resOrSocket = resOrSocket

    req.on('close', onRequestObj.release)

    proxyReq.on('upgrade', onUpgradeObj.run)
  }
}

function getRequestHeaders (req) {
  const headers = setupHeaders(Object.assign({}, req.headers))

  // Remove pseudo headers
  delete headers[HTTP2_HEADER_AUTHORITY]
  delete headers[HTTP2_HEADER_METHOD]
  delete headers[HTTP2_HEADER_PATH]
  delete headers[HTTP2_HEADER_SCHEME]

  if (req.headers[HTTP2_HEADER_UPGRADE]) {
    headers[HTTP2_HEADER_CONNECTION] = 'upgrade'
    headers[HTTP2_HEADER_UPGRADE] = 'websocket'
  }

  headers[HTTP2_HEADER_FORWARDED] = `by=${req.socket.localAddress}`
  headers[HTTP2_HEADER_FORWARDED] += `; for=${req.socket.remoteAddress}`

  if (req.headers[HTTP2_HEADER_FORWARDED]) {
    const expr = /for=\s*([^\s]+)/ig
    while (true) {
      const m = expr.exec(req.headers[HTTP2_HEADER_FORWARDED])
      if (!m) {
        break
      }
      headers[HTTP2_HEADER_FORWARDED] += `; ${m[1]}`
    }
  }

  const host = req.headers[HTTP2_HEADER_AUTHORITY] || req.headers[HTTP2_HEADER_HOST]
  if (host) {
    headers[HTTP2_HEADER_FORWARDED] += `; host=${host}`
  }

  headers[HTTP2_HEADER_FORWARDED] += `; proto=${req.socket.encrypted ? 'https' : 'http'}`

  return headers
}

function setupSocket (socket) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 0)
}

function setupHeaders (headers) {
  const connection = headers[HTTP2_HEADER_CONNECTION]

  if (connection && connection !== 'close') {
    for (const name of connection.split(',')) {
      delete headers[sanitize(name)]
    }
  }

  delete headers[HTTP2_HEADER_CONNECTION]
  delete headers[HTTP2_HEADER_KEEP_ALIVE]
  delete headers[HTTP2_HEADER_TRANSFER_ENCODING]
  delete headers[HTTP2_HEADER_TE]
  delete headers[HTTP2_HEADER_UPGRADE]
  delete headers[HTTP2_HEADER_PROXY_AUTHORIZATION]
  delete headers[HTTP2_HEADER_PROXY_CONNECTION]
  delete headers[HTTP2_HEADER_HTTP2_SETTINGS]

  return headers
}

function sanitize (name) {
  return name.trim().toLowerCase()
}

function createError (msg, code, statusCode) {
  const err = new Error(msg)
  err.code = code
  err.statusCode = statusCode
  return err
}

function OnUpgrade () {
  this.next = null
  this.resOrSocket = null
  this.onProxyError = null

  let that = this

  this.release = function () {
    onUpgradePool.release(that)
  }

  this.run = function (proxyRes, proxySocket, proxyHead) {
    try {
      setupSocket(proxySocket)

      if (proxyHead && proxyHead.length) {
        proxySocket.unshift(proxyHead)
      }

      let head = 'HTTP/1.1 101 Switching Protocols'

      for (const key of Object.keys(proxyRes.headers)) {
        const value = proxyRes.headers[key]

        if (!Array.isArray(value)) {
          head += '\r\n' + key + ': ' + value
        } else {
          for (let i = 0; i < value.length; i++) {
            head += '\r\n' + key + ': ' + value[i]
          }
        }
      }

      head += '\r\n\r\n'

      that.resOrSocket.write(head)

      proxyRes.on('error', that.onProxyError)

      proxySocket
        .on('error', that.onProxyError)
        .pipe(that.resOrSocket)
        .pipe(proxySocket)
    } catch (err) {
      that.onProxyError(err)
    }
  }
}

function OnResponse () {
  this.next = null
  this.req = null
  this.resOrSocket = null
  this.onProxyError = null
  this.onRes = null

  let that = this

  this.release = function () {
    onResponsePool.release(that)
  }

  this.run = function (proxyRes) {
    try {
      proxyRes.on('aborted', () => that.onProxyError(createError('socket hang up', 'ECONNRESET', 502)))

      if (that.resOrSocket instanceof net.Socket) {
        if (that.onRes) {
          that.onRes(that.req, that.resOrSocket)
        }

        if (!proxyRes.upgrade) {
          that.resOrSocket.end()
        }
      } else {
        setupHeaders(proxyRes.headers)

        that.resOrSocket.statusCode = proxyRes.statusCode
        for (const key of Object.keys(proxyRes.headers)) {
          that.resOrSocket.setHeader(key, proxyRes.headers[key])
        }

        if (that.onRes) {
          that.onRes(that.req, that.resOrSocket)
        }

        that.resOrSocket.writeHead(that.resOrSocket.statusCode)
        proxyRes
          .on('error', that.onProxyError)
          .pipe(that.resOrSocket)
      }
    } catch (err) {
      this.onProxyError(err)
    }
  }
}

function OnError () {
  this.next = null
  this.hasError = null
  this.resOrSocket = null
  this.req = null
  this.callback = null

  const that = this

  this.run = function (err, statusCode = err.statusCode || 500) {
    try {
      if (that.hasError) {
        return
      }

      that.hasError = true

      if (that.resOrSocket.closed === true ||
          that.resOrSocket.headersSent !== false ||
          !that.resOrSocket.writeHead
      ) {
        that.resOrSocket.destroy()
      } else {
        that.resOrSocket.writeHead(statusCode)
        that.resOrSocket.end()
      }

      if (that.callback) {
        that.callback(err, that.req, that.resOrSocket)
      } else {
        throw err
      }
    } finally {
      onErrorPool.release(that)
    }
  }
}

function OnProxyError () {
  this.next = null
  this.proxyReq = null
  this.hasError = null
  this.req = null
  this.onError = null

  const that = this

  this.abort = function () {
    if (!that.proxyReq.aborted) {
      that.proxyReq.abort()
    }
  }

  this.release = function () {
    onProxyErrorPool.release(that)
  }

  this.run = function (err) {
    if (that.hasError) {
      return
    }

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    } else if (err.code === 'ECONNRESET') {
      if (!that.proxyReq.aborted) {
        err.statusCode = 502
      } else {
        return
      }
    }

    that.hasError = true
    that.req.removeListener('close', that.abort)
    that.abort()
    that.onError(err)
  }
}
