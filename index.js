
var assert = require('assert')
// var Transform = require('readable-stream').Transform
var Q = require('q')
var typeforce = require('typeforce')
var utils = require('@tradle/utils')
var debug = require('debug')('chainloader')
// var inherits = require('util').inherits
var extend = require('xtend/mutable')
// var clone = require('xtend/immutable')
var txd = require('@tradle/tx-data')
var TxInfo = txd.TxInfo
var TxData = txd.TxData
var Permission = require('@tradle/permission')
var Errors = require('./errors')
// var pluck = require('./pluck')
// var FILE_EVENTS = ['file:shared', 'file:public', 'file:permission']

module.exports = Loader
Loader.Errors = Errors
// inherits(Loader, Transform)

/**
 * Load data from the chain (blockchain + keeper)
 * @param {Function} lookup (optional) - function to look up identities by fingerprints
 * @param {BitKeeper|BitKeeper client} keeper
 * @param {String} networkName
 * @param {String} prefix - prefix for OP_RETURN data
 * @param {Object} options
 */
function Loader (options) {
  // var self = this

  typeforce({
    keeper: 'Object',
    networkName: 'String',
    prefix: 'String'
  }, options)

  typeforce({
    put: 'Function',
    getMany: 'Function'
  }, options.keeper)

  // Transform.call(this, {
  //   objectMode: true,
  //   highWaterMark: 16
  // })

  utils.bindPrototypeFunctions(this)

  extend(this, options)
  if (options.lookup) this.lookupWith(options.lookup)
}

Loader.prototype.load = function (txs) {
  return Array.isArray(txs)
    ? this.loadMany(txs)
    : this.loadOne(txs)
}

/**
 * Returns an aggregated promise (Q.allSettled)
 * @param  {[type]} txs [description]
 * @return {[type]}     [description]
 */
Loader.prototype.loadMany = function (txs) {
  return Q.allSettled(txs.map(this.loadOne))
}

Loader.prototype.loadOne = function (tx) {
  var self = this
  var parsed
  return this._parseTx(tx)
    .then(function (_parsed) {
      parsed = _parsed
      var cached = parsed.txType === TxData.types.public
        ? parsed.data
        : parsed.encryptedData

      return cached || self.fetch(parsed.key)
    })
    .then(function (data) {
      if (parsed.txType === TxData.types.public) {
        parsed.data = data
        // self.emit('file:public', parsed)
        return parsed
      }

      parsed.encryptedPermission = data
      return processSharedFile(data, parsed.sharedKey)
    })
    .catch(function (err) {
      throw errorWithProgress(err, parsed)
    })

  function processSharedFile (file, sharedKey) {
    return loadPermission(file, sharedKey)
      .then(function (permission) {
        parsed.permission = permission
        parsed.key = parsed.permission.fileKeyString()
        return parsed.encryptedData || self.fetch(parsed.key)
      })
      .then(function (file) {
        parsed.encryptedData = file

        var decryptionKey = parsed.permission.decryptionKeyBuf()
        if (!decryptionKey) return file

        return decrypt(file, decryptionKey)
      })
  }

  function loadPermission (file, sharedKey) {
    if (parsed.permission) return Q(parsed.permission)

    return Q.ninvoke(Permission, 'recover', file, sharedKey)
      .catch(function (err) {
        debug('Failed to recover permission file contents from raw data', err)
        throw new Errors.InvalidPermission(err, {
          key: parsed.key
        })
      })
  }

  function decrypt (file, decryptionKey) {
    return Q.ninvoke(utils, 'decryptAsync', {
      data: file,
      key: decryptionKey
    })
    .then(function (file) {
      parsed.data = file
      return parsed
    })
    .catch(function (err) {
      debug('Failed to decrypt ciphertext: ' + file, err)
      throw new Errors.Decrypt({
        key: parsed.key
      })
    })
  }
}

/*
 * @param {Function} fn - function to look up identities by fingerprints (must return Promise)
 *   @example
 *     function lookup (cb) {
 *       cb(err, {
 *         key: key with pub/priv props or functions
 *       })
 *     }
 */
Loader.prototype.lookupWith = function (fn) {
  this.lookup = fn
  return this
}

Loader.prototype.fetch = function (key) {
  return this.keeper.getOne(key)
    .catch(function (err) {
      debug('Error fetching file', err)
      throw new Errors.FileNotFound(err, {
        key: key
      })
    })
}

Loader.prototype._processTxInfo = function (parsed) {
  var self = this
  if (parsed.permission) return Q(parsed)

  if (!parsed.encryptedPermission) {
    if (!TxInfo.validate(parsed)) {
      return Q.reject(new Errors.NotEnoughInfo({
        txId: parsed.txId
      }))
    }

    if (isOldFormatTxData(parsed)) {
      return Q.reject(new Errors.Decrypt({
        key: parsed.sharedKey
      }))

      // old format used insecure utils.decrypt
    }
  }

  return this._lookupParties(parsed.addressesFrom, parsed.addressesTo)
    .then(function (matches) {
      if (matches) {
        parsed.from = matches.from
        parsed.to = matches.to
      }

      if (parsed.txType === TxData.types.public) {
        parsed.key = parsed.txData.toString('hex')
      } else {
        return processPermission()
      }
    })
    .then(function () {
      return parsed
    })

  function processPermission () {
    if (!(parsed.from && parsed.to)) {
      throw new Errors.ParticipantsNotFound({
        message: 'failed to derive tx participants',
        txId: parsed.txId
      })
    }

    parsed.encryptedKey = parsed.txData
    parsed.sharedKey = self._getSharedKey(parsed.from, parsed.to)
    if (!parsed.sharedKey) {
      throw new Errors.ECDH({
        message: 'failed to derive shared key',
        txId: parsed.txId
      })
    }

    if (parsed.encryptedPermission) {
      debug('have encryptedPermission, skipping decryption of txData')
      return
    }

    return Q.ninvoke(utils, 'decryptAsync', {
      data: parsed.txData,
      key: parsed.sharedKey
    })
    .catch(function (err) {
      debug('failed to decrypt txData', err)
      throw new Errors.Decrypt({
        key: parsed.key
      })
    })
    .then(function (key) {
      parsed.key = key.toString('hex')
      parsed.permissionKey = parsed.key
    })
  }
}

Loader.prototype._getSharedKey = function (from, to) {
  if (!(from && to)) return

  var fromKey = from.key
  var toKey = to.key
  var priv = getResult(fromKey, 'priv')
  var pub = getResult(toKey, 'value')
  if (!priv) {
    priv = getResult(toKey, 'priv')
    pub = getResult(fromKey, 'value')
  }

  return priv && pub && utils.sharedEncryptionKey(priv, pub)
}

Loader.prototype._parseTxs = function (txs) {
  return Q.allSettled(txs.map(this._parseTx))
}

Loader.prototype._parseTx = function (tx, cb) {
  // may already be parsed
  var parsed = TxInfo.validate(tx)
    ? tx
    : TxInfo.parse(tx.tx || tx, this.networkName, this.prefix)

  if (!parsed) {
    return Q.reject(new Errors.NoData({
      txId: parsed.txId
    }))
  }

  return this._processTxInfo(parsed)
    .catch(function (err) {
      throw errorWithProgress(err, parsed)
    })
}

/**
 * lookup parties in a tx
 * @param  {Array} from - bitcoin addresses
 * @param  {Array} to - bitcoin addresses
 * @return {Promise} uses this.lookup to lookup parties, resolves with:
 *  {
 *    from: result of this.lookup,
 *    to: result of this.lookup
 *  }
 */
Loader.prototype._lookupParties = function (from, to) {
  var self = this
  var matches = {}
  if (!this.lookup) return Q.resolve(matches)

  var allAddrs = from.concat(to)

  // cache to prevent running 2 lookups for 1 address
  var promiseByAddr = {}
  var lookups = allAddrs.map(function (f) {
    if (!f) return Q.reject()

    var promise = promiseByAddr[f]
    if (!promise) {
      promise = promiseByAddr[f] = self.lookup(f, true) // private
      assert(Q.isPromiseAlike(promise), '"lookup" function should return a promise')
    }

    return promise
  })

  return Q.allSettled(lookups)
    .then(function (results) {
      results = results.map(function (r) {
        return r.value
      })

      results.slice(0, from.length)
        .some(function (result) {
          if (result) {
            matches.from = result
            return true
          }
        })

      results.slice(from.length)
        .some(function (result) {
          if (result && matches.from && matches.from.key.value !== result.key.value) {
            matches.to = result
            return true
          }
        })

      return Object.keys(matches).length ? matches : null
    })
}

function getResult (obj, p) {
  var val = obj[p]
  if (typeof val === 'function') return obj[p]()
  else return val
}

function errorWithProgress (err, parsed) {
  if (!err.progress) err.progress = parsed

  return err
}

function isOldFormatTxData (parsed) {
  return parsed.txType === TxData.types.permission &&
    parsed.txData.length === 20
}
