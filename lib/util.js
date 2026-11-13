// node:util — format, inspect, promisify, types, etc.
const formatRegExp = /%[sdjifoOc%]/g;

export function format(f, ...args) {
  if (typeof f !== "string") return [f, ...args].map((x) => stringify(x)).join(" ");
  let i = 0;
  let out = f.replace(formatRegExp, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case "%s": return typeof a === "string" ? a : stringify(a);
      case "%d": return typeof a === "bigint" ? a.toString() : String(Number(a));
      case "%i": return String(Math.trunc(Number(a)));
      case "%f": return String(Number(a));
      case "%j": return safeJSON(a);
      case "%o": return stringify(a, { depth: 4 });
      case "%O": return stringify(a, { depth: 4 });
      case "%c": return "";
      default: return m;
    }
  });
  for (; i < args.length; i++) out += " " + stringify(args[i]);
  return out;
}
function safeJSON(o) { try { return JSON.stringify(o); } catch { return "[Circular]"; } }

function stringify(v, opts) {
  return inspect(v, opts);
}

export function inspect(v, opts = {}) {
  const depth = opts.depth ?? 2;
  const colors = opts.colors ?? false;
  const seen = opts._seen || new Set();
  return insp(v, depth, seen, 0);
}
function insp(v, depth, seen, indent) {
  const pad = "  ".repeat(indent + 1);
  const padEnd = "  ".repeat(indent);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return depth >= 2 ? v : `'${v}'`;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol")
    return String(v);
  if (typeof v === "function") {
    const name = v.name ? `: ${v.name}` : "";
    if (String(v).startsWith("class")) return `[class${name}]`;
    return `[Function${name}]`;
  }
  if (v instanceof Error) {
    let extra = "";
    for (const k of Object.keys(v)) if (!["message", "stack"].includes(k)) extra += ` ${k}=${insp(v[k], 0, seen, indent)}`;
    const stack = v.stack ? String(v.stack).split("\n").slice(0, 4).join("\n") : "";
    return `[${v.name}: ${v.message}${extra}]${depth > 0 ? "\n" + stack : ""}`;
  }
  if (v instanceof Date) return v.toISOString();
  if (v instanceof RegExp) return v.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(v))
    return `<Buffer ${[...v.slice(0, 64)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}${v.length > 64 ? " ..." : ""}>`;
  if (ArrayBuffer.isView(v)) {
    if (v instanceof Uint8Array && v.constructor === Uint8Array && typeof Buffer !== "undefined" && Buffer.prototype === Object.getPrototypeOf(v))
      return insp(v, depth, seen, indent); // Buffer handled above
    const vals = [...v.slice(0, 64)].map((x) => insp(x, Math.max(depth - 1, 0), seen, indent + 1));
    return `${v.constructor.name}(${v.length}) [ ${vals.join(", ")}${v.length > 64 ? ", ..." : ""} ]`;
  }
  if (seen.has(v)) return "[Circular]";
  if (depth <= 0) {
    if (Array.isArray(v)) return `[Array(${v.length})]`;
    try { return String(v); } catch { return "[Object]" }
  }
  seen = new Set(seen); seen.add(v);
  if (Array.isArray(v)) {
    const parts = v.slice(0, 100).map((x, i) => {
      const s = insp(x, depth - 1, seen, indent + 1);
      return `${i in v ? "" : "…"}${s}`.trim();
    });
    return `[ ${parts.join(", ")}${v.length > 100 ? ", …" : ""} ]`;
  }
  if (v instanceof Map) {
    const parts = [...v.entries()].slice(0, 50).map(([k, val]) =>
      `${insp(k, depth - 1, seen, indent + 1)} => ${insp(val, depth - 1, seen, indent + 1)}`);
    return `Map(${v.size}) { ${parts.join(", ")} }`;
  }
  if (v instanceof Set) {
    const parts = [...v.values()].slice(0, 50).map((x) => insp(x, depth - 1, seen, indent + 1));
    return `Set(${v.size}) { ${parts.join(", ")} }`;
  }
  const tag = v[Symbol.toStringTag] || v.constructor?.name;
  try {
    const keys = Reflect.ownKeys(v).slice(0, 50);
    const parts = keys.map((k) => {
      let val;
      try { val = v[k]; } catch { val = "<getter threw>"; }
      const ks = typeof k === "symbol" ? k.toString() : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      return `${ks}: ${insp(val, depth - 1, seen, indent + 1)}`;
    });
    const pre = tag && tag !== "Object" ? `${tag} ` : "";
    if (!parts.length) return pre + "{}";
    if (parts.join("").length < 70) return `${pre}{ ${parts.join(", ")} }`;
    return `${pre}{\n${pad}${parts.join(",\n" + pad)}\n${padEnd}}`;
  } catch { return String(v); }
}
inspect.defaultOptions = { depth: 2 };
inspect.styles = {};
inspect.custom = Symbol.for("nodejs.util.inspect.custom");

export function promisify(orig) {
  const fn = function (...args) {
    return new Promise((resolve, reject) => {
      orig.call(this, ...args, (err, ...res) => {
        if (err) reject(err);
        else resolve(res.length <= 1 ? res[0] : res);
      });
    });
  };
  Object.setPrototypeOf(fn, Object.getPrototypeOf(orig));
  return fn;
}
promisify.custom = Symbol.for("nodejs.promisify.custom");

export function callbackify(orig) {
  return function (...args) {
    const cb = args.pop();
    Promise.resolve().then(() => orig.apply(this, args))
      .then((r) => cb(null, r), (e) => cb(e));
  };
}

export const types = {
  isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer,
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isDate: (v) => v instanceof Date,
  isPromise: (v) => v && typeof v.then === "function",
  isRegExp: (v) => v instanceof RegExp,
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
  isError: (v) => v instanceof Error,
  isBigInt64Array: (v) => v?.constructor?.name === "BigInt64Array",
  isSymbolObject: (v) => typeof v === "symbol",
};
export const isDate = types.isDate;
export const isRegExp = types.isRegExp;
export const isPromise = types.isPromise;
export const isArray = Array.isArray;

export function deprecate(fn, msg) {
  let warned = false;
  return function (...args) {
    if (!warned) { process.emitWarning(msg, "DeprecationWarning"); warned = true; }
    return fn.apply(this, args);
  };
}

export const debuglog = (ns) => () => {};
export const debug = debuglog;

export function inherits(ctor, superCtor) {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  ctor.super_ = superCtor;
}

export function isDeepStrictEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Reflect.ownKeys(a), kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => isDeepStrictEqual(a[k], b[k]));
}

export function stripVTControlCharacters(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

export function parseArgs() { return { values: {}, positionals: [] }; }
export function getSystemErrorName(err) { return String(err); }
export function styleText(_, s) { return s; }
export function toUSVString(s) { return String(s); }
export const MIMEType = class MIMEType {};
export const Log = class Log {};
export const Transferable = class {};
export const aborted = (signal, obj) => signal.aborted;
export const exposeGhost = false;

export function once(emitter, name) {
  return new Promise((resolve, reject) => {
    const off = () => { emitter.removeListener?.(name, onE); emitter.removeListener?.("error", onErr); };
    const onE = (...a) => { off(); resolve(a.length > 1 ? a : a[0]); };
    const onErr = (e) => { off(); reject(e); };
    emitter.once(name, onE);
    if (name !== "error") emitter.once?.("error", onErr);
  });
}

export default { format, inspect, promisify, callbackify, types, deprecate, debuglog,
  inherits, isDeepStrictEqual, stripVTControlCharacters, once, isDate, isRegExp };
