const http = require('http')
const https = require('https')

const tlsOptions = [
  'ca',
  'cert',
  'ciphers',
  'clientCertEngine',
  'crl',
  'dhparam',
  'ecdhCurve',
  'honorCipherOrder',
  'key',
  'passphrase',
  'pfx',
  'rejectUnauthorized',
  'secureOptions',
  'secureProtocol',
  'servername',
  'sessionIdContext',
  'highWaterMark',
  'checkServerIdentity',
];

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
      path,
      socketPath,
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
        for (const key of tlsOptions) {
          if (Reflect.has(options, key)) {
            const value = Reflect.get(options, key);
            Reflect.set(ureq, key, value);
          }
        }

        if (hostname !== undefined) {
          ureq.hostname = hostname
        }
        if (port !== undefined) {
          ureq.port = port
        }
        if (path !== undefined) {
          ureq.path = path
        }
        if (proxyTimeout !== undefined) {
          ureq.timeout = proxyTimeout
        }
        if (socketPath !== undefined) {
          ureq.socketPath = socketPath
        }

        let ret
        if (onReq) {
          if (onReq.length <= 2) {
            ret = await onReq(req, ureq)
          } else {
            // Legacy compat...
            ret = await new Promise((resolve, reject) => {
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
              } else {
                resolve()
              }
            })
          }
        }

        if (!ret) {
          let agent
          if (protocol == null || /^(http|ws):?$/.test(protocol)) {
            agent = http
          } else if (/^(http|ws)s:?$/.test(protocol)) {
            agent = https
          } else {
            throw new Error('invalid protocol')
          }
          ret = agent.request(ureq)
        }

        return ret
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
