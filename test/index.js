var Q = require('q')
var Blockchain = require('@tradle/cb-blockr')
var test = require('tape')
var bitcoin = require('@tradle/bitcoinjs-lib')
var Loader = require('../')
var fakeKeeper = require('@tradle/test-helpers').fakeKeeper
// var Wallet = require('simple-wallet')
// var pluck = require('../pluck')
var app = require('./fixtures/app')
var share = require('./fixtures/share')

test('load app models from list of model-creation tx ids', function (t) {
  t.plan(1)

  var network = 'testnet'
  var api = new Blockchain(network)
  var models = app.models.bodies
  var txIds = app.models.txIds
  // var loaded = []
  Q.all([
    Q.ninvoke(api.transactions, 'get', txIds),
    fakeKeeper.forData(models)
  ])
  .spread(function (txs, keeper) {
    txs = txs.map(function (tx) {
      return bitcoin.Transaction.fromHex(tx.txHex)
    })

    var loader = new Loader({
      prefix: 'tradle',
      networkName: network,
      keeper: keeper
    })

    return loader.load(txs)
  })
  .then(function (results) {
    var files = results.map(function (r) {
      return r.value.data
    })

    t.deepEqual(files, models)
  })
  .done()
})

test('test shared files', function (t) {
  var netName = share.networkName
  var net = bitcoin.networks[netName]
  var keeper = fakeKeeper.forMap(share.keeper)
  keeper.getOne = function (key) {
    if (key in share.keeper) {
      return Q.resolve(new Buffer(share.keeper[key], 'base64'))
    } else {
      return Q.reject('not found')
    }
  }

  var txs = share.txs.map(function (tx) {
    return bitcoin.Transaction.fromHex(tx)
  })

  var pubKeys = share.recipients.map(function (pk) {
    return bitcoin.ECKey.fromWIF(pk).pub
  })

  var pub = bitcoin.ECKey.fromWIF(share.priv).pub
  var myAddr = pub.getAddress(net).toString()
  var addresses = pubKeys.map(function (p) {
    return p.getAddress(net).toString()
  })

  var loader = new Loader({
    prefix: share.prefix,
    networkName: netName,
    keeper: keeper,
    lookup: function (address) {
      if (address === myAddr) {
        return Q.resolve({
          key: {
            priv: share.priv,
            value: pub.toHex()
          }
        })
      } else {
        var idx = addresses.indexOf(address)
        if (idx === -1) return Q.reject(new Error('not found'))

        return Q.resolve({
          key: {
            value: pubKeys[idx].toHex()
          }
        })
      }
    }
  })

  loader.load(txs)
    .then(function (results) {
      t.equal(results[0].value.key, share.key)
    })
    .done(function () {
      t.end()
    })
})
