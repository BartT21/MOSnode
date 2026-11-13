// mosnode bootstrap: process, timers, console. Runs before the entry module.
import * as N from "native";

const g = globalThis;
g.global = g;

// ---- process ----
const _exitListeners = [];
const _events = { listeners: {} };
function simpleEmit(name, ...args) {
  (_events.listeners[name] || []).slice().forEach((fn) => fn(...args));
}

const process = {
  argv: N.argv,
  execArgv: N.execArgv,
  execPath: N.execPath,
  env: new Proxy({}, {
    get(t, k) { return typeof k === "string" ? N.getenv(k) : undefined; },
    set(t, k, v) { N.setenv(k, String(v)); return true; },
    has(t, k) { return N.getenv(k) !== undefined; },
    deleteProperty(t, k) { N.unsetenv(k); return true; },
    ownKeys() { return Reflect.ownKeys(N.environ()); },
    getOwnPropertyDescriptor(t, k) {
      const v = N.getenv(k);
      return v === undefined ? undefined : { enumerable: true, configurable: true, value: v };
    },
  }),
  pid: N.procInfo.pid,
  ppid: N.procInfo.ppid,
  platform: N.platform,
  arch: N.arch,
  version: "v22.12.0-mosnode",
  versions: { ...N.versions, node: "22.12.0" },
  release: { name: "node", sourceUrl: "", headersUrl: "" },
  _cwd: N.procInfo.cwd,
  cwd() { return this._cwd; },
  chdir(p) {
    // No native chdir; track the logical cwd (absolute, or joined if relative).
    p = String(p);
    this._cwd = p.charCodeAt(0) === 47 ? p : (this._cwd.replace(/\/+$/, "") + "/" + p);
  },
  exitCode: undefined,
  exit(code) { simpleEmit("exit", code ?? process.exitCode ?? 0); N.exit(code ?? process.exitCode ?? 0); },
  hrtime: N.hrtime,
  memoryUsage: N.memoryUsage,
  uptime: N.uptime,
  umask: N.umask,
  kill: N.kill,
  nextTick(fn, ...args) {
    N.immediate(() => fn(...args));
  },
  emitWarning(msg, type) {
    console.error(`(node:${process.pid}) ${type || "Warning"}: ${msg}`);
  },
  stdout: undefined,
  stderr: undefined,
  stdin: undefined,
  on(name, fn) { (_events.listeners[name] ||= []).push(fn); return process; },
  once(name, fn) { const h = (...a) => { off(name, h); fn(...a); }; (_events.listeners[name] ||= []).push(h); return process; },
  off(name, fn) { const l = _events.listeners[name]; if (l) _events.listeners[name] = l.filter((f) => f !== fn); return process; },
  addListener: null, removeListener: null, listeners(name) { return (_events.listeners[name] || []).slice(); },
  removeAllListeners(name) { if (name) _events.listeners[name] = []; else _events.listeners = {}; return process; },
  emit: simpleEmit,
  _events: _events.listeners,
  binding(name) { throw new Error(`process.binding('${name}') is not supported`); },
  features: { inspector: false, uv: true, tls: true },
  report: { getReport: () => ({ header: { hostName: N.hostname() } }), writeReport: () => "" },
  allowedNodeEnvironmentFlags: new Set(),
};
process.addListener = process.on;
process.removeListener = process.off;
process.hrtime = function hrtime(t) {
  const ns = N.hrtime();
  if (t) {
    let d = ns - t[0] * 1e9 - t[1];
    if (d < 0n) d += 0n;
    return [Number(d / 1000000n), Number(d % 1000000n)];
  }
  return [Number(ns / 1000000n), Number(ns % 1000000n)];
};
process.hrtime.bigint = () => N.hrtime();

// lazy stdio
Object.defineProperty(process, "stdout", { get() {
  const s = makeStdio(1); Object.defineProperty(process, "stdout", { value: s }); return s; }, configurable: true });
Object.defineProperty(process, "stderr", { get() {
  const s = makeStdio(2); Object.defineProperty(process, "stderr", { value: s }); return s; }, configurable: true });
Object.defineProperty(process, "stdin", { get() {
  const s = makeStdio(0); Object.defineProperty(process, "stdin", { value: s }); return s; }, configurable: true });

function makeStdio(fd) {
  try {
    // _stdio.js is provided by the lib layer
    const m = N.requireModule("_stdio", N.mainModule);
    return m.createStdio(fd);
  } catch {
    return {
      fd,
      write(s) { N.fsWrite(fd, typeof s === "string" ? s : String(s)); return true; },
      end() {},
      on() {}, once() {}, destroySoon() {}, destroy() {},
      isTTY: N.isatty(fd),
      columns: (N.ttyGetWindowSize(fd) || [80, 24])[0],
      rows: (N.ttyGetWindowSize(fd) || [80, 24])[1],
    };
  }
}

g.process = process;

// Real WebAssembly, backed by the native wasm3 bridge (lib/webassembly.js).
// cli.js's Ink/Yoga layout and llhttp need it; without it the full TUI cannot render.
try {
  g.WebAssembly = (await import("./webassembly.js")).default;
} catch (e) {
  process.stderr && process.stderr.write("mosnode: WebAssembly init failed: " + (e && e.message) + "\n");
}

// ---- timers ----
class Timeout {
  constructor(h) { this._h = h; }
  ref() { N.ref(this._h); return this; }
  unref() { N.unref(this._h); return this; }
  hasRef() { return N.hasRef(this._h); }
  refresh() { N.timerRestart(this._h, this._ms); return this; }
  [Symbol.toPrimitive]() { return this._h; }
}
class Immediate {
  constructor(h) { this._h = h; }
  ref() { N.ref(this._h); return this; }
  unref() { N.unref(this._h); return this; }
  hasRef() { return N.hasRef(this._h); }
  [Symbol.toPrimitive]() { return this._h; }
}

function setTimeout(fn, ms = 1, ...args) {
  const t = new Timeout(N.timerStart(+ms || 0, 0, () => fn(...args)));
  t._ms = +ms || 0;
  return t;
}
function setInterval(fn, ms = 1, ...args) {
  const t = new Timeout(N.timerStart(+ms || 1, +ms || 1, () => fn(...args)));
  t._ms = +ms || 1;
  return t;
}
function setImmediate(fn, ...args) {
  return new Immediate(N.immediate(() => fn(...args)));
}
// Node's clear* are safe no-ops on an already-fired/stale timer. mosnode's
// N.close throws "invalid handle" on a closed handle, which — thrown from a
// promise chain in cli.js — becomes an unhandled rejection that kills the app.
// Swallow it so clearing a dead timer is a no-op, like Node.
function clearTimeout(t) { if (t != null) { try { N.close(t._h ?? t); } catch {} } }
function clearInterval(t) { if (t != null) { try { N.close(t._h ?? t); } catch {} } }
function clearImmediate(t) { if (t != null) { try { N.close(t._h ?? t); } catch {} } }

g.setTimeout = setTimeout;
g.setInterval = setInterval;
g.setImmediate = setImmediate;
g.clearTimeout = clearTimeout;
g.clearInterval = clearInterval;
g.clearImmediate = clearImmediate;
g.queueMicrotask = queueMicrotask;

// ---- minimal console (replaced by _globals.js when present) ----
const kColors = { error: "\x1b[31m", warn: "\x1b[33m" };
g.console = {
  log(...a) { process.stdout.write(fmt(a) + "\n"); },
  info(...a) { process.stdout.write(fmt(a) + "\n"); },
  warn(...a) { process.stderr.write(fmt(a, true) + "\n"); },
  error(...a) { process.stderr.write(fmt(a, true) + "\n"); },
  debug(...a) { process.stderr.write(fmt(a) + "\n"); },
  trace(...a) { process.stderr.write("Trace: " + fmt(a, true) + "\n"); },
  dir(o) { process.stdout.write(inspectSimple(o) + "\n"); },
};
function fmt(args) {
  return args.map((a) => (typeof a === "string" ? a : inspectSimple(a))).join(" ");
}
function inspectSimple(v, depth = 2) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "number" || t === "boolean" || t === "bigint") return String(v);
  if (t === "function") return `[Function: ${v.name || "anonymous"}]`;
  if (t === "symbol") return v.toString();
  if (t === "string") return depth === 2 ? v : `'${v}'`;
  if (Array.isArray(v)) return "[" + v.slice(0, 100).map((x) => inspectSimple(x, depth - 1)).join(", ") + "]";
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  try {
    const ks = Object.keys(v).slice(0, 50);
    return "{" + ks.map((k) => `${k}: ${inspectSimple(v[k], depth - 1)}`).join(", ") + "}";
  } catch { return String(v); }
}

// ---- promise rejection handling ----
// Node semantics: a rejection reported "unhandled" is only surfaced after a
// turn, because a .catch may attach late (the engine then reports "handled").
// We defer, let "handled" cancel it, emit process 'unhandledRejection' so the
// app can intercept, and only print/exit for truly-unhandled ones.
const _pendingRejections = new Map();
N.setRejectionHandler((mode, promise, reason) => {
  if (mode === "handled") {
    if (_pendingRejections.delete(promise)) simpleEmit("rejectionHandled", promise);
    return;
  }
  // mode === "unhandled"
  _pendingRejections.set(promise, reason);
  queueMicrotask(() => {
    if (!_pendingRejections.has(promise)) return; // cancelled by a late .catch
    _pendingRejections.delete(promise);
    if (process.listenerCount && process.listenerCount("unhandledRejection") > 0) {
      simpleEmit("unhandledRejection", reason, promise);
      return;
    }
    process.stderr.write("Unhandled promise rejection [" + (reason && reason.name) + "][" + (reason && reason.message) + "][" + (reason && reason.code) + "]: " + inspectSimple(reason) + "\n");
    process.exitCode ??= 1;
  });
});
N.setBeforeExitHandler(() => {
  simpleEmit("beforeExit", process.exitCode ?? 0);
});

// ---- rich globals from the lib layer ----
try {
  await import("./_globals.js");
} catch (e) {
  if (String(e?.message || e).includes("Cannot find module")) {
    // no _globals.js yet: keep the minimal console
  } else {
    process.stderr.write("mosnode: _globals.js failed [" + (e && e.name) + "][" + (e && e.message) + "]: " + inspectSimple(e) + "\n");
  }
}
