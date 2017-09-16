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
  HTTP2_HEADER_STATUS,
  // XXX https://github.com/nodejs/node/issues/15337
  HTTP2_HEADER_FORWARDED = 'forwarded'
} = http2.constants

module.exports = {
  ws (req, socket, head, options, callback) {
    proxy(req, socket, head, options, callback)
  },
  web (reqOrStream, resOrHeaders, options, callback) {
    proxy(reqOrStream, resOrHeaders, null, options, callback)
  }
}

const kReq = Symbol('req')
const kRes = Symbol('res')
const kSelf = Symbol('self')
const kProxyCallback = Symbol('callback')
const kProxyReq = Symbol('proxyReq')
const kProxyRes = Symbol('proxyRes')
const kProxySocket = Symbol('proxySocket')
const kOnProxyRes = Symbol('onProxyRes')
const kFinished = Symbol('finished')

const RESPOND_OPTIONS = {
  getTrailers: function () {
    return this[kProxyRes].trailers
  }
}

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
    reqMethod = reqHeaders[HTTP2_HEADER_METHOD]
    reqUrl = reqHeaders[HTTP2_HEADER_PATH]

    res = req
  } else {
    req[kRes] = res
  }

  res[kSelf] = this
  res[kReq] = req
  res[kRes] = res
  res[kProxyCallback] = callback
  res[kProxyReq] = null
  res[kProxyRes] = null
  res[kProxySocket] = null
  res[kFinished] = false

  assert(typeof callback === 'function' || callback == null)

  let promise

  if (!callback) {
    promise = new Promise((resolve, reject) => {
      res[kProxyCallback] = err => err ? reject(err) : resolve()
    })
  }

  if (proxyName && reqHeaders[HTTP2_HEADER_VIA]) {
    for (const name of reqHeaders[HTTP2_HEADER_VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        return onFinish.call(res, createError('loop detected', null, 508))
      }
    }
  }

  if (res instanceof net.Socket) {
    if (reqMethod !== 'GET') {
      return onFinish.call(res, createError('method not allowed', null, 405))
    }

    if (sanitize(reqHeaders[HTTP2_HEADER_UPGRADE]) !== 'websocket') {
      return onFinish.call(res, createError('bad request', null, 400))
    }

    if (head && head.length) {
      res.unshift(head)
    }

    setupSocket(res)
  }

  if (timeout != null) {
    req.setTimeout(timeout, onRequestTimeout)
  }

  const headers = getRequestHeaders(reqHeaders, req.socket)

  if (proxyName) {
    if (headers[HTTP2_HEADER_VIA]) {
      headers[HTTP2_HEADER_VIA] += `,${proxyName}`
    } else {
      headers[HTTP2_HEADER_VIA] = proxyName
    }
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
  proxyReq[kOnProxyRes] = onRes

  res[kProxyReq] = proxyReq

  if (res.respond) {
    req
      .on('streamClosed', onFinish)
      .on('finish', onFinish)
  } else {
    req
      .on('close', onFinish)
    res
      .on('finish', onFinish)
      .on('close', onFinish)
      .on('error', onFinish)
  }

  req
    .on('aborted', onFinish)
    .on('error', onFinish)
    .pipe(proxyReq)
    .on('error', onFinish)
    .on('aborted', onProxyAborted)
    .on('timeout', onProxyTimeout)
    .on('response', onProxyResponse)
    .on('upgrade', onProxyUpgrade)

  return promise
}

function onFinish (err, statusCode = 500) {
  const res = this[kRes]

  assert(res)

  if (res[kFinished]) {
    return
  }

  res[kFinished] = true

  if (err) {
    err.statusCode = statusCode || err.statusCode || 500
    err.code = err.code || res.code

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    }

    statusCode = err.statusCode
  }

  if (res.headersSent !== false) {
    res.destroy()
  } else {
    if (res.respond) {
      res.respond({ [HTTP2_HEADER_STATUS]: statusCode })
    } else {
      res.writeHead(statusCode)
    }
    res.end()
  }

  if (res[kProxyCallback]) {
    res[kProxyCallback].call(res[kSelf], err, res[kReq], res)
    res[kProxyCallback] = null
  }

  if (res[kProxyReq]) {
    res[kProxyReq].abort()
    res[kProxyReq] = null
  }

  if (res[kProxySocket]) {
    res[kProxySocket].end()
    res[kProxySocket] = null
  }

  if (res[kProxyRes]) {
    res[kProxyRes].destroy()
    res[kProxyRes] = null
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

  const res = this[kRes]

  res[kProxyRes] = proxyRes

  proxyRes[kRes] = res

  proxyRes.on('aborted', onProxyAborted)

  if (res instanceof net.Socket) {
    if (!proxyRes.upgrade) {
      res.end()
    }
  } else {
    setupHeaders(proxyRes.headers)

    if (res.respond) {
      proxyRes.headers[HTTP2_HEADER_STATUS] = proxyRes.statusCode || proxyRes.status

      if (this[kOnProxyRes]) {
        this[kOnProxyRes].call(res[kSelf], this[kReq], proxyRes.headers)
      }

      res.respond(proxyRes.headers, RESPOND_OPTIONS)
    } else {
      res.statusCode = proxyRes.statusCode || proxyRes.status
      for (const key of Object.keys(proxyRes.headers)) {
        res.setHeader(key, proxyRes.headers[key])
      }

      if (this[kOnProxyRes]) {
        this[kOnProxyRes].call(res[kSelf], this[kReq], res)
      }

      res.writeHead(res.statusCode)

      proxyRes
        .on('end', onProxyTrailers)
    }

    proxyRes
      .on('error', onFinish)
      .pipe(res)
  }
}

function onProxyTrailers () {
  this[kRes].addTrailers(this.trailers)
}

function onProxyAborted () {
  onFinish.call(this, createError('socket hang up', 'ECONNRESET', 502))
}

function onProxyUpgrade (proxyRes, proxySocket, proxyHead) {
  if (this.aborted) {
    return
  }

  const res = this[kRes]

  res[kProxySocket] = proxySocket
  res[kProxyRes] = proxyRes

  proxyRes[kRes] = res
  proxySocket[kRes] = res

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

  res.write(head)

  proxyRes
    .on('error', onFinish)

  proxySocket
    .on('error', onFinish)
    .pipe(res)
    .pipe(proxySocket)
}

function getRequestHeaders (reqHeaders, reqSocket) {
  const host = reqHeaders[HTTP2_HEADER_AUTHORITY] || reqHeaders[HTTP2_HEADER_HOST]
  const upgrade = reqHeaders[HTTP2_HEADER_UPGRADE]
  const forwarded = reqHeaders[HTTP2_HEADER_FORWARDED]

  const headers = setupHeaders(Object.assign({}, reqHeaders))

  // Remove pseudo headers
  delete headers[HTTP2_HEADER_AUTHORITY]
  delete headers[HTTP2_HEADER_METHOD]
  delete headers[HTTP2_HEADER_PATH]
  delete headers[HTTP2_HEADER_SCHEME]

  if (upgrade) {
    headers[HTTP2_HEADER_CONNECTION] = 'upgrade'
    headers[HTTP2_HEADER_UPGRADE] = 'websocket'
  }

  if (reqSocket) {
    headers[HTTP2_HEADER_FORWARDED] = `by=${reqSocket.localAddress}`
    headers[HTTP2_HEADER_FORWARDED] += `; for=${reqSocket.remoteAddress}`
  }

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

  if (reqSocket) {
    headers[HTTP2_HEADER_FORWARDED] += `; proto=${reqSocket.encrypted ? 'https' : 'http'}`
  }

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
      delete headers[name.trim()]
    }
  }

  // Remove hop by hop headers
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
