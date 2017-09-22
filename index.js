const http = require('http')

const CONNECTION = 'connection'
const FORWARDED = 'forwarded'
const HOST = 'host'
const KEEP_ALIVE = 'keep-alive'
const PROXY_AUTHORIZATION = 'proxy-authorization'
const PROXY_CONNECTION = 'proxy-connection'
const TE = 'te'
const TRAILER = 'trailer'
const TRANSFER_ENCODING = 'transfer-encoding'
const UPGRADE = 'upgrade'
const VIA = 'via'
const AUTHORITY = ':authority'
const HTTP2_SETTINGS = 'http2-settings'
const METHOD = ':method'
const PATH = ':path'
const STATUS = ':status'

module.exports = {
  ws (req, socket, head, options, callback) {
    proxy(req, socket, head || null, options, callback)
  },
  web (reqOrStream, resOrHeaders, options, callback) {
    proxy(reqOrStream, resOrHeaders, undefined, options, callback)
  }
}

const kReq = Symbol('req')
const kRes = Symbol('res')
const kSelf = Symbol('self')
const kProxyCallback = Symbol('callback')
const kProxyReq = Symbol('proxyReq')
const kProxySocket = Symbol('proxySocket')
const kOnProxyRes = Symbol('onProxyRes')

function proxy (req, res, head, {
  hostname,
  port,
  timeout,
  proxyTimeout,
  proxyName,
  onReq,
  onRes
}, callback) {
  let reqHeaders = req.headers
  let reqMethod = req.method
  let reqUrl = req.url

  if (!reqHeaders) {
    reqHeaders = res
    reqMethod = reqHeaders[METHOD]
    reqUrl = reqHeaders[PATH]

    res = req
  } else {
    req[kRes] = res
  }

  res[kSelf] = this
  res[kReq] = req
  res[kRes] = res
  res[kProxyCallback] = callback
  res[kProxyReq] = null
  res[kProxySocket] = null

  let promise

  if (!callback) {
    promise = new Promise((resolve, reject) => {
      res[kProxyCallback] = err => err ? reject(err) : resolve()
    })
  }

  if (proxyName && reqHeaders[VIA]) {
    for (const name of reqHeaders[VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        process.nextTick(onError.call, res, createError('loop detected', null, 508))
        return promise
      }
    }
  }

  const socket = req.session ? req.session.socket : req.socket
  const headers = getRequestHeaders(reqHeaders, socket)

  if (head !== undefined) {
    if (reqMethod !== 'GET') {
      process.nextTick(onError.call, res, createError('method not allowed', null, 405))
      return promise
    }

    if (sanitize(reqHeaders[UPGRADE]) !== 'websocket') {
      process.nextTick(onError.call, res, createError('bad request', null, 400))
      return promise
    }

    if (head && head.length) {
      res.unshift(head)
    }

    setupSocket(res)

    headers[CONNECTION] = 'upgrade'
    headers[UPGRADE] = 'websocket'
  }

  if (proxyName) {
    if (headers[VIA]) {
      headers[VIA] += `,${proxyName}`
    } else {
      headers[VIA] = proxyName
    }
  }

  if (timeout != null) {
    req.setTimeout(timeout)
  }

  const options = {
    method: reqMethod,
    hostname,
    port,
    path: reqUrl,
    headers,
    timeout: proxyTimeout
  }

  let proxyReq

  if (onReq) {
    proxyReq = onReq.call(res[kSelf], req, options)
  }

  if (!proxyReq) {
    proxyReq = http.request(options)
  }

  proxyReq[kReq] = req
  proxyReq[kRes] = res
  res[kProxyReq] = proxyReq
  proxyReq[kOnProxyRes] = onRes

  res
    .on('close', onFinish)
    .on('error', onError)

  req
    // XXX https://github.com/nodejs/node/issues/15303#issuecomment-330233428
    .on('streamClosed', onFinish)
    .on('close', onFinish)
    .on('error', onError)
    .on('timeout', onRequestTimeout)
    .pipe(proxyReq)
    .on('error', onError)
    .on('timeout', onProxyTimeout)
    .on('response', onProxyResponse)
    .on('upgrade', onProxyUpgrade)

  return promise
}

function onFinish () {
  onError.call(this)
}

function onError (err) {
  const res = this[kRes]

  if (!res[kProxyCallback]) {
    return
  }

  const callback = res[kProxyCallback]
  res[kProxyCallback] = null

  if (err) {
    err.statusCode = err.statusCode || err.status || 500
    err.code = err.code || res.code

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    }

    if (
      res.headersSent !== false ||
      res.finished === true ||
      res.writable === false
    ) {
      res.destroy()
    } else {
      if (res.respond) {
        res.respond({ [STATUS]: err.statusCode })
      } else {
        res.writeHead(err.statusCode)
      }
      res.end()
    }
  }

  if (res[kProxyReq]) {
    if (res[kProxyReq].res) {
      res[kProxyReq].res.destroy()
    }

    if (res[kProxySocket]) {
      res[kProxySocket].end()
      res[kProxySocket] = null
    }

    res[kProxyReq].abort()
    res[kProxyReq] = null
  }

  callback.call(res[kSelf], err, res[kReq], res)
}

function onRequestTimeout () {
  onError.call(this, createError('request timeout', null, 408))
}

function onProxyTimeout () {
  onError.call(this, createError('gateway timeout', null, 504))
}

function onProxyResponse (proxyRes) {
  const res = this[kRes]

  if (
    res[kProxyCallback] === null ||
    res.writable === false ||
    res.finished === true ||
    this.aborted === true
  ) {
    return
  }

  proxyRes[kRes] = res

  proxyRes.on('aborted', onProxyAborted)

  if (!res.writeHead && !res.respond) {
    if (!proxyRes.upgrade) {
      res.end()
    }
  } else {
    const headers = proxyRes.headers
    const status = proxyRes.statusCode || proxyRes.status

    setupHeaders(headers)

    if (res.respond) {
      headers[STATUS] = status

      if (this[kOnProxyRes]) {
        this[kOnProxyRes].call(res[kSelf], this[kReq], headers)
      }

      res.respond(headers)
    } else {
      res.statusCode = status
      for (const key of Object.keys(headers)) {
        res.setHeader(key, headers[key])
      }

      if (this[kOnProxyRes]) {
        this[kOnProxyRes].call(res[kSelf], this[kReq], res)
      }

      res.writeHead(res.statusCode)
    }

    proxyRes
      .on('error', onError)
      .pipe(res)
      .on('finish', onFinish)
  }
}

function onProxyAborted () {
  onError.call(this, createError('socket hang up', 'ECONNRESET', 502))
}

function onProxyUpgrade (proxyRes, proxySocket, proxyHead) {
  const res = this[kRes]

  if (
    res[kProxyCallback] === null ||
    res.writable === false ||
    res.finished === true ||
    this.aborted === true
  ) {
    return
  }

  res[kProxySocket] = proxySocket
  proxySocket[kRes] = res

  setupSocket(proxySocket)

  if (proxyHead && proxyHead.length) {
    proxySocket.unshift(proxyHead)
  }

  let head = 'HTTP/1.1 101 Switching Protocols'

  for (const [ key, value ] of Object.entries(proxyRes.headers)) {
    if (!Array.isArray(value)) {
      head += '\r\n' + key + ': ' + value
    } else {
      for (let i = 0; i < value.length; i++) {
        head += '\r\n' + key + ': ' + value[i]
      }
    }
  }

  head += '\r\n\r\n'

  res.write(head)

  proxySocket
    .on('error', onError)
    .pipe(res)
    .pipe(proxySocket)
}

function getRequestHeaders (reqHeaders, reqSocket) {
  const host = reqHeaders[AUTHORITY] || reqHeaders[HOST]
  const forwarded = reqHeaders[FORWARDED]

  const headers = {}
  for (const [ key, value ] of Object.entries(reqHeaders)) {
    if (key.charAt(0) !== ':') {
      headers[key] = value
    }
  }

  setupHeaders(headers)

  if (reqSocket) {
    headers[FORWARDED] = `by=${reqSocket.localAddress}`
    headers[FORWARDED] += `; for=${reqSocket.remoteAddress}`
  }

  if (forwarded) {
    const expr = /for=\s*([^\s]+)/ig
    while (true) {
      const m = expr.exec(forwarded)
      if (!m) {
        break
      }
      headers[FORWARDED] += `; for=${m[1]}`
    }
  }

  if (host) {
    headers[FORWARDED] += `; host=${host}`
  }

  if (reqSocket) {
    headers[FORWARDED] += `; proto=${reqSocket.encrypted ? 'https' : 'http'}`
  }

  return headers
}

function setupSocket (socket) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 0)
}

function setupHeaders (headers) {
  const connection = sanitize(headers[CONNECTION])

  if (connection && connection !== 'close' && connection !== 'keep-alive') {
    for (const name of connection.split(',')) {
      delete headers[name.trim()]
    }
  }

  // Remove hop by hop headers
  delete headers[CONNECTION]
  delete headers[KEEP_ALIVE]
  delete headers[TRANSFER_ENCODING]
  delete headers[TE]
  delete headers[UPGRADE]
  delete headers[PROXY_AUTHORIZATION]
  delete headers[PROXY_CONNECTION]
  delete headers[TRAILER]
  delete headers[HTTP2_SETTINGS]

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
