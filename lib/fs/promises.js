// node:fs/promises
import * as N from "native";
import * as fsSync from "../fs.js";

function p(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, res) => err ? reject(err) : resolve(res));
  });
}

// Node's fs/promises.open resolves to a FileHandle, NOT a bare fd. cli.js's
// Bash tool relies on this: it does `S = await open(outfile, ...)` then passes
// `S.fd` as the child's stdout/stderr stdio and `await S.close()`. Returning a
// bare number made `S.fd` undefined, so the child's output fd was never wired
// up and the task .output file stayed empty ("output file could not be read").
export const open = (path, flags = "r", mode = 0o666) => Promise.resolve().then(() => new FileHandle(fsSync.openSync(path, flags, mode)));
export const close = (fd) => Promise.resolve().then(() => fsSync.closeSync(fd));
export const readFile = (path, opts) => Promise.resolve().then(() => fsSync.readFileSync(path, opts));
export const writeFile = (path, data, opts) => Promise.resolve().then(() => fsSync.writeFileSync(path, data, opts));
export const appendFile = (path, data, opts) => Promise.resolve().then(() => fsSync.appendFileSync(path, data, opts));
export const stat = (path) => Promise.resolve().then(() => fsSync.statSync(path));
export const lstat = (path) => Promise.resolve().then(() => fsSync.lstatSync(path));
export const fstat = (fd) => Promise.resolve().then(() => fsSync.fstatSync(fd));
export const readdir = (path, opts) => Promise.resolve().then(() => fsSync.readdirSync(path, opts));
export const opendir = (path, opts) => Promise.resolve().then(() => fsSync.opendirSync(path, opts));
export const mkdir = (path, opts) => Promise.resolve().then(() => fsSync.mkdirSync(path, opts));
export const mkdtemp = (prefix) => Promise.resolve().then(() => fsSync.mkdtempSync(prefix));
export const rmdir = (path) => Promise.resolve().then(() => fsSync.rmdirSync(path));
export const rm = (path, opts) => Promise.resolve().then(() => fsSync.rmSync(path, opts));
export const unlink = (path) => Promise.resolve().then(() => fsSync.unlinkSync(path));
export const rename = (a, b) => Promise.resolve().then(() => fsSync.renameSync(a, b));
export const link = (a, b) => Promise.resolve().then(() => fsSync.linkSync(a, b));
export const symlink = (a, b) => Promise.resolve().then(() => fsSync.symlinkSync(a, b));
export const readlink = (path) => Promise.resolve().then(() => fsSync.readlinkSync(path));
export const realpath = (path) => Promise.resolve().then(() => fsSync.realpathSync(path));
export const chmod = (path, mode) => Promise.resolve().then(() => fsSync.chmodSync(path, mode));
export const utimes = (path, atime, mtime) => Promise.resolve().then(() => fsSync.utimesSync(path, atime, mtime));
export const lutimes = (path, atime, mtime) => Promise.resolve().then(() => fsSync.utimesSync(path, atime, mtime));
export const chown = (path, uid, gid) => Promise.resolve().then(() => fsSync.chownSync && fsSync.chownSync(path, uid, gid));
export const lchown = (path, uid, gid) => Promise.resolve().then(() => fsSync.chownSync && fsSync.chownSync(path, uid, gid));
export const access = (path, mode) => Promise.resolve().then(() => fsSync.accessSync(path, mode));
export const copyFile = (a, b, m) => Promise.resolve().then(() => fsSync.copyFileSync(a, b, m));
export const cp = (a, b, opts) => Promise.resolve().then(() => fsSync.cpSync(a, b, opts));
export const truncate = (path, len) => Promise.resolve().then(() => fsSync.truncateSync(path, len));
export const constants = N.constants.fs;
export const watch = () => { throw new Error("fs.promises.watch not supported"); };
export class FileHandle {
  constructor(fd) { this.fd = fd; }
  read(buf, off, len, pos) { return Promise.resolve().then(() => { const n = fsSync.readSync(this.fd, buf, off, len, pos); return { bytesRead: n, buffer: buf }; }); }
  write(data) { return Promise.resolve().then(() => { const n = fsSync.writeSync(this.fd, data); return { bytesWritten: n, buffer: data }; }); }
  readFile(opts) { return Promise.resolve().then(() => fsSync.readFileSync(this.fd, opts)); }
  appendFile(data, opts) { return Promise.resolve().then(() => { fsSync.writeSync(this.fd, data); }); }
  truncate(len) { return Promise.resolve().then(() => fsSync.ftruncateSync(this.fd, len)); }
  sync() { return Promise.resolve().then(() => fsSync.fsyncSync && fsSync.fsyncSync(this.fd)); }
  datasync() { return this.sync(); }
  chmod(mode) { return Promise.resolve().then(() => fsSync.fchmodSync && fsSync.fchmodSync(this.fd, mode)); }
  createReadStream(opts = {}) { return fsSync.createReadStream(null, { ...opts, fd: this.fd }); }
  createWriteStream(opts = {}) { return fsSync.createWriteStream(null, { ...opts, fd: this.fd }); }
  stat() { return fstat(this.fd); }
  close() { return close(this.fd); }
  // Defensive: let any code that still treats the handle as a bare fd number
  // (numeric coercion) keep working.
  valueOf() { return this.fd; }
  [Symbol.toPrimitive](hint) { return hint === "string" ? String(this.fd) : this.fd; }
  [Symbol.asyncDispose]() { return this.close(); }
}
export default { open, close, readFile, writeFile, appendFile, stat, lstat, fstat, readdir, opendir,
  mkdir, mkdtemp, rmdir, rm, unlink, rename, link, symlink, readlink, realpath, chmod,
  access, copyFile, cp, truncate, constants, watch, FileHandle };
