var Q = require('q')
var typeForce = require('typeforce')
var utils = require('tradle-utils')
var debug = require('debug')('chainloader')
var find = require('array-find')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var pluck = require('array-pluck')
var extend = require('extend')
var getTxInfo = require('tradle-tx-data').getTxInfo
var Permission = require('tradle-permission')
var FILE_EVENTS = ['file:shared', 'file:public', 'file:permission']

module.exports = Loader

/**
 * Load data from the chain (blockchain + keeper)
 * @param {Function} lookup (optional) - function to look up identities by fingerprints
 *   @example
 *     function lookup (cb) {
 *       cb({
 *         key: key with pub/priv props or functions
 *       })
 *     }
 *
 * @param {BitKeeper|BitKeeper client} keeper
 * @param {String} networkName
 * @param {String} prefix - prefix for OP_RETURN data
 * @param {Object} options
 */
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
      // self.saveIfNew(data)
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

  return this._parseTxs(txs)
    .then(onParsed)

  function onParsed (parsed) {
    if (!parsed.length) return Q.resolve()

    var pub = parsed.filter(function (p) { return p.type === 'public' })
    var enc = parsed.filter(function (p) { return p.type === 'permission' })
    var keys = pluck(pub.concat(enc), 'key')
    var shared
    var files = []
    return self.fetchFiles(keys)
      .then(function (fetched) {
        if (!fetched.length) return

        pub.forEach(function (parsed, i) {
          if (fetched[i]) {
            parsed.file = fetched[i]
            self.emit('file:public', parsed)
            files.push(parsed)
          }
        })

        if (!enc.length) return

        shared = enc.filter(function (parsed, i) {
          var file = fetched[i + pub.length]
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
        if (sharedFiles) {
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
        }

        return files.sort(function (a, b) {
          return txs.indexOf(a.tx.body) - txs.indexOf(b.tx.body)
        })
      })
  }
}

// /**
//  * Attempt to deduce the permission key and ECDH shared key
//  *   from the parties involved in the bitcoin transaction
//  * @param  {Transaction} tx
//  * @param  {TransactionData} txData
//  * @return {Object}   permission file "key" and ECDH "sharedKey" to decrypt it
//  */
// Loader.prototype.deduceECDHKeys = function (tx, txData) {
//   if (!(this.wallet && txData)) return

//   var wallet = this.wallet
//   var myAddress
//   var myPrivKey
//   var theirPubKey
//   var toMe = this.getSentToMe(tx)
//   var fromMe = this.getSentFromMe(tx)
//   if (!toMe.length && !fromMe.length) {
//     debug("Cannot parse permission data from transaction as it's neither to me nor from me")
//     return
//   }

//   if (fromMe.length) {
//     tx.ins.some(function (input) {
//       var addr = utils.getAddressFromInput(input, this.networkName)
//       myPrivKey = wallet.addressString === addr && wallet.priv
//       return myPrivKey
//     }, this)

//     toMe.some(function (out) {
//       var addr = utils.getAddressFromOutput(out, this.networkName)
//       theirPubKey = addr === wallet.addressString && wallet.pub
//       return theirPubKey
//     }, this)
//   } else {
//     myAddress = utils.getAddressFromOutput(toMe[0], this.networkName)
//     myPrivKey = wallet.addressString === myAddress && wallet.priv
//     theirPubKey = bitcoin.ECPubKey.fromBuffer(tx.ins[0].script.chunks[1])
//   }

//   if (myPrivKey && theirPubKey) {
//     if (myPrivKey.pub.toHex() !== theirPubKey.toHex()) {
//       return {
//         priv: myPrivKey,
//         pub: theirPubKey
//       }
//     }
//   }

// }

/**
 *  @return {Array} outputs in tx that the underlying wallet can spend
 */
// Loader.prototype.getSentToMe = function (tx) {
//   if (!this.wallet) return []

//   return tx.outs.filter(function (out) {
//     var address = utils.getAddressFromOutput(out, this.networkName)
//     return this.wallet.addressString === address
//   }, this)
// }

/**
 *  @return {Array} inputs in tx that are signed by the underlying wallet
 */
// Loader.prototype.getSentFromMe = function (tx) {
//   if (!this.wallet) return []

//   return tx.ins.filter(function (input) {
//     var address = utils.getAddressFromInput(input, this.networkName)
//     return this.wallet.addressString === address
//   }, this)
// }

Loader.prototype.fetchFiles = function (keys) {
  return this.keeper.getMany(keys)
    .catch(function (err) {
      debug('Error fetching files', err)
      throw new Error(err.message || 'Failed to retrieve file from keeper')
    })
}

// Loader.prototype.saveIfNew = function (data) {
//   var self = this

//   var wallet = this.wallet
//   if (!wallet) return

//   var tx = data.tx.body
//   var metadata = data.tx.metadata
//   if (!metadata || metadata.confirmations) return

//   var received = !wallet.isSentByMe(tx)
//   var type = received ? 'received' : 'sent'
//   return this.keeper.put(data.file)
//     .then(function () {
//       self.emit('file:' + type, data)
//     })
// }

Loader.prototype._getSharedKey = function (parsed) {
  if (!(parsed.from && parsed.to)) return

  var to = find(parsed.to, function (result) {
    return !result.identity.equals(parsed.from.identity)
  })

  if (!to.length) return
  if (to.length !== 1) throw new Error('too many recipients')

  var from = parsed.key
  to = to[0].key

  var priv = getResult(from, 'priv')
  var pub = getResult(to, 'pub')
  if (!priv) {
    priv = getResult(to, 'priv')
    pub = getResult(from, 'pub')
  }

  return priv && pub && utils.sharedEncryptionKey(priv, pub)
}

Loader.prototype._parseTxs = function (txs) {
  return Q.all(txs.map(this._parseTx, this))
}

Loader.prototype._parseTx = function (tx, cb) {
  var self = this
  var parsed = getTxInfo(tx, self.networkName, self.prefix)
  if (!parsed) return Q.resolve()

  var addrs = parsed.tx.addresses
  if (!this.lookup) return onlookedup()

  var allAddrs = addrs.from.concat(addrs.to)
  var lookups = allAddrs.map(function (f) {
    return Q.ninvoke(self, 'lookup', f)
  })

  return Q.allSettled(lookups)
    .then(function (results) {
      results.slice(0, addrs.from.length)
        .some(function (result) {
          if (result.value) {
            parsed.from = result.value
            return true
          }
        })

      var to = results.slice(addrs.from.length)
        .filter(function (result) {
          return !!result.value
        })

      if (to.length) parsed.to = to

      return onlookedup()
    })
    .then(onlookedup)

  function onlookedup () {
    if (parsed.type !== 'public') {
      parsed.sharedKey = self._getSharedKey(parsed)
      if (parsed.sharedKey) {
        try {
          parsed.key = utils.decrypt(parsed.key, parsed.sharedKey)
        } catch (err) {
          debug('Failed to decrypt permission key: ' + parsed.key)
          return
        }
      }
    }

    // encrypted permissions are impossible to decrypt
    // if we don't know the shared key
    if (parsed.type === 'public' || parsed.sharedKey) {
      parsed.key = parsed.key.toString('hex')
      return parsed
    }
  }

  // if (self.identity) {
  //   find(addrs.from, function (addr) {
  //     var key = self.identity.keys({ fingerprint: addr })[0]
  //     from = key && {
  //       key: key,
  //       identity: self.identity
  //     }

  //     return from
  //   })

  //   if (from.identity !== self.identity) {
  //     find(addrs.to, function (addr) {
  //       var key = self.identity.keys({ fingerprint: addr })[0]
  //       to = key && {
  //         key: key,
  //         identity: self.identity
  //       }

  //       return to
  //     })
  //   }
  // }

  // if (self.addressBook) {
  //   if (!from) {
  //     find(addrs.from, function (addr) {
  //       from = self.addressBook.byFingerprint(addr)
  //       return from
  //     })
  //   }

  //   if (!to) {
  //     find(addrs.to, function (addr) {
  //       to = self.addressBook.byFingerprint(addr)
  //       return to
  //     })
  //   }
  // }

  // parsed.from = from
  // parsed.to = to
}

function getResult (obj, p) {
  var val = obj[p]
  if (typeof val === 'function') return obj[p]()
  else return val
}
