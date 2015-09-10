# chainloader

1. Parses blockchain transactions for embedded data keys
1. Fetches the access-rights files (for non-public files) from a Tradle keeper
1. Fetches the public/shared object bodies from a Tradle keeper
1. Returns all collected data and metadata, both in its original (encrypted), and decrypted form.

## Usage

```js
var Loader = require('chainloader')
var loader = new Loader({
  prefix: 'tradle',
  networkName: 'testnet',
  keeper: keeper, // see tradle/bitkeeper-js
  lookup: identityLookupFn
})

// bitcoin.Transaction, or array of them (bitcoinjs-lib)
loader.load(tx)
  .then(function (chainedObj) {
  // chainedObj has
  // 1. metadata about the chained object,
  // 2. the associated permission file (if any)
  // 3. the chained object
  // 
  // all together it looks like:
  //    {
  //      encryptedKey: Buffer, // encrypted DHT key of the file
  //      key: String,          // decrypted DHT key of the file
  //      data: Buffer,         // serialized object data
  //      from: Object,         // result from identityLookupFn
  //      to: Object,           // result from identityLookupFn
  //      tx: bitcoin.Transaction, // see bitcoinjs-lib
  //      txId: String,
  //      txType: TxData.types[type], // see tradle/tx-data
  //      txData: Buffer, // data embedded in the tx
  //      addressesFrom: Array,
  //      addressesTo: Array,
  //      // if it's a shared file:
  //      permission: Permission, // see tradle/permission
  //      encryptedPermission: Buffer,
  //      sharedKey: Buffer, // shared key (ECC) of bitcoin tx participants
  //      permissionKey: String, // the DHT key of the permission file
  //      encryptedData: Buffer, // encrypted object data
  //    }
  })

// to be implemented by you, see tests for an example
// or you can use tradle/tim which does the whole shebang
function identityLookupFn (fingerprint, cb) {
  // ...
  cb(null, {
    identity: identity,
    key: key
  })
}
```
