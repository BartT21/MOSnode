// node:readline — line-buffered interface over input/output streams.
import { EventEmitter } from "./events.js";

export class Interface extends EventEmitter {
  constructor(input, output, completer, terminal) {
    super();
    if (input && typeof input === "object" && (input.input || input.output)) {
      const o = input;
      input = o.input; output = o.output; completer = o.completer; terminal = o.terminal;
      this.setPrompt(o.prompt != null ? o.prompt : "> ");
    } else this.setPrompt("> ");
    this.input = input;
    this.output = output;
    this.terminal = terminal != null ? !!terminal : !!(input && input.isTTY);
    this.completer = completer;
    this.line = "";
    this.cursor = 0;
    this.closed = false;
    this._buf = "";
    this._questionCb = null;

    if (input && typeof input.on === "function") {
      this._onData = (chunk) => this._ondata(chunk);
      input.on("data", this._onData);
      input.once("end", () => this.close());
      if (typeof input.resume === "function") input.resume();
    }
  }

  _ondata(chunk) {
    if (this.closed) return;
    this._buf += chunk.toString("utf8");
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      let line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (this._questionCb) { const cb = this._questionCb; this._questionCb = null; cb(line); }
      else this.emit("line", line);
    }
  }

  setPrompt(p) { this._prompt = p; return this; }
  getPrompt() { return this._prompt; }
  prompt(preserveCursor) { if (this.output) this.output.write(this._prompt); }
  question(query, cb) {
    if (typeof cb !== "function") {
      // promise form
      return new Promise((resolve) => this.question(query, resolve));
    }
    if (this.output && query != null) this.output.write(query);
    this._questionCb = cb;
  }
  write(data, key) { if (this.output && data != null) this.output.write(data); }
  pause() { if (this.input && this.input.pause) this.input.pause(); this.emit("pause"); return this; }
  resume() { if (this.input && this.input.resume) this.input.resume(); this.emit("resume"); return this; }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.input && this._onData && this.input.off) this.input.off("data", this._onData);
    this.emit("close");
  }
  [Symbol.asyncIterator]() {
    const self = this;
    const queue = [];
    let waiting = null, done = false;
    self.on("line", (l) => { if (waiting) { const w = waiting; waiting = null; w({ value: l, done: false }); } else queue.push(l); });
    self.on("close", () => { done = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } });
    return {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { waiting = resolve; });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

export function emitKeypressEvents(stream, iface) {
  if (!stream || stream._keypressDecoder) return;
  stream._keypressDecoder = true;
  stream.on("data", (chunk) => {
    const s = chunk.toString("utf8");
    for (const ch of s) {
      const key = { sequence: ch, name: undefined, ctrl: false, meta: false, shift: false };
      if (ch === "\r" || ch === "\n") key.name = "return";
      else if (ch === "\x7f" || ch === "\b") key.name = "backspace";
      else if (ch === "\t") key.name = "tab";
      else if (ch === "\x1b") key.name = "escape";
      else if (ch >= " ") key.name = ch;
      else if (ch < " ") { key.ctrl = true; key.name = String.fromCharCode(ch.charCodeAt(0) + 96); }
      stream.emit("keypress", ch, key);
    }
  });
}

export function clearLine(stream, dir, cb) {
  if (stream) stream.write(dir < 0 ? "\x1b[1K" : dir > 0 ? "\x1b[0K" : "\r\x1b[2K");
  if (typeof cb === "function") cb();
  return true;
}
export function clearScreenDown(stream, cb) { if (stream) stream.write("\x1b[0J"); if (cb) cb(); return true; }
export function cursorTo(stream, x, y, cb) {
  if (typeof y === "function") { cb = y; y = undefined; }
  if (stream) stream.write(y == null ? `\x1b[${(x | 0) + 1}G` : `\x1b[${(y | 0) + 1};${(x | 0) + 1}H`);
  if (typeof cb === "function") cb();
  return true;
}
export function moveCursor(stream, dx, dy, cb) {
  let s = "";
  if (dx > 0) s += `\x1b[${dx}C`; else if (dx < 0) s += `\x1b[${-dx}D`;
  if (dy > 0) s += `\x1b[${dy}B`; else if (dy < 0) s += `\x1b[${-dy}A`;
  if (stream && s) stream.write(s);
  if (typeof cb === "function") cb();
  return true;
}

export default {
  Interface, createInterface, emitKeypressEvents,
  clearLine, clearScreenDown, cursorTo, moveCursor,
};
