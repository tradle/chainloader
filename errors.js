
var WrappedError = require('error/wrapped')
var TypedError = require('error/typed')
module.exports = {
  NotEnoughInfo: TypedError({
    type: 'notEnoughInfo',
    message: 'for tx: {txId}',
    txId: null,
    timestamp: null
  }),
  NoData: TypedError({
    type: 'noData',
    message: 'for tx: {txId}',
    txId: null,
    timestamp: null
  }),
  ParticipantsNotFound: TypedError({
    type: 'participantsNotFound',
    message: 'for tx: {txId}',
    txId: null,
    timestamp: null
  }),
  ECDH: TypedError({
    type: 'ecdh',
    message: 'for tx: {txId}',
    txId: null,
    timestamp: null
  }),
  Decrypt: TypedError({
    type: 'decrypt',
    message: 'for tx: {txId}',
    txId: null,
    timestamp: null
  }),
  InvalidPermission: WrappedError({
    type: 'invalidPermission',
    message: 'invalid permission for key {key}: {origMessage}',
    key: null,
    timestamp: null
  }),
  FileNotFound: WrappedError({
    type: 'fileNotFound',
    message: 'file not found for key {key}: {origMessage}',
    key: null,
    timestamp: null
  })
}
