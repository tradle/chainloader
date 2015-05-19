var Q = require('q')
var typeForce = require('typeforce')
var utils = require('tradle-utils')
var debug = require('debug')('chainloader')
var find = require('array-find')
// var bitcoin = require('bitcoinjs-lib')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var pluck = require('array-pluck')
var extend = require('extend')
var getTxInfo = require('tradle-tx-data').getTxInfo
var Permission = require('tradle-permission')
var FILE_EVENTS = ['file:shared', 'file:public', 'file:permission']

module.exports = Loader

function Loader (options) {
  var self = this

  typeForce({
    keeper: 'Object',
    networkName: 'String',
    prefix: 'String'
  }, options)

  typeForce({
    put: 'Function',
    getMany: 'Function'
  }, options.keeper)

  EventEmitter.call(this)
  utils.bindPrototypeFunctions(this)

  extend(this, options)

  FILE_EVENTS.forEach(function (event) {
    self.on(event, function (data) {
      self.saveIfNew(data)
      self.emit('file', data)
    })
  })
}

inherits(Loader, EventEmitter)

/**
 *  Optimized data loading with minimum calls to keeper
 *  @return {Q.Promise} for files related to the passed in transactions/ids
 **/
Loader.prototype.load = function (txs) {
  var self = this
  txs = [].concat(txs)

  var parsed = this._parseTxs(txs)
  if (!parsed.length) return Q.resolve()

  var pub = parsed.filter(function (p) { return p.type === 'public' })
  var enc = parsed.filter(function (p) { return p.type === 'permission' })
  var keys = pub.concat(enc).map(function (p) {
    return p.key.toString('hex')
  })

  var shared
  var files = []
  return this.fetchFiles(keys)
    .then(function (files) {
      pub.forEach(function (parsed, i) {
        if (files[i]) {
          parsed.file = files[i]
          self.emit('file:public', parsed)
          files.push(parsed)
        }
      })

      if (!enc) return

      shared = enc.filter(function (parsed, i) {
        var file = files[i + pub.length]
        if (!file) return

        try {
          parsed.permission = Permission.recover(file, parsed.sharedKey)
        } catch (err) {
          debug('Failed to recover permission file contents from raw data', err)
          return
        }

        self.emit('file:permission', parsed)
        return parsed
      })

      if (!shared.length) return

      return self.fetchFiles(pluck(shared, 'key'))
    })
    .then(function (sharedFiles) {
      if (!sharedFiles) return

      sharedFiles.forEach(function (file, idx) {
        var parsed = extend({}, shared[idx])
        var pKey = parsed.key
        parsed.key = parsed.permission.fileKeyString()
        parsed.permissionKey = pKey
        parsed.type = 'sharedfile'

        var decryptionKey = parsed.permission.decryptionKeyBuf()
        if (decryptionKey) {
          try {
            file = utils.decrypt(file, decryptionKey)
          } catch (err) {
            debug('Failed to decrypt ciphertext: ' + file)
            return
          }
        }

        parsed.file = file
        self.emit('file:shared', parsed)
        files.push(parsed)
      })

      return files
    })
}

// /**
//  * Attempt to deduce the permission key and ECDH shared key
//  *   from the parties involved in the bitcoin transaction
//  * @param  {Transaction} tx
//  * @param  {TransactionData} txData
//  * @return {Object}   permission file "key" and ECDH "sharedKey" to decrypt it
//  */
// Loader.prototype.deduceECDHKeys = function(tx, txData) {
//   if (!(this.wallet && txData)) return

//   var wallet = this.wallet
//   var myAddress
//   var myPrivKey
//   var theirPubKey
//   var toMe = this.getSentToMe(tx)
//   var fromMe = this.getSentFromMe(tx)
//   if (!toMe.length && !fromMe.length) {
//     debug('Cannot parse permission data from transaction as it\'s neither to me nor from me')
//     return
//   }

//   if (fromMe.length) {
//     // can't figure out their public key
//     if (toMe.length !== tx.outs.length - 1) {
//       debug('Unable to process transaction data, don\'t know the public key of the receipient')
//       return
//     }

//     tx.ins.some(function(input) {
//       var addr = utils.getAddressFromInput(input, this.networkName)
//       myPrivKey = wallet.getPrivateKeyForAddress(addr)
//       return myPrivKey
//     }, this)

//     toMe.some(function(out) {
//       var addr = utils.getAddressFromOutput(out, this.networkName)
//       if (addr && !wallet.isChangeAddress(addr)) {
//         theirPubKey = wallet.getPublicKeyForAddress(addr)
//         return true
//       }
//     }, this)
//   } else {
//     myAddress = utils.getAddressFromOutput(toMe[0], this.networkName)
//     myPrivKey = wallet.getPrivateKeyForAddress(myAddress)
//     theirPubKey = bitcoin.ECPubKey.fromBuffer(tx.ins[0].script.chunks[1])
//   }

//   return myPrivKey && theirPubKey && {
//     priv: myPrivKey,
//     pub: theirPubKey
//   }
// }

// /**
//  *  @return {Array} outputs in tx that the underlying wallet can spend
//  */
// Loader.prototype.getSentToMe = function(tx) {
//   if (!this.wallet) return []

//   return tx.outs.filter(function(out) {
//     var address = common.getAddressFromOutput(out, this.networkName)
//     return this.wallet.getPrivateKeyForAddress(address) && out
//   }, this)
// }

// /**
//  *  @return {Array} inputs in tx that are signed by the underlying wallet
//  */
// Loader.prototype.getSentFromMe = function(tx) {
//   if (!this.wallet) return []

//   return tx.ins.filter(function(input) {
//     var address = common.getAddressFromInput(input, this.networkName)
//     return this.wallet.getPrivateKeyForAddress(address) && input
//   }, this)
// }

Loader.prototype.fetchFiles = function (keys) {
  return this.keeper.getMany(keys)
    .catch(function (err) {
      debug('Error fetching files', err)
      throw new Error(err.message || 'Failed to retrieve file from keeper')
    })
}

Loader.prototype.saveIfNew = function (data) {
  var self = this

  var wallet = this.wallet
  if (!wallet) return

  var tx = data.tx.body
  var metadata = data.tx.metadata
  if (!metadata || metadata.confirmations) return

  var received = !wallet.isSentByMe(tx)
  var type = received ? 'received' : 'sent'
  return this.keeper.put(data.file)
    .then(function () {
      self.emit('file:' + type, data)
    })
}

Loader.prototype._getSharedKey = function (parsed) {
  var me = this.identity
  var from = parsed.from
  var to = parsed.to
  var pub
  var priv
  if (me && from && to) {
    if (me === from.identity || me === to.identity) {
      priv = me === from.identity ? from.key.priv() : to.key.priv()
      pub = me === from.identity ? to.key.pub() : from.key.pub()
      return pub && priv && utils.sharedEncryptionKey(priv, pub)
    }
  }

  // if (!(priv && pub)) {
  //   // priv = ...
  //   // pub = ...
  //   // TODO: fall back to decrypting based on bitcoin keys associated with this tx
  //   var keys = this.deduceECDHKeys(parsed.tx.body, parsed.tx.data)
  //   if (!keys) return

  //   pub = keys.pub
  //   priv = keys.priv
  // }

// return utils.sharedEncryptionKey(priv, pub)
}

Loader.prototype._parseTxs = function (txs) {
  var self = this
  var results = []
  txs.forEach(function (tx) {
    var parsed = getTxInfo(tx, self.networkName, self.prefix)
    if (!parsed) return

    var from
    var to
    if (self.addressBook) {
      var addrs = parsed.tx.addresses
      find(addrs.from, function (addr) {
        from = self.addressBook.byFingerprint(addr)
        return from
      })

      find(addrs.to, function (addr) {
        to = self.addressBook.byFingerprint(addr)
        return to
      })

      parsed.from = from
      parsed.to = to
      if (parsed.type === 'permission' && from && to) {
        parsed.sharedKey = self._getSharedKey(parsed)
        try {
          parsed.key = utils.decrypt(parsed.key, parsed.sharedKey)
        } catch (err) {
          debug('Failed to decrypt permission key: ' + parsed.key)
          return
        }
      }
    }

    // encrypted permissions are impossible to decrypt
    // if we don't know who they're from
    if (parsed.type === 'public' || (parsed.from && parsed.to)) {
      parsed.key = parsed.key.toString('hex')
      results.push(parsed)
    }
  })

  return results
}
