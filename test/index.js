var Q = require('q')
var Blockchain = require('cb-blockr')
var test = require('tape')
var bitcoin = require('bitcoinjs-lib')
var pluck = require('array-pluck')
var Loader = require('../')
var FakeKeeper = require('tradle-test-helpers').FakeKeeper
var app = require('./fixtures/app')

test('load app models from list of model-creation tx ids', function (t) {
  t.plan(1)

  var network = 'testnet'
  var api = new Blockchain(network)
  var models = app.models.bodies
  var txIds = app.models.txIds
  var loaded = []
  Q.all([
      Q.ninvoke(api.transactions, 'get', txIds),
      FakeKeeper.forData(models)
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

      ;['file:public', 'file:shared'].forEach(function (event) {
        loader.on(event, function (file) {
          loaded.push(file)
        })
      })

      return loader.load(txs)
    })
    .then(function () {
      var files = pluck(loaded, 'file')
      t.deepEqual(files, models)
    })
    .done()
})
