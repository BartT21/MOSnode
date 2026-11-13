// node:path (posix only — MorphOS/Kali are posix)
function assertPath(p) {
  if (typeof p !== "string") throw new TypeError(`Path must be a string. Received ${String(p)}`);
}

export const sep = "/";
export const delimiter = ":";

export function normalize(p) {
  assertPath(p);
  if (!p) return ".";
  const isAbs = p.charCodeAt(0) === 47;
  const trailing = p.charCodeAt(p.length - 1) === 47;
  const parts = p.split("/").filter((x) => x && x !== ".");
  const out = [];
  for (const part of parts) {
    if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!isAbs) out.push(".."); }
    else out.push(part);
  }
  let res = (isAbs ? "/" : "") + out.join("/");
  if (!res) res = isAbs ? "/" : ".";
  if (trailing && res !== "/") res += "/";
  return res;
}

export function isAbsolute(p) { assertPath(p); return p.length > 0 && p.charCodeAt(0) === 47; }

export function join(...args) {
  if (args.length === 0) return ".";
  const joined = args.filter((a) => a != null && a !== "").join("/");
  if (!joined) return ".";
  return normalize(joined);
}

export function resolve(...args) {
  let resolved = "";
  let abs = false;
  for (let i = args.length - 1; i >= -1 && !abs; i--) {
    const p = i >= 0 ? args[i] : process.cwd();
    assertPath(p);
    if (p) {
      resolved = resolved ? p + "/" + resolved : p;
      abs = p.charCodeAt(0) === 47;
    }
  }
  resolved = normalize(resolved);
  if (!abs) throw new TypeError("Resolved path is not absolute");
  // Node's resolve never keeps a trailing slash (except the root "/").
  if (resolved.length > 1 && resolved.charCodeAt(resolved.length - 1) === 47)
    resolved = resolved.slice(0, -1);
  return resolved.length ? resolved : "/";
}

export function relative(from, to) {
  assertPath(from); assertPath(to);
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";
  const fa = from.split("/"), ta = to.split("/");
  let i = 0;
  while (i < fa.length && i < ta.length && fa[i] === ta[i]) i++;
  const up = fa.slice(i).map(() => "..");
  return [...up, ...ta.slice(i)].join("/") || ".";
}

export function dirname(p) {
  assertPath(p);
  if (p === "") return ".";
  const rootEnd = p.charCodeAt(0) === 47 ? 1 : 0;
  let end = -1;
  for (let i = p.length - 1; i >= rootEnd; i--) {
    if (p.charCodeAt(i) === 47) { if (end !== -1) break; end = i; }
  }
  if (end === -1) return rootEnd ? "/" : ".";
  return rootEnd === 1 && end === 1 ? "/" : p.slice(0, end);
}

const splitRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^/]+?|)(?:\.[^./]*|))$/;
export function basename(p, ext) {
  assertPath(p);
  if (ext !== undefined) assertPath(ext);
  let b = splitRe.exec(p)[3];
  if (ext && b.slice(-ext.length) === ext && b.length > ext.length) b = b.slice(0, -ext.length);
  return b;
}

export function extname(p) {
  assertPath(p);
  const b = splitRe.exec(p)[3];
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}

export function parse(p) {
  assertPath(p);
  const root = p.startsWith("/") ? "/" : "";
  const dir = dirname(p);
  const base = basename(p);
  const ext = extname(p);
  const name = ext ? base.slice(0, base.length - ext.length) : base;
  return { root, dir, base, ext, name };
}

export function format(o) {
  if (o === null || typeof o !== "object") throw new TypeError("expected object");
  const dir = o.dir || o.root || "";
  const base = o.base || (o.name || "") + (o.ext || "");
  return dir ? (dir.endsWith("/") ? dir + base : dir + "/" + base) : base;
}

import win32 from "./path/win32.js";

export const toNamespacedPath = (p) => p;

const posix = { sep, delimiter, normalize, isAbsolute, join, resolve, relative,
  dirname, basename, extname, parse, format, posix: null, win32, toNamespacedPath };
posix.posix = posix;
export { posix, win32 };
export default posix;
