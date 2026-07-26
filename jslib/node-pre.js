/* Node build prologue.
 *
 * `_` is the minimal underscore shim in underscore-mock-es6.js. It lives in its
 * own module so the test suite can require the exact same object the bundle
 * uses, instead of a second copy that can drift. Paths resolve relative to
 * jslib/, which is where dagitty-node.js is written. */

const _ = require("./underscore-mock-es6.js")

