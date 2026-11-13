import * as N from "native";
import * as path from "./path.js";
export function createRequire(filename) {
  const parent = typeof filename === "string" ? filename : filename?.filename || process.cwd() + "/";
  const cache = globalThis.__mos_require_cache ||= {};
  return function require(spec) {
    if (spec === "node:events" || spec === "events" || N.isBuiltin(spec)) {
      const ns = N.requireModule(spec, parent);
      return ns.default ?? ns;
    }
    const resolved = N.resolveModule(spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")
      ? path.resolve(path.dirname(parent.endsWith("/") ? parent : parent), spec)
      : spec, parent);
    if (cache[resolved]) return cache[resolved].exports;
    const src = N.fsReadFile(resolved);
    const module_ = { exports: {} };
    cache[resolved] = module_;
    const srcText = N.utf8Decode(src);
    const dirname = path.dirname(resolved);
    const wrapper = N.evalScript(`(function (exports, require, module, __filename, __dirname) {\n${srcText}\n})`, resolved);
    wrapper(module_.exports, createRequire(resolved), module_, resolved, dirname);
    return module_.exports;
  };
}
export const builtinModules = ["fs", "path", "os", "util", "events", "crypto", "zlib",
  "child_process", "stream", "url", "querystring", "string_decoder", "assert", "timers", "module"];
export const isBuiltin = (m) => N.isBuiltin(m);
export const syncBuiltinESMExports = () => {};
export default { createRequire, builtinModules, isBuiltin };
