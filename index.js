const http = require('http')
const https = require('https')
const url = require('url')

const CONNECTION = 'connection'
const HOST = 'host'
const KEEP_ALIVE = 'keep-alive'
const PROXY_AUTHORIZATION = 'proxy-authorization'
const PROXY_CONNECTION = 'proxy-connection'
const TE = 'te'
const FORWARDED = 'forwarded'
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

function noop () {}

const kReq = Symbol('req')
const kRes = Symbol('res')
const kSelf = Symbol('self')
const kProxyCallback = Symbol('callback')
const kProxyReq = Symbol('proxyReq')
const kProxyRes = Symbol('proxyRes')
const kProxySocket = Symbol('proxySocket')
const kOnProxyRes = Symbol('onProxyRes')
const kHead = Symbol('head')

function proxy (req, res, head, options, callback) {
  if (typeof options === 'string') {
    options = new url.URL(options)
  }

  const {
    hostname,
    port,
    protocol,
    path = req.originalUrl || req.url,
    timeout,
    proxyTimeout,
    proxyName,
    onReq,
    onRes
  } = options

  req[kRes] = res

  res[kSelf] = this
  res[kReq] = req
  res[kRes] = res
  res[kProxyCallback] = callback
  res[kProxyReq] = null
  res[kProxySocket] = null
  res[kHead] = head

  let promise

  if (!callback) {
    promise = new Promise((resolve, reject) => {
      callback = (err, ...args) => err ? reject(err) : resolve(args)
    })
  }

  if (proxyName && req.headers[VIA]) {
    for (const name of req.headers[VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        process.nextTick(onComplete.bind(res), new HttpError('loop detected', null, 508))
        return promise
      }
    }
  }

  const headers = getRequestHeaders(req)

  if (head !== undefined) {
    if (req.method !== 'GET') {
      process.nextTick(onComplete.bind(res), new HttpError('method not allowed', null, 405))
      return promise
    }

    if (sanitize(req.headers[UPGRADE]) !== 'websocket') {
      process.nextTick(onComplete.bind(res), new HttpError('bad request', null, 400))
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

  const reqOptions = {
    method: req.method,
    hostname,
    port,
    path,
    headers,
    timeout: proxyTimeout
  }

  let proxyReq

  if (onReq) {
    proxyReq = onReq.call(res[kSelf], req, reqOptions)
  }

  if (!proxyReq) {
    let agent
    if (protocol == null || /(http|ws):?/.test(protocol)) {
      agent = http
    } else if (/(http|ws)s:?/.test(protocol)) {
      agent = https
    } else {
      process.nextTick(onComplete.bind(res), new HttpError(`invalid protocol`, null, 500))
      return promise
    }
    proxyReq = agent.request(reqOptions)
  }

  proxyReq[kReq] = req
  proxyReq[kRes] = res
  res[kProxyReq] = proxyReq
  proxyReq[kOnProxyRes] = onRes

  res
    .on('close', onComplete)

  req
    .on('close', onComplete)
    .on('aborted', onComplete)
    .on('timeout', onRequestTimeout)
    .pipe(proxyReq)
    .on('error', onComplete)
    .on('timeout', onProxyTimeout)
    .on('response', onProxyResponse)
    .on('upgrade', onProxyUpgrade)

  return promise
}

function onComplete (err) {
  const res = this[kRes]
  const req = res[kReq]

  res
    .removeListener('close', onComplete)

  req
    .removeListener('close', onComplete)
    .removeListener('aborted', onComplete)
    .removeListener('timeout', onRequestTimeout)

  if (res[kProxySocket]) {
    res[kProxySocket]
      .removeListener('error', onComplete)
      .removeListener('close', onProxyAborted)
    res[kProxySocket].on('error', noop)
    res[kProxySocket].destroy()
    res[kProxySocket] = null
  }

  if (res[kProxyRes]) {
    res[kProxyRes]
      .removeListener('error', onComplete)
      .removeListener('end', onComplete)
      .removeListener('aborted', onProxyAborted)
    res[kProxyRes].on('error', noop)
    res[kProxyRes].destroy()
    res[kProxyRes] = null
  }

  if (res[kProxyReq]) {
    res[kProxyReq]
      .removeListener('error', onComplete)
      .removeListener('timeout', onProxyTimeout)
      .removeListener('response', onProxyResponse)
      .removeListener('upgrade', onProxyUpgrade)
    res[kProxyReq].on('error', noop)
    res[kProxyReq].abort()
    res[kProxyReq] = null
  }

  if (err) {
    err.statusCode = err.statusCode || 500
    err.code = err.code || res.code

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    }
  }

  res[kProxyCallback].call(res[kSelf], err, req, res, res[kHead])
}

function onRequestTimeout () {
  onComplete.call(this, new HttpError('request timeout', null, 408))
}

function onProxyTimeout () {
  onComplete.call(this, new HttpError('gateway timeout', null, 504))
}

function onProxyAborted () {
  onComplete.call(this, new HttpError('socket hang up', 'ECONNRESET', 502))
}

function onProxyResponse (proxyRes) {
  const res = this[kRes]
  const req = res[kReq]

  res[kProxyRes] = proxyRes
  proxyRes[kRes] = res

  proxyRes
    .on('aborted', onProxyAborted)
    .on('error', onComplete)

  const headers = setupHeaders(proxyRes.headers)

  if (headers['location'] && /^201|30(1|2|7|8)$/.test(proxyRes.statusCode)) {
    const u = url.parse(headers['location'])
    u.host = req.headers[AUTHORITY] || req.headers[HOST] || ''
    headers['location'] = u.format()
  }

  if (this[kOnProxyRes]) {
    try {
      this[kOnProxyRes].call(res[kSelf], this[kReq], res, proxyRes, onComplete)
    } catch (err) {
      onComplete.call(this, err)
    }
    return
  }

  if (!res.writeHead) {
    if (!proxyRes.upgrade) {
      res.write(createHttpHeader(`HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`, proxyRes.headers))
      proxyRes.pipe(res)
    }
  } else {
    res.statusCode = proxyRes.statusCode
    res.statusMessage = proxyRes.statusMessage
    for (const [ key, value ] of Object.entries(headers)) {
      res.setHeader(key, value)
    }
    proxyRes.pipe(res)
  }
}

function onProxyUpgrade (proxyRes, proxySocket, proxyHead) {
  const res = this[kRes]

  res[kProxySocket] = proxySocket
  proxySocket[kRes] = res

  setupSocket(proxySocket)

  if (proxyHead && proxyHead.length) {
    proxySocket.unshift(proxyHead)
  }

  res.write(createHttpHeader('HTTP/1.1 101 Switching Protocols', proxyRes.headers))

  proxySocket
    .on('error', onComplete)
    .on('close', onProxyAborted)
    .pipe(res)
    .pipe(proxySocket)
}

function createHttpHeader (line, headers) {
  let head = line
  for (const [ key, value ] of Object.entries(headers)) {
    if (!Array.isArray(value)) {
      head += `\r\n${key}: ${value}`
    } else {
      for (let i = 0; i < value.length; i++) {
        head += `\r\n${key}: ${value[i]}`
      }
    }
  }
  head += '\r\n\r\n'
  return head
}

function getRequestHeaders (req) {
  const headers = {}
  for (const [ key, value ] of Object.entries(req.headers)) {
    if (key.charAt(0) !== ':') {
      headers[key] = value
    }
  }

  const forwarded = [
    `by="${req.socket.localAddress}"`,
    `for="${req.socket.remoteAddress}"`,
    `proto=${req.socket.encrypted ? 'https' : 'http'}`,
    `host=${req.headers[AUTHORITY] || req.headers[HOST] || ''}`
  ].join('; ')

  if (req.headers[FORWARDED]) {
    req.headers[FORWARDED] += `, ${forwarded}`
  } else {
    req.headers[FORWARDED] = `${forwarded}`
  }

  return setupHeaders(headers)
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

class HttpError extends Error {
  constructor (msg, code, statusCode) {
    super(msg)
    this.code = code
    this.statusCode = statusCode || 500
  }
}
