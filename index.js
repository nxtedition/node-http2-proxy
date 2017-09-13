const http2 = require('http2')
const http = require('http')
const net = require('net')

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

const POOL = []
module.exports = class Proxy {
  static ws (req, socket, head, options, callback) {
    Proxy.proxy(req, socket, head, options, callback)
  }
  static web (req, res, options, callback) {
    Proxy.proxy(req, res, null, options, callback)
  }
  static proxy (req, resOrSocket, headOrNil, options) {
    const proxy = POOL.pop() || new Proxy()
    proxy.run(req, resOrSocket, headOrNil, options)
  }

  constructor () {
    this._onUpgrade = this._onUpgrade.bind(this)
    this._onResponse = this._onResponse.bind(this)
    this._onError = this._onError.bind(this)
    this._onProxyError = this._onProxyError.bind(this)
    this._onRequestClose = this._onRequestClose.bind(this)
    this._onProxyClose = this._onProxyClose.bind(this)
    this._onRequestTimeout = this._onRequestTimeout.bind(this)
    this._onAborted = this._onAborted.bind(this)
    this._onGatewayTimeout = this._onGatewayTimeout.bind(this)

    this.hasError = false
    this.req = null
    this.proxyReq = null
    this.resOrSocket = null
    this.onRes = null
  }

  run (req, resOrSocket, headOrNil, {
    hostname,
    port,
    timeout,
    proxyTimeout,
    proxyName,
    onReq,
    onRes
  }) {
    this.req = req
    this.resOrSocket = resOrSocket
    this.onRes = onRes

    req.on('error', this._onError)
    resOrSocket.on('error', this._onError)

    if (resOrSocket instanceof net.Socket) {
      if (req.method !== 'GET') {
        return this._onError(createError('method not allowed', null, 405))
      }

      if (!req.headers[HTTP2_HEADER_UPGRADE] ||
          req.headers[HTTP2_HEADER_UPGRADE].toLowerCase() !== 'websocket') {
        return this._onError(createError('bad request', null, 400))
      }
    }

    if (req.httpVersion !== '1.1' && req.httpVersion !== '2.0') {
      return this._onError(createError('http version not supported', null, 505))
    }

    if (proxyName && req.headers[HTTP2_HEADER_VIA]) {
      for (const name of req.headers[HTTP2_HEADER_VIA].split(',')) {
        if (sanitize(name).endsWith(proxyName.toLowerCase())) {
          return this._onError(createError('loop detected', null, 508))
        }
      }
    }

    if (timeout) {
      req.setTimeout(timeout, this._onRequestTimeout)
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

    this.proxyReq = http.request(options)

    req
      .on('close', this._onRequestClose)
      .pipe(this.proxyReq)
      .on('close', this._onProxyClose)
      .on('error', this._onProxyError)
      // NOTE http.ClientRequest emits "socket hang up" error when aborted
      // before having received a response, i.e. there is no need to listen for
      // proxyReq.on('aborted', ...).
      .on('timeout', this._onGatewayTimeout)
      .on('response', this._onResponse)
      .on('upgrade', this._onUpgrade)
  }

  _release () {
    this.hasError = false
    this.req = null
    this.proxyReq = null
    this.resOrSocket = null
    this.onRes = null
    POOL.push(this)
  }

  _onRequestClose () {
    if (this.proxyReq && !this.proxyReq.aborted) {
      this.proxyReq.abort()
    }
    // this.req = null
    // if (!this.req && !this.proxyReq) {
    //   process.nextTick(this._release)
    // }
  }

  _onProxyClose () {
    // this.proxyReq = null
    // if (!this.req && !this.proxyReq) {
    //   this._release()
    // }
  }

  _onRequestTimeout () {
    this._onError(createError('request timeout', null, 408))
  }

  _onAborted () {
    this._onProxyError(createError('socket hang up', 'ECONNRESET', 502))
  }

  _onGatewayTimeout () {
    this._onProxyError(createError('gateway timeout', null, 504))
  }

  _onResponse (proxyRes) {
    proxyRes.on('aborted', this._onAborted)

    if (this.resOrSocket instanceof net.Socket) {
      if (this.onRes) {
        this.onRes(this.req, this.resOrSocket)
      }

      if (!proxyRes.upgrade) {
        this.resOrSocket.end()
      }
    } else {
      setupHeaders(proxyRes.headers)

      this.resOrSocket.statusCode = proxyRes.statusCode
      for (const key of Object.keys(proxyRes.headers)) {
        this.resOrSocket.setHeader(key, proxyRes.headers[key])
      }

      if (this.onRes) {
        this.onRes(this.req, this.resOrSocket)
      }

      this.resOrSocket.writeHead(this.resOrSocket.statusCode)
      proxyRes
        .on('end', () => this.resOrSocket.addTrailers(proxyRes.trailers))
        .on('error', this._onProxyError)
        .pipe(this.resOrSocket)
    }
  }

  _onUpgrade (proxyRes, proxySocket, proxyHead) {
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

    this.resOrSocket.write(head)

    proxySocket
      .on('error', this._onProxyError)
      .pipe(this.resOrSocket)
      .pipe(proxySocket)
  }

  _onError (err, statusCode = err.statusCode || 500) {
    if (this.hasError) {
      return
    }

    this.hasError = true

    if (this.resOrSocket.closed === true ||
        this.resOrSocket.headersSent !== false ||
        !this.resOrSocket.writeHead
    ) {
      this.resOrSocket.destroy()
    } else {
      this.resOrSocket.writeHead(statusCode)
      this.resOrSocket.end()
    }

    if (this.callback) {
      this.callback(err, this.req, this.resOrSocket)
    } else {
      throw err
    }
  }

  _onProxyError (err) {
    if (this.proxyReq.aborted) {
      return
    }

    this.proxyReq.abort()

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    } else if (err.code === 'ECONNRESET') {
      err.statusCode = 502
    } else {
      err.statusCode = 500
    }

    this._onError(err)
  }
}

function getRequestHeaders (req) {
  const host = req.headers[HTTP2_HEADER_AUTHORITY] || req.headers[HTTP2_HEADER_HOST]
  const upgrade = req.headers[HTTP2_HEADER_UPGRADE]
  const forwarded = req.headers[HTTP2_HEADER_FORWARDED]

  const headers = setupHeaders(Object.assign({}, req.headers))

  // Remove pseudo headers
  delete headers[HTTP2_HEADER_AUTHORITY]
  delete headers[HTTP2_HEADER_METHOD]
  delete headers[HTTP2_HEADER_PATH]
  delete headers[HTTP2_HEADER_SCHEME]

  if (upgrade) {
    headers[HTTP2_HEADER_CONNECTION] = 'upgrade'
    headers[HTTP2_HEADER_UPGRADE] = 'websocket'
  }

  headers[HTTP2_HEADER_FORWARDED] = `by=${req.socket.localAddress}`
  headers[HTTP2_HEADER_FORWARDED] += `; for=${req.socket.remoteAddress}`

  if (forwarded) {
    const expr = /for=\s*([^\s]+)/ig
    while (true) {
      const m = expr.exec(forwarded)
      if (!m) {
        break
      }
      headers[HTTP2_HEADER_FORWARDED] += `; ${m[1]}`
    }
  }

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
