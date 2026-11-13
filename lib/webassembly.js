// node/global `WebAssembly` implemented over the native wasm3 bridge (N.wasm*).
// Enough surface for cli.js's consumers: llhttp (HTTP parsing) and Yoga (Ink
// layout). cli.js uses only Module, Instance, compile, instantiate, validate.
import * as N from "native";

function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
  return new Uint8Array(b);
}

function flattenImports(obj) {
  const flat = {};
  if (obj) for (const mod of Object.keys(obj)) {
    const m = obj[mod];
    if (m && typeof m === "object") {
      for (const f of Object.keys(m)) {
        if (typeof m[f] === "function") flat[mod + "." + f] = m[f];
      }
    }
  }
  return flat;
}

function makeExports(iid) {
  const cache = { __proto__: null };
  return new Proxy(cache, {
    get(t, name) {
      if (typeof name !== "string") return t[name];
      if (name in t) return t[name];
      if (name === "memory") {
        const buf = N.wasmMemory(iid);
        const mem = buf ? { buffer: buf } : undefined;
        t.memory = mem;
        return mem;
      }
      if (N.wasmHasExport(iid, name)) {
        const fn = (...args) => N.wasmCall(iid, name, args);
        t[name] = fn;
        return fn;
      }
      return undefined;
    },
    has(t, name) {
      return name === "memory" || (typeof name === "string" && N.wasmHasExport(iid, name));
    },
  });
}

export class Module {
  constructor(bytes) {
    this._id = N.wasmCompile(toBytes(bytes));
  }
}

export class Instance {
  constructor(module, importObject) {
    if (!(module instanceof Module)) throw new TypeError("WebAssembly.Instance: Module expected");
    this._id = N.wasmInstantiate(module._id, flattenImports(importObject));
    this.exports = makeExports(this._id);
  }
}

export function compile(bytes) {
  return Promise.resolve().then(() => new Module(bytes));
}

export function instantiate(src, importObject) {
  return Promise.resolve().then(() => {
    if (src instanceof Module) return new Instance(src, importObject);
    const module = new Module(src);
    const instance = new Instance(module, importObject);
    return { module, instance };
  });
}

export function validate(bytes) {
  try { new Module(bytes); return true; } catch { return false; }
}

const WebAssembly = { Module, Instance, compile, instantiate, validate };
export default WebAssembly;
