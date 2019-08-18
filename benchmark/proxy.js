const proxy = require('../')
require('http').createServer((req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost',
    port: 9000
  }, err => err && console.error(err))
}).listen(8000)
