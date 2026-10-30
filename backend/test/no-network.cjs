'use strict'

const noNetwork = () => { throw new Error('Unexpected network access in isolated test') }
global.fetch = noNetwork
for (const protocol of [require('node:http'), require('node:https')]) {
  protocol.request = noNetwork
  protocol.get = noNetwork
}
const net = require('node:net')
net.connect = noNetwork
net.createConnection = noNetwork
net.Socket.prototype.connect = noNetwork
require('node:tls').connect = noNetwork
require('node:http2').connect = noNetwork
