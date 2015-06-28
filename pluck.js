
module.exports = function (arr, prop) {
  var vals = []
  for (var i = 0; i < arr.length; i++) {
    vals.push(arr[i][prop])
  }

  return vals
}
