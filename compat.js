const http = require('http')
const https = require('https')

module.exports = function (proxy) {
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
            return onReq(req, ureq)
          } else {
            // Legacy compat...
            return new Promise((resolve, reject) => {
              const promiseOrReq = onReq(req, ureq, (err, val) =>
                err ? reject(err) : resolve(val)
              )
              if (promiseOrReq) {
                if (promiseOrReq.then) {
                  promiseOrReq.then(resolve).catch(reject)
                } else if (promiseOrReq.abort) {
                  resolve(promiseOrReq)
                } else {
                  throw new Error(
                    'onReq must return a promise or a request object'
                  )
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
            throw new Error(`invalid protocol`)
          }
          return agent.request(ureq)
        }
      },
      onRes
        ? async (proxyRes, headers) => {
          proxyRes.headers = headers
          if (onRes.length <= 3) {
            return onRes(req, res, proxyRes)
          } else {
            // Legacy compat...
            return new Promise((resolve, reject) => {
              const promise = onRes(req, res, proxyRes, (err, val) =>
                err ? reject(err) : resolve(val)
              )
              if (promise && promise.then) {
                promise.then(resolve).catch(reject)
              }
            })
          }
        }
        : null
    )
  }

  return proxy
}
