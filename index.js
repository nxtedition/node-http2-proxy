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

const NODE_VER = process.version.match(/v(\d+).(\d+).(\d+)(?:-(.*))/).slice(1)
const REQ_OPTIONS = {}

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

function impl (req, resOrSocket, headOrNil, {
  hostname,
  port,
  timeout,
  proxyTimeout,
  proxyName,
  onReq,
  onRes
}, callback) {
  const errorHandler = ErrorHandler.create(req, resOrSocket, callback)

  resOrSocket.on('error', errorHandler)

  const incoming = req.stream || req
  incoming.on('error', errorHandler)

  if (resOrSocket instanceof net.Socket) {
    if (req.method !== 'GET') {
      return errorHandler(createError('method not allowed', null, 405))
    }

    if (!req.headers[HTTP2_HEADER_UPGRADE] ||
        req.headers[HTTP2_HEADER_UPGRADE].toLowerCase() !== 'websocket') {
      return errorHandler(createError('bad request', null, 400))
    }
  }

  if (req.httpVersion !== '1.1' && req.httpVersion !== '2.0') {
    return errorHandler(createError('http version not supported', null, 505))
  }

  if (proxyName && req.headers[HTTP2_HEADER_VIA]) {
    for (const name of req.headers[HTTP2_HEADER_VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        return errorHandler(createError('loop detected', null, 508))
      }
    }
  }

  if (timeout) {
    req.setTimeout(timeout, errorHandler.requestTimeout)
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

  REQ_OPTIONS.method = req.method
  REQ_OPTIONS.hostname = hostname
  REQ_OPTIONS.port = port
  REQ_OPTIONS.path = req.url
  REQ_OPTIONS.headers = headers
  REQ_OPTIONS.timeout = proxyTimeout

  if (onReq) {
    onReq(req, REQ_OPTIONS)
  }

  const proxyReq = http.request(REQ_OPTIONS)

  proxy(req, resOrSocket, proxyReq, onRes, errorHandler)
}

function proxy (req, resOrSocket, proxyReq, onRes, errorHandler) {
  const proxyErrorHandler = ProxyErrorHandler.create(req, proxyReq, errorHandler)

  req
    .pipe(proxyReq)
    .on('error', proxyErrorHandler)
    // NOTE http.ClientRequest emits "socket hang up" error when aborted
    // before having received a response, i.e. there is no need to listen for
    // proxyReq.on('aborted', ...).
    .on('timeout', proxyErrorHandler.gatewayTimeout)
    .on('response', ProxyResponseHandler.create(req, resOrSocket, onRes, proxyErrorHandler))

  if (resOrSocket instanceof net.Socket) {
    proxyReq.on('upgrade', ProxyUpgradeHandler.create(req, resOrSocket, proxyErrorHandler))
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

class ErrorHandler {
  constructor () {
    this.hasError = false
    this.req = null
    this.resOrSocket = null
    this.callback = null

    this._release = this._release.bind(this)
    this._handle = this._handle.bind(this)
    this._handle.requestTimeout = this._requestTimeout.bind(this)
  }

  _requestTimeout () {
    this._handle(createError('request timeout', null, 408))
  }

  _handle (err, statusCode = err.statusCode || 500) {
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

  _release () {
    this.hasError = false
    this.req = null
    this.resOrSocket = null
    this.callback = null

    ErrorHandler.pool.push(this)
  }

  static create (req, resOrSocket, callback) {
    const handler = ErrorHandler.pool.pop() || new ErrorHandler()
    handler.hasError = false
    handler.req = req
    handler.resOrSocket = resOrSocket
    handler.callback = callback
    handler.req.on('close', handler._release)
    return handler._handle
  }
}
ErrorHandler.pool = []

class ProxyErrorHandler {
  constructor () {
    this.hasError = false
    this.req = null
    this.proxyReq = null
    this.errorHandler = null
    this.hpeExpr = /HPE_INVALID/

    this._release = this._release.bind(this)
    this._handle = this._handle.bind(this)
    this._handle.gatewayTimeout = this._gatewayTimeout.bind(this)
    this._handle.socketHangup = this._socketHangup.bind(this)
  }

  _handle (err) {
    if (this.hasError) {
      return
    }

    this.hasError = true

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (this.hpeExpr.test(err.code)) {
      err.statusCode = 502
    } else if (err.code === 'ECONNRESET') {
      if (!this.proxyReq.aborted) {
        err.statusCode = 502
      } else {
        return
      }
    }

    this._abort()
    this.errorHandler(err)
  }

  _gatewayTimeout () {
    this._handle(createError('gateway timeout', null, 504))
  }

  _socketHangup () {
    this._handle(createError('socket hang up', 'ECONNRESET', 502))
  }

  _abort () {
    if (!this.proxyReq.aborted) {
      this.proxyReq.abort()
    }
  }

  _release () {
    this._abort()

    this.hasError = false
    this.req = null
    this.proxyReq = null
    this.errorHandler = null

    ProxyErrorHandler.pool.push(this)
  }

  static create (req, proxyReq, errorHandler) {
    const handler = ProxyErrorHandler.pool.pop() || new ProxyErrorHandler()
    handler.req = req
    handler.proxyReq = proxyReq
    handler.errorHandler = errorHandler
    handler.req.on('close', handler._release)
    return handler._handle
  }
}
ProxyErrorHandler.pool = []

class ProxyResponseHandler {
  constructor () {
    this.req = null
    this.resOrSocket = null
    this.onRes = null
    this.proxyErrorHandler = null
    this.proxyRes = null

    this._handle = this._handle.bind(this)
    this._addTrailers = this._addTrailers.bind(this)
    this._release = this._release.bind(this)
  }

  _addTrailers () {
    this.resOrSocket.addTrailers(this.proxyRes.trailers)
  }

  _handle (proxyRes) {
    this.proxyRes = proxyRes

    proxyRes.on('aborted', this.proxyErrorHandler.socketHangup)

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
      proxyRes.on('end', this._addTrailers)
      proxyRes
        .on('error', this.proxyErrorHandler)
        .pipe(this.resOrSocket)
    }
  }

  _release () {
    if (this.proxyRes) {
      this.proxyRes.destroy()
    }

    this.req = null
    this.resOrSocket = null
    this.onRes = null
    this.proxyErrorHandler = null
    this.proxyRes = null

    ProxyResponseHandler.pool.push(this)
  }

  static create (req, resOrSocket, onRes, proxyErrorHandler) {
    const handler = ProxyResponseHandler.pool.pop() || new ProxyResponseHandler()
    handler.req = req
    handler.resOrSocket = resOrSocket
    handler.onRes = onRes
    handler.proxyErrorHandler = proxyErrorHandler
    handler.proxyRes = null
    handler.req.on('close', handler._release)
    return handler._handle
  }
}
ProxyResponseHandler.pool = []

class ProxyUpgradeHandler {
  constructor () {
    this.req = null
    this.resOrSocket = null
    this.proxyErrorHandler = null
    this.proxyRes = null
    this.proxySocket = null

    this._release = this._release.bind(this)
    this._handle = this._handle.bind(this)
  }

  _handle (proxyRes, proxySocket, proxyHead) {
    this.proxyRes = proxyRes
    this.proxySocket = proxySocket

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

    proxyRes.on('error', this.proxyErrorHandler)

    proxySocket
      .on('error', this.proxyErrorHandler)
      .pipe(this.resOrSocket)
      .pipe(proxySocket)
  }

  _release () {
    if (this.proxyRes) {
      this.proxyRes.destroy()
    }
    if (this.proxySocket) {
      this.proxySocket.destroy()
    }

    this.req = null
    this.resOrSocket = null
    this.proxyErrorHandler = null
    this.proxyRes = null
    this.proxySocket = null

    ProxyUpgradeHandler.pool.push(this)
  }

  static create (req, resOrSocket, proxyErrorHandler) {
    const handler = ProxyUpgradeHandler.pool.pop() || new ProxyUpgradeHandler()
    handler.req = req
    handler.resOrSocket = resOrSocket
    handler.proxyErrorHandler = proxyErrorHandler
    handler.req.on('close', handler._release)
    return handler._handle
  }
}
ProxyUpgradeHandler.pool = []
