const http2 = require('http2')
const http = require('http')
const net = require('net')
const assert = require('assert')

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

module.exports = {
  ws (req, socket, head, options, callback) {
    impl(req, socket, head, options, callback)
  },
  web (req, res, options, callback) {
    impl(req, res, null, options, callback)
  }
}

const kReq = Symbol('req')
const kRes = Symbol('res')
const kCallback = Symbol('callback')
const kProxyReq = Symbol('proxyReq')
const kOnRes = Symbol('onRes')

function impl (req, res, headOrNil, {
  hostname,
  port,
  timeout,
  proxyTimeout,
  proxyName,
  onReq,
  onRes
}, callback) {
  req[kRes] = res

  res[kReq] = req
  res[kRes] = res
  res[kCallback] = callback

  let promise

  if (!callback) {
    promise = new Promise((resolve, reject) => {
      res[kCallback] = err => err ? reject(err) : resolve()
    })
  }

  if (res instanceof net.Socket) {
    if (req.method !== 'GET') {
      return onFinish.call(res, createError('method not allowed', null, 405))
    }

    if (!req.headers[HTTP2_HEADER_UPGRADE] ||
        req.headers[HTTP2_HEADER_UPGRADE].toLowerCase() !== 'websocket') {
      return onFinish.call(res, createError('bad request', null, 400))
    }
  }

  if (req.httpVersion !== '1.1' && req.httpVersion !== '2.0') {
    return onFinish.call(res, createError('http version not supported', null, 505))
  }

  if (proxyName && req.headers[HTTP2_HEADER_VIA]) {
    for (const name of req.headers[HTTP2_HEADER_VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        return onFinish.call(res, createError('loop detected', null, 508))
      }
    }
  }

  if (timeout) {
    req.setTimeout(timeout, onRequestTimeout)
  }

  if (res instanceof net.Socket) {
    if (headOrNil && headOrNil.length) {
      res.unshift(headOrNil)
    }

    setupSocket(res)
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

  const proxyReq = http.request(options)

  proxyReq[kReq] = req
  proxyReq[kRes] = res
  proxyReq[kOnRes] = onRes

  res[kProxyReq] = proxyReq

  res
    .on('finish', onFinish)
    .on('close', onFinish)
    .on('error', onFinish)

  req
    .on('aborted', onFinish)
    .on('close', onFinish)
    .on('error', onFinish)
    .pipe(proxyReq)
    .on('error', onFinish)
    // NOTE http.ClientRequest emits "socket hang up" error when aborted
    // before having received a response, i.e. there is no need to listen for
    // proxyReq.on('aborted', ...).
    .on('timeout', onProxyTimeout)
    .on('response', onProxyResponse)
    .on('upgrade', onProxyUpgrade)

  return promise
}

function onFinish (err, statusCode) {
  const res = this[kRes]

  assert(res, 'missing res object')

  if (res[kProxyReq].aborted) {
    return
  }

  res[kProxyReq].abort()

  if (err) {
    err.statusCode = statusCode || err.statusCode || 500
    err.code = err.code || res.code

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    } else if (err.code === 'ECONNRESET') {
      err.statusCode = 502
    }
  }

  if (res.headersSent !== false) {
    res.destroy()
  } else {
    res.writeHead(statusCode)
    res.end()
  }

  if (res[kCallback]) {
    res[kCallback](err, res[kReq], res)
  } else {
    throw err
  }
}

function onRequestTimeout () {
  onFinish.call(this, createError('request timeout', null, 408))
}

function onProxyTimeout () {
  onFinish.call(this, createError('gateway timeout', null, 504))
}

function onProxyResponse (proxyRes) {
  if (this.aborted) {
    return
  }

  proxyRes[kRes] = this[kRes]

  proxyRes.on('aborted', onProxyResAborted)

  if (this[kRes] instanceof net.Socket) {
    if (!proxyRes.upgrade) {
      this[kRes].end()
    }
  } else {
    setupHeaders(proxyRes.headers)

    this[kRes].statusCode = proxyRes.statusCode
    for (const key of Object.keys(proxyRes.headers)) {
      this[kRes].setHeader(key, proxyRes.headers[key])
    }

    if (this[kOnRes]) {
      this[kOnRes](this[kReq], this[kRes])
    }

    this[kRes].writeHead(this[kRes].statusCode)
    proxyRes
      .on('end', function () {
        this[kRes].addTrailers(this.trailers)
      })
      .on('error', onFinish)
      .pipe(this[kRes])
  }
}

function onProxyResAborted () {
  onFinish.call(this, createError('socket hang up', 'ECONNRESET', 502))
}

function onProxyUpgrade (proxyRes, proxySocket, proxyHead) {
  if (this.aborted) {
    return
  }

  proxyRes[kRes] = this[kRes]
  proxySocket[kRes] = this[kRes]

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

  this[kRes].write(head)

  proxyRes.on('error', onFinish)

  proxySocket
    .on('error', onFinish)
    .pipe(this[kRes])
    .pipe(proxySocket)
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
  const connection = sanitize(headers[HTTP2_HEADER_CONNECTION])

  if (connection && connection !== 'close' && connection !== 'keep-alive') {
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
  return name ? name.trim().toLowerCase() : ''
}

function createError (msg, code, statusCode) {
  const err = new Error(msg)
  err.code = code
  err.statusCode = statusCode
  return err
}
