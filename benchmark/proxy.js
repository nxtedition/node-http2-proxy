const proxy = require('../')
require('http2').createServer({
  allowHTTP1: true,
  onRequest: function (req, res) {
    proxy.web(req, res, {
      hostname: 'localhost',
      port: 9000
    })
  }
}).listen(8000)
