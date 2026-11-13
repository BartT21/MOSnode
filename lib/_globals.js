// Rich globals: Buffer, TextEncoder/Decoder, URL, atob/btoa, performance, console.
import * as N from "native";
import BufferLib from "./buffer.js";
import URLLib from "./_vendor/whatwg_url.js";
import "./_intl.js"; // Intl polyfill when the engine lacks ICU
import "./_fetch.js"; // fetch/Headers/Request/Response/Blob/FormData globals
import "./_webapis.js"; // crypto (Web Crypto), AbortSignal.any, navigator, MessageChannel

const g = globalThis;

export const Buffer = BufferLib;
g.Buffer = Buffer;
N.setBufferPrototype(Buffer.prototype);

g.TextEncoder = class TextEncoder {
  encode(s = "") { return N.utf8Encode(String(s)); }
  get encoding() { return "utf-8"; }
};
g.TextDecoder = class TextDecoder {
  constructor(label = "utf-8") {
    label = String(label).toLowerCase();
    if (!["utf-8", "utf8"].includes(label)) throw new RangeError(`Unsupported encoding: ${label}`);
  }
  decode(buf, opts) {
    if (buf === undefined || buf === null) return "";
    let b = buf;
    if (b.buffer instanceof ArrayBuffer) { // typed array view: respect bounds
      const view = b.byteOffset !== undefined || b.byteLength !== b.buffer.byteLength;
      if (view) return N.utf8Decode(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    }
    return N.utf8Decode(buf) ?? "";
  }
  get encoding() { return "utf-8"; }
};

g.URL = URLLib.URL;
g.URLSearchParams = URLLib.URLSearchParams;

g.btoa = (s) => N.base64Encode(N.latin1Encode(String(s)));
g.atob = (s) => N.latin1Decode(N.base64Decode(String(s)));

const _perfMarks = new Map();
const _perfEntries = [];
g.performance = {
  now: () => N.now(),
  timeOrigin: N.timeOrigin,
  mark(name, opts) {
    const e = { name, entryType: "mark", startTime: N.now(), duration: 0, detail: opts && opts.detail };
    _perfMarks.set(name, e); _perfEntries.push(e); return e;
  },
  measure(name, startMark, endMark) {
    const s = typeof startMark === "string" ? (_perfMarks.get(startMark)?.startTime ?? 0) : (startMark && startMark.start) || 0;
    const en = typeof endMark === "string" ? (_perfMarks.get(endMark)?.startTime ?? N.now()) : (endMark && endMark.end) || N.now();
    const e = { name, entryType: "measure", startTime: s, duration: en - s };
    _perfEntries.push(e); return e;
  },
  clearMarks(name) { if (name != null) { _perfMarks.delete(name); for (let i = _perfEntries.length - 1; i >= 0; i--) if (_perfEntries[i].entryType === "mark" && _perfEntries[i].name === name) _perfEntries.splice(i, 1); } else { _perfMarks.clear(); for (let i = _perfEntries.length - 1; i >= 0; i--) if (_perfEntries[i].entryType === "mark") _perfEntries.splice(i, 1); } },
  clearMeasures(name) { for (let i = _perfEntries.length - 1; i >= 0; i--) if (_perfEntries[i].entryType === "measure" && (name == null || _perfEntries[i].name === name)) _perfEntries.splice(i, 1); },
  getEntries() { return _perfEntries.slice(); },
  getEntriesByName(name, type) { return _perfEntries.filter((e) => e.name === name && (!type || e.entryType === type)); },
  getEntriesByType(type) { return _perfEntries.filter((e) => e.entryType === type); },
  clearResourceTimings() {},
  eventLoopUtilization() { return { idle: 0, active: 0, utilization: 0 }; },
  nodeTiming: { name: "node", entryType: "node", startTime: 0, duration: 0 },
  timing: {},
  markResourceTiming() {},
  setResourceTimingBufferSize() {},
};

g.structuredClone = (v) => JSON.parse(JSON.stringify(v));

// AbortController / EventTarget / Event (small but sufficient)
class Event {
  constructor(type, opts = {}) { this.type = type; this.defaultPrevented = false; Object.assign(this, opts); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}
class EventTarget {
  constructor() { this._l = {}; }
  addEventListener(t, fn) { (this._l[t] ||= new Set()).add(fn); }
  removeEventListener(t, fn) { this._l[t]?.delete(fn); }
  dispatchEvent(e) {
    (this._l[e.type] || []).forEach((fn) => fn.call(this, e));
    return !e.defaultPrevented;
  }
}
class AbortSignal extends EventTarget {
  constructor() { super(); this.aborted = false; this.reason = undefined; this.onabort = null; }
  get [Symbol.toStringTag]() { return "AbortSignal"; }
  _abort(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason ?? new Error("This operation was aborted");
    if (this.onabort) this.onabort(new Event("abort"));
    this.dispatchEvent(new Event("abort"));
  }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  static abort(reason) { const s = new AbortSignal(); s._abort(reason); return s; }
  static timeout(ms) {
    const s = new AbortSignal();
    setTimeout(() => s._abort(new Error("The operation was aborted due to timeout")), ms).unref?.();
    return s;
  }
  static any(signals) {
    const s = new AbortSignal();
    for (const src of signals) {
      if (!src) continue;
      if (src.aborted) { s._abort(src.reason); break; }
      src.addEventListener("abort", () => s._abort(src.reason), { once: true });
    }
    return s;
  }
}
class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) { this.signal._abort(reason); }
}
g.EventTarget = EventTarget;
g.Event = Event;
g.AbortController = AbortController;
g.AbortSignal = AbortSignal;

// console with util.format when util is available
let format;
try {
  const util = N.requireModule("util", N.mainModule);
  format = util.format;
  if (util.inspect) console.dir = (o, opts) => process.stdout.write(util.inspect(o, opts) + "\n");
} catch { format = null; }

const fmtArgs = (args) => format
  ? format(...args)
  : args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");

g.console = {
  log: (...a) => process.stdout.write(fmtArgs(a) + "\n"),
  info: (...a) => process.stdout.write(fmtArgs(a) + "\n"),
  debug: (...a) => process.stdout.write(fmtArgs(a) + "\n"),
  warn: (...a) => process.stderr.write(fmtArgs(a) + "\n"),
  error: (...a) => process.stderr.write(fmtArgs(a) + "\n"),
  trace: (...a) => process.stderr.write("Trace: " + fmtArgs(a) + "\n"),
  dir: (o, opts) => process.stdout.write(String(o) + "\n"),
  table: (o) => process.stdout.write(fmtArgs([o]) + "\n"),
  time: () => {}, timeEnd: () => {},
  assert: (c, ...a) => { if (!c) process.stderr.write("Assertion failed: " + fmtArgs(a) + "\n"); },
  count: () => {}, group: () => {}, groupEnd: () => {},
  clear: () => process.stdout.write("\x1b[2J\x1b[H"),
};

// Web streams from vendor
try {
  const ws = await import("./_vendor/web_streams.js");
  g.ReadableStream = ws.ReadableStream;
  g.WritableStream = ws.WritableStream;
  g.TransformStream = ws.TransformStream;
  g.ByteLengthQueuingStrategy = ws.ByteLengthQueuingStrategy;
  g.CountQueuingStrategy = ws.CountQueuingStrategy;
} catch {}
