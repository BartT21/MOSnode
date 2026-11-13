// node:vm — minimal. QuickJS has no separate realms, so a "context" is a
// sandbox object whose properties are injected into the global scope for the
// duration of a run, then synced back and restored. Adequate for evaluating
// trusted config/expressions; it does not provide true isolation.
import * as N from "native";

const CONTEXT = Symbol("vm.context");

export function isContext(obj) { return !!(obj && obj[CONTEXT]); }

export function createContext(sandbox = {}, options) {
  Object.defineProperty(sandbox, CONTEXT, { value: true, enumerable: false, configurable: true });
  return sandbox;
}

function runWithContext(code, context, options) {
  const g = globalThis;
  const filename = (options && (options.filename || options.lineOffset != null)) ? (options.filename || "evalmachine.<anonymous>") : "evalmachine.<anonymous>";
  const keys = context ? Object.keys(context) : [];
  const saved = Object.create(null);
  const had = Object.create(null);
  for (const k of keys) { had[k] = Object.prototype.hasOwnProperty.call(g, k); saved[k] = g[k]; g[k] = context[k]; }
  try {
    const result = N.evalScript(String(code), filename);
    return result;
  } finally {
    // sync possibly-mutated values back into the context, then restore globals
    for (const k of keys) {
      if (context) context[k] = g[k];
      if (had[k]) g[k] = saved[k]; else { try { delete g[k]; } catch { g[k] = undefined; } }
    }
  }
}

export function runInContext(code, context, options) {
  return runWithContext(code, context, options);
}
export function runInNewContext(code, sandbox, options) {
  const ctx = createContext(sandbox || {});
  return runWithContext(code, ctx, options);
}
export function runInThisContext(code, options) {
  const filename = (options && options.filename) || "evalmachine.<anonymous>";
  return N.evalScript(String(code), filename);
}

export class Script {
  constructor(code, options = {}) {
    this.code = String(code);
    this.filename = options.filename || "evalmachine.<anonymous>";
  }
  runInContext(context, options) { return runWithContext(this.code, context, { ...options, filename: this.filename }); }
  runInNewContext(sandbox, options) { return runInNewContext(this.code, sandbox, { ...options, filename: this.filename }); }
  runInThisContext(options) { return N.evalScript(this.code, this.filename); }
}

export function compileFunction(code, params = [], options = {}) {
  const body = `(function(${params.join(",")}){${code}})`;
  return N.evalScript(body, options.filename || "evalmachine.<anonymous>");
}

export const measureMemory = async () => ({ total: { jsMemoryEstimate: 0 } });

export default {
  isContext, createContext, runInContext, runInNewContext, runInThisContext,
  Script, compileFunction, measureMemory,
};
