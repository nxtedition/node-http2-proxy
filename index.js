const net = require('net')
const http = require('http')
const https = require('https')

const CONNECTION = 'connection'
const HOST = 'host'
const KEEP_ALIVE = 'keep-alive'
const PROXY_AUTHORIZATION = 'proxy-authorization'
const PROXY_AUTHENTICATE = 'proxy-authenticate'
const PROXY_CONNECTION = 'proxy-connection'
const TE = 'te'
const FORWARDED = 'forwarded'
const TRAILER = 'trailer'
const TRANSFER_ENCODING = 'transfer-encoding'
const UPGRADE = 'upgrade'
const VIA = 'via'
const AUTHORITY = ':authority'
const HTTP2_SETTINGS = 'http2-settings'

const kReq = Symbol('req')
const kRes = Symbol('res')
const kProxyCallback = Symbol('callback')
const kProxyReq = Symbol('proxyReq')
const kProxyRes = Symbol('proxyRes')
const kProxySocket = Symbol('proxySocket')
const kConnected = Symbol('connected')
const kOnRes = Symbol('onRes')

module.exports = proxy

proxy.ws = function ws (req, socket, head, options, callback) {
  const promise = compat({ req, socket, head }, options)
  if (!callback) {
    return promise
  }
  // Legacy compat...
  promise
    .then(() => callback(null, req, socket, head))
    .catch(err => callback(err, req, socket, head))
}
proxy.web = function web (req, res, options, callback) {
  const promise = compat({ req, res }, options)
  if (!callback) {
    return promise
  }
  // Legacy compat...
  promise
    .then(() => callback(null, req, res))
    .catch(err => callback(err, req, res))
}

async function compat (ctx, options) {
  const { req, res } = ctx

  const {
    hostname,
    port,
    protocol,
    timeout,
    proxyTimeout,
    proxyName,
    onReq,
    onRes
  } = options

  // Legacy compat...
  if (timeout != null) {
    req.setTimeout(timeout)
  }

  await proxy(
    { ...ctx, proxyName },
    async ureq => {
      ureq.hostname = hostname
      ureq.port = port
      ureq.timeout = proxyTimeout

      if (onReq) {
        if (onReq.length <= 2) {
          return onReq(req, options)
        } else {
          // Legacy compat...
          return new Promise((resolve, reject) => {
            const promiseOrReq = onReq(req, options, (err, val) => err ? reject(err) : resolve(val))
            if (promiseOrReq) {
              if (promiseOrReq.then) {
                promiseOrReq.then(resolve).catch(reject)
              } else if (promiseOrReq.abort) {
                resolve(promiseOrReq)
              } else {
                throw new Error('onReq must return a promise or a request object')
              }
            }
          })
        }
      } else {
        let agent
        if (protocol == null || /^(http|ws):?$/.test(protocol)) {
          agent = http
        } else if (/^(http|ws)s:?$/.test(protocol)) {
          agent = https
        } else {
          throw new HttpError(`invalid protocol`, null, 500)
        }
        return agent.request(options)
      }
    },
    async (proxyRes, headers) => {
      proxyRes.headers = headers
      if (onRes.length <= 3) {
        return onRes(req, res, proxyRes)
      } else {
        // Legacy compat...
        return new Promise((resolve, reject) => {
          const promise = onRes(req, res, proxyRes, (err, val) => err ? reject(err) : resolve(val))
          if (promise && promise.then) {
            promise.then(resolve).catch(reject)
          }
        })
      }
    }
  )
}

async function proxy ({ req, socket, res = socket, head, proxyName }, onReq, onRes) {
  if (req.aborted) {
    return
  }

  const headers = getRequestHeaders(req, proxyName)

  if (head !== undefined) {
    if (req.method !== 'GET') {
      throw new HttpError('only GET request allowed', null, 405)
    }

    if (req.headers[UPGRADE] !== 'websocket') {
      throw new HttpError('missing upgrade header', null, 400)
    }

    if (head && head.length) {
      res.unshift(head)
    }

    setupSocket(res)

    headers[CONNECTION] = 'upgrade'
    headers[UPGRADE] = 'websocket'
  }

  const proxyReq = await onReq({
    method: req.method,
    path: req.originalUrl || req.url,
    headers
  })

  if (req.aborted) {
    if (proxyReq.abort) {
      proxyReq.abort()
    } else if (proxyReq.destroy) {
      proxyReq.destroy()
    }
    return
  }

  let callback
  const promise = new Promise((resolve, reject) => {
    callback = err => err ? reject(err) : resolve()
  })

  req[kRes] = res

  res[kReq] = req
  res[kRes] = res
  res[kProxySocket] = null
  res[kProxyReq] = proxyReq
  res[kProxyRes] = null
  res[kProxyCallback] = callback

  proxyReq[kReq] = req
  proxyReq[kRes] = res
  proxyReq[kConnected] = false
  proxyReq[kOnRes] = onRes

  res
    .on('close', onComplete)
    .on('finish', onComplete)
    .on('error', onComplete)

  req
    .on('close', onComplete)
    .on('aborted', onComplete)
    .on('error', onComplete)

  proxyReq
    .on('error', onProxyReqError)
    .on('timeout', onProxyReqTimeout)
    .on('response', onProxyReqResponse)
    .on('upgrade', onProxyReqUpgrade)

  deferToConnect.call(proxyReq, onProxyConnect)

  return promise
}

function deferToConnect (cb) {
  this.once('socket', function (socket) {
    if (!socket.connecting) {
      cb.call(this)
    } else {
      socket.once('connect', cb.bind(this))
    }
  })
}

function onComplete (err) {
  const res = this[kRes]
  const req = res[kReq]

  if (!res[kProxyCallback]) {
    return
  }

  const proxySocket = res[kProxySocket]
  const proxyReq = res[kProxyReq]
  const proxyRes = res[kProxyRes]
  const callback = res[kProxyCallback]

  res[kProxySocket] = null
  res[kProxyReq] = null
  res[kProxyRes] = null
  res[kProxyCallback] = null

  res
    .off('close', onComplete)
    .off('finish', onComplete)
    .off('error', onComplete)

  req
    .off('close', onComplete)
    .off('aborted', onComplete)
    .off('error', onComplete)

  if (proxySocket) {
    proxySocket.destroy()
  }

  if (proxyRes) {
    proxyRes.destroy()
  }

  if (proxyReq) {
    if (proxyReq.abort) {
      proxyReq.abort()
    } else if (proxyReq.destroy) {
      proxyReq.destroy()
    }
  }

  callback(err)
}

function onProxyConnect () {
  this[kConnected] = true
  this[kReq].pipe(this)
}

function onProxyReqError (err) {
  err.statusCode = this[kConnected] ? 502 : 503
  onComplete.call(this, err)
}

function onProxyReqTimeout () {
  onComplete.call(this, new HttpError('proxy timeout', 'ETIMEDOUT', 504))
}

async function onProxyReqResponse (proxyRes) {
  const res = this[kRes]

  res[kProxyRes] = proxyRes
  proxyRes[kRes] = res

  const headers = setupHeaders(proxyRes.headers)

  proxyRes
    .on('aborted', onProxyResAborted)
    .on('error', onProxyResError)

  if (this[kOnRes]) {
    try {
      await this[kOnRes](proxyRes, headers)
    } catch (err) {
      onComplete.call(this, err)
    }
  } else if (!res.writeHead) {
    if (!proxyRes.upgrade) {
      res.write(createHttpHeader(`HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`, proxyRes.headers))
      proxyRes.pipe(res)
    }
  } else {
    res.statusCode = proxyRes.statusCode
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }
    proxyRes
      .on('end', onProxyResEnd)
      .pipe(res)
  }
}

function onProxyReqUpgrade (proxyRes, proxySocket, proxyHead) {
  const res = this[kRes]

  res[kProxySocket] = proxySocket
  proxySocket[kRes] = res

  setupSocket(proxySocket)

  if (proxyHead && proxyHead.length) {
    proxySocket.unshift(proxyHead)
  }

  res.write(createHttpHeader('HTTP/1.1 101 Switching Protocols', proxyRes.headers))

  proxySocket
    .on('error', onProxyResError)
    .on('close', onProxyResAborted)
    .pipe(res)
    .pipe(proxySocket)
}

function onProxyResError (err) {
  err.statusCode = 502
  onComplete.call(this, err)
}

function onProxyResAborted () {
  onComplete.call(this, new HttpError('proxy aborted', 'ECONNRESET', 502))
}

function onProxyResEnd () {
  const res = this[kRes]
  res.addTrailers(res.trailers)
}

function createHttpHeader (line, headers) {
  let head = line
  for (const [key, value] of Object.entries(headers)) {
    if (!Array.isArray(value)) {
      head += `\r\n${key}: ${value}`
    } else {
      for (let i = 0; i < value.length; i++) {
        head += `\r\n${key}: ${value[i]}`
      }
    }
  }
  head += '\r\n\r\n'
  return Buffer.from(head, 'ascii')
}

function getRequestHeaders (req, proxyName) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.charAt(0) !== ':' && key !== 'host') {
      headers[key] = value
    }
  }

  // TODO(fix): <host> [ ":" <port> ] vs <pseudonym>
  // See, https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Via.
  if (proxyName) {
    if (headers[VIA]) {
      for (const name of headers[VIA].split(',')) {
        if (name.endsWith(proxyName)) {
          throw new HttpError('loop detected', null, 508)
        }
      }
      headers[VIA] += ','
    } else {
      headers[VIA] = ''
    }

    headers[VIA] += `${req.httpVersion} ${req.proxyName}`
  }

  function printIp (address, port) {
    const isIPv6 = net.isIPv6(address)
    let str = `${address}`
    if (isIPv6) {
      str = `[${str}]`
    }
    if (port) {
      str = `${str}:${port}`
    }
    if (isIPv6) {
      str = `"${str}"`
    }
    return str
  }

  const forwarded = [
    `by=${printIp(req.socket.localAddress, req.socket.localPort)}`,
    `for=${printIp(req.socket.remoteAddress, req.socket.remotePort)}`,
    `proto=${req.socket.encrypted ? 'https' : 'http'}`,
    `host=${printIp(req.headers[AUTHORITY] || req.headers[HOST] || '')}`
  ].join(';')

  if (headers[FORWARDED]) {
    headers[FORWARDED] += `, ${forwarded}`
  } else {
    headers[FORWARDED] = `${forwarded}`
  }

  return setupHeaders(headers)
}

function setupSocket (socket) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 0)
}

function setupHeaders (headers) {
  const connection = headers[CONNECTION]

  if (connection && connection !== CONNECTION && connection !== KEEP_ALIVE) {
    for (const name of connection.toLowerCase().split(',')) {
      delete headers[name.trim()]
    }
  }

  // Remove hop by hop headers
  delete headers[CONNECTION]
  delete headers[PROXY_CONNECTION]
  delete headers[KEEP_ALIVE]
  delete headers[PROXY_AUTHENTICATE]
  delete headers[PROXY_AUTHORIZATION]
  delete headers[TE]
  delete headers[TRAILER]
  delete headers[TRANSFER_ENCODING]
  delete headers[UPGRADE]

  delete headers[HTTP2_SETTINGS]

  return headers
}

class HttpError extends Error {
  constructor (msg, code, statusCode) {
    super(msg)
    this.code = code
    this.statusCode = statusCode || 500
  }
}
