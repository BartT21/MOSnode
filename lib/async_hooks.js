// node:async_hooks — AsyncLocalStorage with real async-context propagation.
// The "current frame" (a Map of AsyncLocalStorage -> value) lives in the native
// layer (asyncCtxGet/asyncCtxSet). QuickJS promise hooks carry it across
// await/.then automatically; for non-promise scheduling (timers, microtasks,
// nextTick) we capture-and-restore the frame by wrapping the callback.
import * as N from "native";

function getFrame() { return N.asyncCtxGet(); }
function setFrame(f) { N.asyncCtxSet(f); }

function bindFrame(fn) {
  if (typeof fn !== "function") return fn;
  const captured = N.asyncCtxGet();
  return function bound(...args) {
    const prev = N.asyncCtxGet();
    N.asyncCtxSet(captured);
    try { return fn.apply(this, args); } finally { N.asyncCtxSet(prev); }
  };
}

let patched = false;
function installPatches() {
  if (patched) return; patched = true;
  const g = globalThis;
  // Timers + microtasks are not promise reactions, so the promise hook doesn't
  // cover them — wrap their callbacks to carry the frame.
  if (typeof g.queueMicrotask === "function") {
    const q = g.queueMicrotask.bind(g);
    g.queueMicrotask = (cb) => q(bindFrame(cb));
  }
  for (const name of ["setTimeout", "setInterval", "setImmediate"]) {
    const orig = g[name];
    if (typeof orig === "function") {
      g[name] = function (cb, ...rest) { return orig.call(this, typeof cb === "function" ? bindFrame(cb) : cb, ...rest); };
    }
  }
  if (g.process && typeof g.process.nextTick === "function") {
    const nt = g.process.nextTick.bind(g.process);
    g.process.nextTick = (cb, ...a) => nt(bindFrame(cb), ...a);
  }
}
installPatches();

export class AsyncLocalStorage {
  constructor() {}
  run(store, cb, ...args) {
    const prev = getFrame();
    const next = new Map(prev || undefined);
    next.set(this, store);
    setFrame(next);
    try { return cb(...args); } finally { setFrame(prev); }
  }
  enterWith(store) {
    const next = new Map(getFrame() || undefined);
    next.set(this, store);
    setFrame(next);
  }
  exit(cb, ...args) {
    const prev = getFrame();
    const next = new Map(prev || undefined);
    next.delete(this);
    setFrame(next);
    try { return cb(...args); } finally { setFrame(prev); }
  }
  getStore() { const f = getFrame(); return f ? f.get(this) : undefined; }
  disable() { const f = getFrame(); if (f) f.delete(this); }
  static bind(fn) { return bindFrame(fn); }
  static snapshot() {
    const captured = getFrame();
    return (cb, ...a) => { const prev = getFrame(); setFrame(captured); try { return cb(...a); } finally { setFrame(prev); } };
  }
}

export class AsyncResource {
  constructor(type, opts) { this.type = type; this._opts = opts; this._frame = getFrame(); }
  runInAsyncScope(fn, thisArg, ...args) {
    const prev = getFrame(); setFrame(this._frame);
    try { return fn.apply(thisArg, args); } finally { setFrame(prev); }
  }
  bind(fn) { return bindFrame(fn); }
  emitDestroy() { return this; }
  asyncId() { return 0; }
  triggerAsyncId() { return 0; }
  static bind(fn) { return bindFrame(fn); }
}

export function executionAsyncId() { return 0; }
export function triggerAsyncId() { return 0; }
export function executionAsyncResource() { return {}; }
export function createHook() {
  return { enable() { return this; }, disable() { return this; } };
}

export default {
  AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId,
  executionAsyncResource, createHook,
};
