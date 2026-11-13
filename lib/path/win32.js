// node:path/win32 — Windows path semantics (backslash sep, drive letters,
// UNC). mosnode runs on posix, so this is only exercised by cross-platform
// code paths, but it behaves correctly if called.
const CHAR_BACKSLASH = 92, CHAR_FORWARD = 47, CHAR_COLON = 58, CHAR_DOT = 46;
function isSep(c) { return c === CHAR_BACKSLASH || c === CHAR_FORWARD; }
function isLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function assertPath(p) { if (typeof p !== "string") throw new TypeError(`Path must be a string. Received ${String(p)}`); }

export const sep = "\\";
export const delimiter = ";";

// Normalize a string of path components, collapsing . and .. (shared helper).
function normalizeString(path, allowAboveRoot) {
  let res = "", lastSegLen = 0, lastSlash = -1, dots = 0, code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isSep(code)) break;
    else code = CHAR_FORWARD;
    if (isSep(code)) {
      if (lastSlash === i - 1 || dots === 1) { /* skip */ }
      else if (dots === 2) {
        if (res.length < 2 || lastSegLen !== 2 || res.charCodeAt(res.length - 1) !== CHAR_DOT || res.charCodeAt(res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const li = res.lastIndexOf("\\");
            if (li === -1) { res = ""; lastSegLen = 0; } else { res = res.slice(0, li); lastSegLen = res.length - 1 - res.lastIndexOf("\\"); }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) { res = ""; lastSegLen = 0; lastSlash = i; dots = 0; continue; }
        }
        if (allowAboveRoot) { res += res.length > 0 ? "\\.." : ".."; lastSegLen = 2; }
      } else {
        if (res.length > 0) res += "\\" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegLen = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) dots++;
    else dots = -1;
  }
  return res;
}

export function isAbsolute(p) {
  assertPath(p);
  const len = p.length;
  if (len === 0) return false;
  const c = p.charCodeAt(0);
  if (isSep(c)) return true;
  if (isLetter(c) && len > 2 && p.charCodeAt(1) === CHAR_COLON && isSep(p.charCodeAt(2))) return true;
  return false;
}

export function normalize(p) {
  assertPath(p);
  if (p.length === 0) return ".";
  let device = "", isAbs = false, rootEnd = 0;
  const c0 = p.charCodeAt(0);
  if (p.length > 1 && isLetter(c0) && p.charCodeAt(1) === CHAR_COLON) {
    device = p.slice(0, 2); rootEnd = 2;
    if (p.length > 2 && isSep(p.charCodeAt(2))) { isAbs = true; rootEnd = 3; }
  } else if (isSep(c0)) { isAbs = true; rootEnd = 1; }
  let tail = rootEnd < p.length ? normalizeString(p.slice(rootEnd), !isAbs) : "";
  if (tail.length === 0 && !isAbs) tail = ".";
  if (tail.length > 0 && isSep(p.charCodeAt(p.length - 1))) tail += "\\";
  return device + (isAbs ? "\\" : "") + tail;
}

export function join(...args) {
  if (args.length === 0) return ".";
  let joined;
  for (const a of args) {
    assertPath(a);
    if (a.length > 0) joined = joined === undefined ? a : joined + "\\" + a;
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

export function resolve(...args) {
  let resolvedDevice = "", resolvedTail = "", resolvedAbsolute = false;
  for (let i = args.length - 1; i >= -1; i--) {
    const p = i >= 0 ? args[i] : process.cwd();
    assertPath(p);
    if (p.length === 0) continue;
    resolvedTail = p + "\\" + resolvedTail;
    resolvedAbsolute = isAbsolute(p);
    if (resolvedAbsolute) break;
  }
  resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute);
  return resolvedDevice + (resolvedAbsolute ? "\\" : "") + resolvedTail || ".";
}

export function relative(from, to) {
  assertPath(from); assertPath(to);
  if (from === to) return "";
  from = resolve(from); to = resolve(to);
  if (from === to) return "";
  const fa = from.toLowerCase().split("\\").filter(Boolean);
  const ta = to.split("\\").filter(Boolean);
  const taLower = to.toLowerCase().split("\\").filter(Boolean);
  let i = 0;
  while (i < fa.length && i < taLower.length && fa[i] === taLower[i]) i++;
  const up = fa.slice(i).map(() => "..");
  return [...up, ...ta.slice(i)].join("\\");
}

export function dirname(p) {
  assertPath(p);
  if (p.length === 0) return ".";
  let end = -1, rootEnd = 0;
  if (p.length >= 2 && isLetter(p.charCodeAt(0)) && p.charCodeAt(1) === CHAR_COLON) rootEnd = 2;
  for (let i = p.length - 1; i > rootEnd; i--) {
    if (isSep(p.charCodeAt(i))) { end = i; break; }
  }
  if (end === -1) return rootEnd ? p.slice(0, rootEnd) : ".";
  if (end === 0) return "\\";
  return p.slice(0, end);
}

export function basename(p, ext) {
  assertPath(p);
  if (ext !== undefined) assertPath(ext);
  let start = 0;
  if (p.length >= 2 && isLetter(p.charCodeAt(0)) && p.charCodeAt(1) === CHAR_COLON) start = 2;
  let end = p.length;
  while (end > start && isSep(p.charCodeAt(end - 1))) end--;
  let begin = start;
  for (let i = end - 1; i >= start; i--) { if (isSep(p.charCodeAt(i))) { begin = i + 1; break; } }
  let b = p.slice(begin, end);
  if (ext && b.slice(-ext.length) === ext && b.length > ext.length) b = b.slice(0, -ext.length);
  return b;
}

export function extname(p) {
  assertPath(p);
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}

export function parse(p) {
  assertPath(p);
  let root = "";
  if (p.length >= 2 && isLetter(p.charCodeAt(0)) && p.charCodeAt(1) === CHAR_COLON) {
    root = p.length > 2 && isSep(p.charCodeAt(2)) ? p.slice(0, 3) : p.slice(0, 2);
  } else if (isSep(p.charCodeAt(0))) root = "\\";
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
  if (!dir) return base;
  return dir === o.root ? dir + base : dir + "\\" + base;
}

export const toNamespacedPath = (p) => p;

const win32 = {
  sep, delimiter, normalize, isAbsolute, join, resolve, relative,
  dirname, basename, extname, parse, format, toNamespacedPath,
};
win32.win32 = win32;
export { win32 };
export default win32;
