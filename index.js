const http2 = require('http2')
const http = require('http')
const assert = require('assert')

const {
  HTTP2_HEADER_CONNECTION,
  HTTP2_HEADER_UPGRADE,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_METHOD,
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
  HTTP2_HEADER_FORWARDED = 'forwarded',
  HTTP2_HEADER_TRAILER = 'trailer'
} = http2.constants

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
  res[kProxySocket] = null

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
        onError.call(res, createError('loop detected', null, 508))
        return promise
      }
    }
  }

  const headers = getRequestHeaders(reqHeaders, req.socket)

  if (head !== undefined) {
    if (reqMethod !== 'GET') {
      onError.call(res, createError('method not allowed', null, 405))
      return promise
    }

    if (sanitize(reqHeaders[HTTP2_HEADER_UPGRADE]) !== 'websocket') {
      onError.call(res, createError('bad request', null, 400))
      return promise
    }

    if (head && head.length) {
      res.unshift(head)
    }

    setupSocket(res)

    headers[HTTP2_HEADER_CONNECTION] = 'upgrade'
    headers[HTTP2_HEADER_UPGRADE] = 'websocket'
  }

  if (proxyName) {
    if (headers[HTTP2_HEADER_VIA]) {
      headers[HTTP2_HEADER_VIA] += `,${proxyName}`
    } else {
      headers[HTTP2_HEADER_VIA] = proxyName
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
    // .on('aborted', onFinish)
    .on('close', onFinish)
    .on('error', onError)
    .on('timeout', onRequestTimeout)
    .pipe(proxyReq)
    .on('error', onError)
    // .on('aborted', onProxyAborted)
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

  assert(res)

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

    if (res.closed === true || res.headersSent !== false) {
      res.destroy()
    } else {
      if (res.respond) {
        res.respond({ [HTTP2_HEADER_STATUS]: err.statusCode })
      } else {
        res.writeHead(err.statusCode)
      }
      res.end()
    }
  }

  if (res[kProxyReq].res) {
    res[kProxyReq].res.destroy()
    res[kProxyReq].res = null
  }

  if (res[kProxySocket]) {
    res[kProxySocket].end()
    res[kProxySocket] = null
  }

  res[kProxyReq].abort()
  res[kProxyReq] = null

  callback.call(res[kSelf], err, res[kReq], res)
}

function onRequestTimeout () {
  onError.call(this, createError('request timeout', null, 408))
}

function onProxyTimeout () {
  onError.call(this, createError('gateway timeout', null, 504))
}

function onProxyResponse (proxyRes) {
  if (this.aborted) {
    return
  }

  const res = this[kRes]

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
      headers[HTTP2_HEADER_STATUS] = status

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
  if (this.aborted) {
    return
  }

  const res = this[kRes]

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
  const host = reqHeaders[HTTP2_HEADER_AUTHORITY] || reqHeaders[HTTP2_HEADER_HOST]
  const forwarded = reqHeaders[HTTP2_HEADER_FORWARDED]

  const headers = {}
  for (const [ key, value ] of Object.entries(reqHeaders)) {
    if (key.charAt(0) !== ':') {
      headers[key] = value
    }
  }

  setupHeaders(headers)

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
      headers[HTTP2_HEADER_FORWARDED] += `; for=${m[1]}`
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
  delete headers[HTTP2_HEADER_TRAILER]
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
