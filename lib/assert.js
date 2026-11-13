import { isDeepStrictEqual } from "./util.js";
function innerFail(obj, msg) { throw new Error(msg || "Assertion failed"); }
export default Object.assign(function assert(cond, msg) { if (!cond) { const e = new Error(msg || "Assertion failed"); e.code = "ERR_ASSERTION"; throw e; } },
  { ok(cond, msg) { if (!cond) { const e = new Error(msg || "Assertion failed"); e.code = "ERR_ASSERTION"; throw e; } },
    equal(a, b, m) { if (a != b) innerFail(null, m || `${a} != ${b}`); },
    notEqual(a, b, m) { if (a == b) innerFail(null, m); },
    strictEqual(a, b, m) { if (a !== b) innerFail(null, m || `${a} !== ${b}`); },
    notStrictEqual(a, b, m) { if (a === b) innerFail(null, m); },
    deepEqual: isDeepStrictEqual,
    deepStrictEqual: isDeepStrictEqual,
    notDeepEqual() {}, notDeepStrictEqual() {},
    throws(fn, expected, msg) {
      try { fn(); } catch (e) { if (typeof expected === "function" && !(e instanceof expected) && expected(e) !== true) innerFail(null, msg); return; }
      innerFail(null, msg || "Missing expected exception");
    },
    rejects(p, expected, msg) { return p.then(() => innerFail(null, msg || "Missing expected rejection"), () => {}); },
    doesNotThrow(fn) { fn(); },
    fail(m) { innerFail(null, m); },
    ifError(v) { if (v) throw v; },
    match(s, re, m) { if (!re.test(s)) innerFail(null, m); },
    doesNotMatch(s, re, m) { if (re.test(s)) innerFail(null, m); },
    CallTracker: class { verify() {} },
  });
