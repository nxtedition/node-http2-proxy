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

module.exports = {
  ws (req, socket, head, options, callback) {
    return proxy(req, socket, head || null, options, callback)
  },
  web (req, res, options, callback) {
    return proxy(req, res, undefined, options, callback)
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
  req[kRes] = res

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

  if (proxyName && req.headers[VIA]) {
    for (const name of req.headers[VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        process.nextTick(onError.call, res, createError('loop detected', null, 508))
        return promise
      }
    }
  }

  const headers = getRequestHeaders(req.headers, req.socket)

  if (head !== undefined) {
    if (req.method !== 'GET') {
      process.nextTick(onError.call, res, createError('method not allowed', null, 405))
      return promise
    }

    if (sanitize(req.headers[UPGRADE]) !== 'websocket') {
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
      headers[VIA] += `,${req.httpVersion} ${proxyName}`
    } else {
      headers[VIA] = `${req.httpVersion} ${proxyName}`
    }
  }

  if (timeout != null) {
    req.setTimeout(timeout)
  }

  const options = {
    method: req.method,
    hostname,
    port,
    path: req.url,
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
    err.statusCode = err.statusCode || 500
    err.code = err.code || res.code

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    }

    if (
      res.headersSent !== false ||
      res.writable === false ||
      // NOTE: Checking only writable is not enough. See, https://github.com/nodejs/node/commit/8589c70c85411c2dd0e02c021d926b1954c74696
      res.finished === true
    ) {
      if (res.stream) {
        res.stream.rstWithCancel()
      }
      res.destroy()
    } else {
      res.writeHead(err.statusCode)
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

  if (!res.writeHead) {
    if (!proxyRes.upgrade) {
      res.end()
    }
  } else {
    setupHeaders(proxyRes.headers)

    res.statusCode = proxyRes.statusCode
    for (const [ key, value ] of Object.entries(proxyRes.headers)) {
      res.setHeader(key, value)
    }

    if (this[kOnProxyRes]) {
      this[kOnProxyRes].call(res[kSelf], this[kReq], res)
    }

    if (res.headersSent === false) {
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
    this.aborted === true ||
    res.writable === false ||
    // NOTE: Checking only writable is not enough. See, https://github.com/nodejs/node/commit/8589c70c85411c2dd0e02c021d926b1954c74696
    res.finished === true
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

  if (connection && connection !== CONNECTION && connection !== KEEP_ALIVE) {
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
