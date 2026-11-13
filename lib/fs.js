// node:fs — sync + callback APIs over the native module
import * as N from "native";
import { Writable, Readable } from "./stream.js";

// Opt-in diagnostics (set MOSNODE_DEBUG to enable). Claude Code saves its OAuth/
// subscription token to ~/.claude/.credentials.json; when enabled, log every fs
// op that touches that dir/file plus its outcome so a save failure is visible
// after the fact. mkdirSync below also normalizes "directory already exists" to
// a Node-exact EEXIST code regardless of this flag.
const _DEBUG = !!N.getenv("MOSNODE_DEBUG");
const _DEBUG_LOG = (N.getenv("MOSNODE_HOME") || "/Work/mosnode") + "/mosnode-debug.log";
function _credPath(p) {
  return typeof p === "string" && (p.indexOf(".claude") !== -1 || p.indexOf("credentials") !== -1
    || p.indexOf("config") !== -1 || p.endsWith(".json"));
}
function _credLog(line) {
  if (!_DEBUG) return;
  try { N.fsWriteFile(_DEBUG_LOG, line + "\n", "a", 0o666); } catch {}
}

function cbOrPromise(fn) { return typeof fn === "function" ? "cb" : "promise"; }

// ---- sync core (direct native calls) ----
function _isT(p) { try { return /\/tasks\/|\.output$|tool-results/.test(String(p)); } catch { return false; } }
function _tLog(s) { if (!_DEBUG) return; try { N.fsWriteFile(_DEBUG_LOG, "fsT " + s + "\n", "a", 0o666); } catch {} }
const _taskFds = new Set();
// fd -> path for every open fd. cli.js's Bash tool opens the task .output file
// and hands its fd to spawn() as the child's stdout/stderr; the MorphOS shell
// bridge (child_process.js) has no real child, so it looks the fd's path up
// here (synchronously, before cli.js closes the fd) and writes the captured
// command output straight to that file.
const _fdPaths = new Map();
export function fdToPath(fd) { return _fdPaths.get(fd); }
export function openSync(path, flags = "r", mode = 0o666) {
  if (_isT(path)) { try { const fd = N.fsOpen(path, flags, mode); _taskFds.add(fd); if (typeof fd === "number") _fdPaths.set(fd, path); _tLog("openSync OK " + path + " flags=" + flags + " fd=" + fd); return fd; } catch (e) { _tLog("openSync ERR " + path + " flags=" + flags + " code=" + (e && e.code)); throw e; } }
  if (_credPath(path)) _credLog("open       " + path + "  flags=" + flags);
  const fd = N.fsOpen(path, flags, mode);
  if (typeof path === "string" && typeof fd === "number") _fdPaths.set(fd, path);
  return fd;
}
export function closeSync(fd) { if (_taskFds.has(fd)) { _taskFds.delete(fd); _tLog("closeSync fd=" + fd); } _fdPaths.delete(fd); return N.fsClose(fd); }
export function readSync(fd, buffer, offset, length, position) {
  if (offset === undefined) { offset = 0; length = buffer.length - offset; position = null; }
  if (length === undefined && offset !== null) { length = buffer.length - offset; }
  if (position === undefined) position = null;
  const r = N.fsRead(fd, buffer, offset, length, position === null ? -1 : position);
  if (_taskFds.has(fd)) _tLog("readSync fd=" + fd + " req=" + length + " -> " + r);
  return r;
}
export function writeSync(fd, data, offset, length, position) {
  if (_taskFds.has(fd)) _tLog("writeSync fd=" + fd + " datalen=" + (data && data.length) + " type=" + (typeof data));
  if (typeof data === "string") return N.fsWrite(fd, data);
  if (offset === undefined) { offset = 0; length = data.length - offset; }
  if (length === undefined) length = data.length - offset;
  return N.fsWrite(fd, data, offset, length, position === undefined ? -1 : (position ?? -1));
}
// The native fs*stat returns a plain object (mode, size, ...) with NO methods.
// Node's Stats has isFile()/isDirectory()/etc., which cli.js's Read and Glob
// tools call DIRECTLY (so a bare native stat throws "x.isDirectory is not a
// function"). Add them from the mode bits.
function _wrapStat(st) {
  if (!st || typeof st.isDirectory === "function") return st;
  const m = st.mode | 0;
  const is = (mask) => (m & 0o170000) === mask;
  st.isFile = () => is(0o100000);
  st.isDirectory = () => is(0o040000);
  st.isSymbolicLink = () => is(0o120000);
  st.isBlockDevice = () => is(0o060000);
  st.isCharacterDevice = () => is(0o020000);
  st.isFIFO = () => is(0o010000);
  st.isSocket = () => is(0o140000);
  // Node's fs.Stats exposes atime/mtime/ctime/birthtime as Date objects (derived
  // from the *Ms numbers). Native stat only gives the *Ms numbers, so code like
  // cli.js's /resume loader (`stat(f).mtime.getTime()`) throws "not a function"
  // without these — which silently dropped every session ("No conversations
  // found"). Add them.
  if (st.mtime === undefined) {
    const bms = st.birthtimeMs != null ? st.birthtimeMs : st.ctimeMs;
    st.atime = new Date(st.atimeMs || 0);
    st.mtime = new Date(st.mtimeMs || 0);
    st.ctime = new Date(st.ctimeMs || 0);
    st.birthtime = new Date(bms || 0);
    if (st.birthtimeMs == null) st.birthtimeMs = st.ctimeMs || 0;
  }
  return st;
}
export function statSync(path) {
  if (path === "/bin/bash") { return _wrapStat(N.fsStat(N.getenv("MOSNODE_KSH") || "/Work/mosnode/bin/ksh")); }
  if (_credPath(path)) {
    try { const st = _wrapStat(N.fsStat(path)); _credLog("stat OK    " + path + "  size=" + (st && st.size)); return st; }
    catch (e) { _credLog("stat ERR   " + path + "  code=" + (e && e.code)); throw e; }
  }
  return _wrapStat(N.fsStat(path));
}
export function lstatSync(path) {
  // N.fsLstat is absent on the deployed binary -> fall back to stat (identical
  // except for symlinks, which the Read/Glob tools tolerate).
  const _raw = (typeof N.fsLstat === "function") ? N.fsLstat : N.fsStat;
  if (_credPath(path)) {
    try { const st = _wrapStat(_raw(path)); _credLog("lstat OK   " + path + "  size=" + (st && st.size)); return st; }
    catch (e) { _credLog("lstat ERR  " + path + "  code=" + (e && e.code)); throw e; }
  }
  return _wrapStat(_raw(path));
}
export function fstatSync(fd) { return _wrapStat(N.fsFstat(fd)); }
function decorateStat(st) { return _wrapStat(st); }
export class Dirent {
  constructor(name, type, dir) {
    this.name = name;
    this._type = type;
    this.parentPath = dir;
    this.path = dir;
  }
  _t() {
    // Some filesystems return DT_UNKNOWN; resolve lazily via lstat.
    if (this._type === "unknown") {
      try {
        const st = lstatSync((this.parentPath || ".") + "/" + this.name);
        this._type = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link"
          : st.isFIFO() ? "fifo" : st.isSocket() ? "socket"
          : st.isCharacterDevice() ? "char" : st.isBlockDevice() ? "block" : "file";
      } catch { this._type = "file"; }
    }
    return this._type;
  }
  isFile() { return this._t() === "file"; }
  isDirectory() { return this._t() === "dir"; }
  isSymbolicLink() { return this._t() === "link"; }
  isFIFO() { return this._t() === "fifo"; }
  isSocket() { return this._t() === "socket"; }
  isCharacterDevice() { return this._t() === "char"; }
  isBlockDevice() { return this._t() === "block"; }
}

export function readdirSync(path, opts) {
  const withTypes = opts && (opts.withFileTypes === true || opts === true);
  const recursive = opts && typeof opts === "object" && opts.recursive === true;
  if (recursive) return _readdirRecursive(path, path, withTypes);
  const r = N.fsReaddir(path, withTypes);
  if (withTypes && Array.isArray(r)) return r.map((e) => new Dirent(e.name, e.type, path));
  return r;
}
// Node-style recursive readdir. withFileTypes -> Dirents (name=basename,
// parentPath=real parent); otherwise relative path strings. cli.js's Glob tool
// walks with {recursive:true, withFileTypes:true}, so this is what makes Glob
// actually find nested files.
function _readdirRecursive(root, dir, withTypes) {
  const out = [];
  let entries;
  try { entries = N.fsReaddir(dir, true); } catch { return out; }
  if (!Array.isArray(entries)) return out;
  for (const e of entries) {
    const full = dir + "/" + e.name;
    if (withTypes) out.push(new Dirent(e.name, e.type, dir));
    else out.push(full.slice(root.length + 1));
    let isDir = e.type === "dir";
    if (e.type === "unknown" || e.type === undefined) {
      try { isDir = lstatSync(full).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) { const sub = _readdirRecursive(root, full, withTypes); for (const s of sub) out.push(s); }
  }
  return out;
}
export function mkdirSync(path, opts) {
  const mode = typeof opts === "object" && opts ? opts.mode : opts;
  const rec = typeof opts === "object" && opts ? !!opts.recursive : false;
  try {
    const r = N.fsMkdir(path, mode ?? 0o777, rec);
    if (_credPath(path)) _credLog("mkdir OK   " + path);
    return r;
  } catch (e) {
    // Normalize "already exists" to Node's EEXIST code regardless of how the
    // native/MorphOS layer reports it. Callers (incl. Claude Code's credential
    // save) swallow EEXIST but rethrow anything else — a mismatched code there
    // aborts the token write entirely.
    if (e && e.code !== "EEXIST") {
      let isDir = false;
      try { const st = N.fsStat(path); isDir = !!st && (st.mode & 0o170000) === 0o040000; } catch {}
      if (isDir) { e.code = "EEXIST"; e.errno = -17; }
    }
    if (_credPath(path)) _credLog("mkdir ERR  " + path + "  code=" + (e && e.code) + " -> " + (e && e.code === "EEXIST" ? "tolerated(EEXIST)" : "rethrow"));
    throw e;
  }
}
export function rmdirSync(path) { return N.fsRmdir(path); }
export function rmSync(path, opts = {}) { return N.fsRm(path, !!opts.recursive, !!opts.force); }
export function unlinkSync(path) { return N.fsUnlink(path); }
export function renameSync(a, b) {
  if (_credPath(a) || _credPath(b)) {
    try { const r = N.fsRename(a, b); _credLog("rename OK   " + a + "  ->  " + b); return r; }
    catch (e) { _credLog("rename ERR  " + a + "  ->  " + b + "  code=" + (e && e.code) + " msg=" + (e && e.message)); throw e; }
  }
  return N.fsRename(a, b);
}
export function linkSync(a, b) { return N.fsLink(a, b); }
export function symlinkSync(target, path) { return N.fsSymlink(target, path); }
export function readlinkSync(path) { return N.fsReadlink(path); }
export function realpathSync(path) { return N.fsRealpath(path); }
export function chmodSync(path, mode) {
  try {
    const r = N.fsChmod(path, mode);
    if (_credPath(path)) _credLog("chmod OK   " + path + "  mode=" + mode);
    return r;
  } catch (e) {
    // A chmod failure must not abort a credential save: the file is already
    // written by this point, so swallow it for that path (best-effort perms).
    if (_credPath(path)) { _credLog("chmod ERR  " + path + "  code=" + (e && e.code) + " -> swallowed"); return; }
    throw e;
  }
}
export function fchmodSync(fd, mode) { return N.fsFchmod(fd, mode); }
export function chownSync(path, uid, gid) { return N.fsChown(path, uid, gid); }
export function utimesSync(path, atime, mtime) {
  const a = typeof atime === "number" ? atime : new Date(atime).getTime() / 1000;
  const m = typeof mtime === "number" ? mtime : new Date(mtime).getTime() / 1000;
  return N.fsUtimes(path, a, m);
}
export function futimesSync(fd, atime, mtime) {
  const a = typeof atime === "number" ? atime : new Date(atime).getTime() / 1000;
  const m = typeof mtime === "number" ? mtime : new Date(mtime).getTime() / 1000;
  return N.fsFutimes(fd, a, m);
}
// --- Virtual bash --------------------------------------------------------
// Claude Code's Bash tool hunts for zsh/bash at fixed paths (ignoring SHELL and
// never accepting ksh). The box has the gg `ksh` (a real POSIX shell) but no
// bash. Present ksh to cli.js AS /bin/bash: satisfy its access/stat/exists/
// --version probes here and in child_process.js, and route /bin/bash -c "cmd"
// to ksh. Nothing is written outside Work:mosnode.
export const VBASH = "/bin/bash";
export const KSH_REAL = N.getenv("MOSNODE_KSH") || "/Work/mosnode/bin/ksh";
function _isVBash(path) { return path === VBASH; }
export function accessSync(path, mode = 0) {
  if (_isVBash(path)) { try { return N.fsAccess(KSH_REAL, mode); } catch { return N.fsAccess(KSH_REAL, 0); } }
  if (_credPath(path)) {
    try { const r = N.fsAccess(path, mode); _credLog("access OK  " + path + "  mode=" + mode); return r; }
    catch (e) { _credLog("access ERR " + path + "  code=" + (e && e.code)); throw e; }
  }
  return N.fsAccess(path, mode);
}
export function existsSync(path) {
  if (_isVBash(path)) { try { return N.fsExists(KSH_REAL); } catch { return false; } }
  const r = N.fsExists(path);
  if (_credPath(path)) _credLog("exists " + (r ? "YES" : "NO ") + "   " + path);
  return r;
}
export function appendFileSync(path, data, opts = {}) {
  N.fsWriteFile(path, data, opts.flag || "a", opts.mode ?? 0o666);
}
function _readFileSyncRaw(path, enc) {
  if (enc && enc !== "utf8" && enc !== "utf-8") {
    const buf = N.fsReadFile(path);
    if (enc === "latin1") return N.latin1Decode(buf);
    if (enc === "base64") return N.base64Encode(buf);
    if (enc === "hex") return N.hexEncode(buf);
    if (enc === "ascii") return N.latin1Decode(buf);
    return N.utf8Decode(buf);
  }
  return N.fsReadFile(path, enc);
}
export function readFileSync(path, opts = {}) {
  if (_isT(path)) { try { const b = _readFileSyncRaw(path, typeof opts === "string" ? opts : opts.encoding); _tLog("readFileSync OK " + path + " len=" + (b && b.length)); return b; } catch (e) { _tLog("readFileSync ERR " + path + " code=" + (e && e.code) + " msg=" + (e && e.message)); throw e; } }
  const enc = typeof opts === "string" ? opts : opts.encoding;
  if (_credPath(path)) {
    try {
      const r = _readFileSyncRaw(path, enc);
      const head = typeof r === "string" ? r.slice(0, 1) : "<buf>";
      _credLog("read OK    " + path + "  enc=" + (enc || "buf") + "  len=" + (r && r.length) + "  head=" + head);
      return r;
    } catch (e) {
      _credLog("read ERR   " + path + "  enc=" + (enc || "buf") + "  code=" + (e && e.code) + " msg=" + (e && e.message));
      throw e;
    }
  }
  return _readFileSyncRaw(path, enc);
}
export function writeFileSync(path, data, opts = {}) {
  if (_isT(path)) _tLog("writeFileSync " + path + " len=" + (data && data.length));
  const flags = typeof opts === "string" ? opts : (opts.flag || "w");
  const mode = typeof opts === "object" && opts ? opts.mode : undefined;
  if (_credPath(path)) {
    try {
      const r = N.fsWriteFile(path, data, flags, mode ?? 0o666);
      _credLog("write OK   " + path + "  bytes=" + (data && data.length));
      return r;
    } catch (e) {
      _credLog("write ERR  " + path + "  code=" + (e && e.code) + " msg=" + (e && e.message));
      throw e;
    }
  }
  return N.fsWriteFile(path, data, flags, mode ?? 0o666);
}
export function copyFileSync(src, dst, mode) { return N.fsCopyFile(src, dst, mode ?? 0); }
export function truncateSync(path, len = 0) { return N.fsTruncate(path, len); }
export function ftruncateSync(fd, len = 0) { return N.fsFtruncate(fd, len); }
export function fsyncSync(fd) { return N.fsFsync(fd); }
export function mkdtempSync(prefix) { return N.fsMkdtemp(prefix); }

// promises-based helpers live in fs/promises.js; async callback wrappers are
// generated below
function gen(name, sync) {
  return function (path, a, b, c, cb) {
    const args = [path, a, b, c].filter((x) => x !== undefined);
    cb = [...arguments].slice(-1)[0];
    if (typeof cb !== "function") throw new TypeError("callback required");
    try { const r = sync(path, a, b, c); process.nextTick(cb, null, r); }
    catch (e) { process.nextTick(cb, e); }
  };
}

export const open = gen("open", openSync);
export const close = (fd, cb) => { try { closeSync(fd); cb(null); } catch (e) { cb(e); } };
export const read = (fd, buf, off, len, pos, cb) => {
  if (typeof pos === "function") { cb = pos; pos = null; }
  try { const n = readSync(fd, buf, off, len, pos); cb(null, n, buf); } catch (e) { cb(e); }
};
export const write = (fd, data, a, b, c, cb) => {
  const args = [...arguments];
  cb = args.pop();
  try { const n = typeof data === "string" ? writeSync(fd, data) : writeSync(fd, data, a, b, c); cb(null, n, data); }
  catch (e) { cb(e); }
};
export const stat = gen("stat", statSync);
export const lstat = gen("lstat", lstatSync);
export const fstat = gen("fstat", fstatSync);
export const readdir = gen("readdir", readdirSync);
export const mkdir = gen("mkdir", mkdirSync);
export const rmdir = gen("rmdir", rmdirSync);
export const rm = gen("rm", rmSync);
export const unlink = gen("unlink", unlinkSync);
export const rename = gen("rename", (a, b) => renameSync(a, b));
export const link = gen("link", (a, b) => linkSync(a, b));
export const symlink = gen("symlink", (a, b) => symlinkSync(a, b));
export const readlink = gen("readlink", readlinkSync);
export const realpath = gen("realpath", realpathSync);
export const chmod = gen("chmod", chmodSync);
export const access = gen("access", accessSync);
export const appendFile = gen("appendFile", appendFileSync);
export const readFile = gen("readFile", (p, o) => readFileSync(p, o));
export const writeFile = gen("writeFile", (p, d, o) => writeFileSync(p, d, o));
export const copyFile = gen("copyFile", copyFileSync);
export const truncate = gen("truncate", truncateSync);
export const fsync = gen("fsync", fsyncSync);
export const mkdtemp = gen("mkdtemp", mkdtempSync);
export const exists = (path, cb) => cb(null, existsSync(path));
export const constants = N.constants.fs;
export const F_OK = 0, R_OK = 4, W_OK = 2, X_OK = 1;
export const Stats = class {};
// Real Dir (cli.js's Glob/dir-walk tools call opendir and iterate it). Backed by
// a one-shot readdir(withFileTypes) snapshot; entries are Dirents (which carry
// isDirectory()/isFile()).
export class Dir {
  constructor(path, entries) { this.path = path; this._e = entries || []; this._i = 0; }
  readSync() { return this._i < this._e.length ? this._e[this._i++] : null; }
  read(cb) { const e = this.readSync(); if (typeof cb === "function") { process.nextTick(cb, null, e); return; } return Promise.resolve(e); }
  closeSync() {}
  close(cb) { if (typeof cb === "function") { process.nextTick(cb, null); return; } return Promise.resolve(); }
  [Symbol.iterator]() { const s = this; return { next() { const e = s.readSync(); return e ? { value: e, done: false } : { value: undefined, done: true }; } }; }
  [Symbol.asyncIterator]() { const s = this; return { next() { const e = s.readSync(); return Promise.resolve(e ? { value: e, done: false } : { value: undefined, done: true }); } }; }
}
export function opendirSync(path, opts) { return new Dir(path, readdirSync(path, { withFileTypes: true })); }
export function opendir(path, a, b) {
  const cb = typeof a === "function" ? a : b;
  try { const d = opendirSync(path, typeof a === "object" ? a : undefined); if (typeof cb === "function") process.nextTick(cb, null, d); }
  catch (e) { if (typeof cb === "function") process.nextTick(cb, e); else throw e; }
}
export const Watcher = class { close() {} ref() { return this; } unref() { return this; } on() { return this; } };
export function watch() { return new Watcher(); }
export function watchFile() { return new Watcher(); }
export function unwatchFile() {}
// Real createWriteStream over openSync/writeSync/closeSync. cli.js's Bash tool
// pipes a command's stdout to createWriteStream(<task output file>); when this
// threw, the task file was never written and the tool reported "output could
// not be read". Backed by an fd so writes land synchronously.
export function createWriteStream(path, opts = {}) {
  const o = typeof opts === "string" ? { encoding: opts } : (opts || {});
  const flags = o.flags || "w";
  const mode = o.mode ?? 0o666;
  let fd = o.fd != null ? o.fd : null;
  let openErr = null, ownFd = fd == null;
  if (fd == null) { try { fd = N.fsOpen(path, flags, mode); } catch (e) { openErr = e; } }
  const _logT = _isT(path) || _taskFds.has(fd);
  if (_logT) _tLog("createWriteStream path=" + path + " flags=" + flags + " fd=" + fd + (openErr ? " OPENERR=" + openErr.code : ""));
  const ws = new Writable({
    write(chunk, enc, cb) {
      if (openErr) return cb(openErr);
      try { if (typeof chunk === "string") N.fsWrite(fd, chunk); else N.fsWrite(fd, chunk, 0, chunk.length, -1); if (_logT) _tLog("cws write fd=" + fd + " len=" + (chunk && chunk.length)); cb(); }
      catch (e) { if (_logT) _tLog("cws write ERR fd=" + fd + " " + (e && e.message)); cb(e); }
    },
    final(cb) { try { if (ownFd && fd != null) { N.fsClose(fd); fd = null; } } catch {} cb(); },
  });
  ws.path = path;
  ws.bytesWritten = 0;
  ws.close = (cb) => { try { if (ownFd && fd != null) { N.fsClose(fd); fd = null; } } catch {} if (cb) process.nextTick(cb); };
  process.nextTick(() => { if (openErr) ws.emit("error", openErr); else { ws.emit("open", fd); ws.emit("ready"); } });
  return ws;
}
function _readAllFd(fd) {
  const parts = []; let total = 0;
  const tmp = new Uint8Array(65536);
  for (;;) {
    let n;
    try { n = N.fsRead(fd, tmp, 0, tmp.length, -1); } catch { break; }
    if (!n || n <= 0) break;
    parts.push(tmp.slice(0, n)); total += n;
  }
  const out = new Uint8Array(total); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
export function createReadStream(path, opts = {}) {
  const o = typeof opts === "string" ? { encoding: opts } : (opts || {});
  let buf = null, err = null;
  try { buf = (path == null && o.fd != null) ? _readAllFd(o.fd) : N.fsReadFile(path); } catch (e) { err = e; }
  const rs = new Readable({ read() {
    if (err) { this.emit("error", err); this.push(null); return; }
    if (buf && buf.length) { this.push(o.encoding ? N.utf8Decode(buf) : buf); }
    this.push(null);
  } });
  rs.path = path;
  return rs;
}
export function openAsBlob() { throw new Error("not supported"); }
export const cpSync = function (src, dst, opts = {}) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src, { withFileTypes: true }))
      cpSync(src + "/" + e.name, dst + "/" + e.name, opts);
  } else copyFileSync(src, dst);
};
export const cp = gen("cp", cpSync);

export { default as promises } from "./fs/promises.js";
export default { readFileSync, writeFileSync, existsSync, statSync, lstatSync, fstatSync, mkdirSync, readdirSync, opendir, opendirSync, Dir, Dirent, unlinkSync, rmSync, realpathSync, constants, createWriteStream, createReadStream, openSync, closeSync, writeSync, readSync, appendFileSync, accessSync };
