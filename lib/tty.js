// node:tty — thin wrapper over the native TTY primitives. The real stdin/
// stdout streams (with isTTY/setRawMode/columns) are built in _stdio.js; these
// classes exist for direct construction and instanceof checks.
import * as N from "native";
import { Readable, Writable } from "./stream.js";

export function isatty(fd) {
  try { return N.isatty(fd); } catch { return false; }
}

export class ReadStream extends Readable {
  constructor(fd = 0, opts) {
    super(opts);
    this.fd = fd;
    this.isTTY = true;
    this.isRaw = false;
    const h = N.openFdStream(fd);
    this._h = h;
    this._read = () => {
      N.streamReadStart(h, (err, chunk) => {
        if (err || chunk === null) { N.streamReadStop(h); this.push(null); }
        else if (!this.push(chunk)) N.streamReadStop(h);
      });
    };
  }
  setRawMode(mode) { try { N.ttySetRawMode(this.fd, !!mode); } catch {} this.isRaw = !!mode; return this; }
}

export class WriteStream extends Writable {
  constructor(fd = 1, opts) {
    super(opts);
    this.fd = fd;
    this.isTTY = true;
    const h = N.openFdStream(fd);
    this._h = h;
    this._write = (chunk, enc, cb) => { N.streamWrite(h, chunk, () => {}); cb(); };
    const size = N.ttyGetWindowSize(fd);
    if (size) { this.columns = size[0]; this.rows = size[1]; }
  }
  getWindowSize() { const s = N.ttyGetWindowSize(this.fd); return s || [this.columns || 80, this.rows || 24]; }
  clearLine(dir, cb) { try { N.fsWrite(this.fd, "\r\x1b[K"); } catch {} if (cb) cb(); return true; }
  clearScreenDown(cb) { try { N.fsWrite(this.fd, "\x1b[0J"); } catch {} if (cb) cb(); return true; }
  cursorTo(x, y, cb) {
    if (typeof y === "function") { cb = y; y = undefined; }
    try { N.fsWrite(this.fd, y == null ? `\x1b[${(x | 0) + 1}G` : `\x1b[${(y | 0) + 1};${(x | 0) + 1}H`); } catch {}
    if (cb) cb(); return true;
  }
  moveCursor(dx, dy, cb) {
    let s = "";
    if (dx > 0) s += `\x1b[${dx}C`; else if (dx < 0) s += `\x1b[${-dx}D`;
    if (dy > 0) s += `\x1b[${dy}B`; else if (dy < 0) s += `\x1b[${-dy}A`;
    try { if (s) N.fsWrite(this.fd, s); } catch {}
    if (cb) cb(); return true;
  }
}

export default { isatty, ReadStream, WriteStream };
