// node:stream — compact implementation (Readable/Writable/Duplex/Transform)
import { EventEmitter } from "./events.js";

const kPaused = Symbol("paused");

function flow(stream) {
  while (stream._flowing && stream._buffer.length) {
    const chunk = stream._buffer.shift();
    stream._needDrain = stream._buffer.length > 0;
    stream.emit("data", chunk);
    if (stream._buffer.length < stream._highWaterMark) stream._pull();
  }
  if (stream._needDrain && !stream._buffer.length) {
    stream._needDrain = false;
    stream.emit("drain");
  }
}

export class Readable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._buffer = [];
    this._flowing = null; // Node tri-state: null (initial) | true | false (explicitly paused)
    this._ended = false;
    this._inRead = false;
    this._pushCount = 0;
    this._closeEmitted = false;
    // Only set an instance _read when a read() option is given. A bare
    // `this._read = ...` would SHADOW a subclass's own `_read()` method (e.g.
    // readdirp extends Readable and overrides _read), so its logic would never
    // run and the stream would silently yield nothing. Default lives on the
    // prototype (_read method below).
    if (typeof opts.read === "function") this._read = opts.read;
    this._highWaterMark = opts.highWaterMark || 16384;
    this._encoding = opts.encoding || null;
    this.readable = true;
    this.destroyed = false;
    this.readableEnded = false;
    this._readSize = opts.readableHighWaterMark;
    this._readableMode = false;    // paused-mode read via 'readable'+read() (Ink)
    this._readableScheduled = false;
  }
  _read() {}   // default no-op; subclasses override this method
  push(chunk) {
    this._pushCount++;
    if (chunk === null) { this._ended = true; this._maybeClose(); this._emitReadable(); return false; }
    if (this._ended || this.destroyed) return false;
    if (this._encoding && typeof chunk !== "string")
      chunk = Buffer.from(chunk).toString(this._encoding);
    this._buffer.push(chunk);
    if (this._flowing) flow(this);
    else if (this._readableMode) this._emitReadable();
    return this._buffer.length < this._highWaterMark;
  }
  read() {
    if (this._flowing) {
      if (this._buffer.length <= 0 && !this._ended) this._pull();
      const chunk = this._buffer.shift();
      if (chunk !== undefined) this.emit("data", chunk);
      return chunk ?? null;
    }
    // paused / 'readable' mode (how Ink reads stdin): return buffered data,
    // keep the native source armed, and surface end only once drained.
    if (!this._readableMode) this._startReadable();
    const chunk = this._buffer.shift();
    if (chunk === undefined) { if (this._ended) this._maybeClose(); return null; }
    if (!this._buffer.length && !this._ended) this._pull();
    return chunk;
  }
  resume() {
    // Like Node, defer the actual flowing to nextTick, so listeners attached
    // right after on('data') (e.g. pipe()'s 'end' handler) are in place.
    this._flowing = true;
    if (!this._resumeScheduled) {
      this._resumeScheduled = true;
      const tick = globalThis.process?.nextTick ?? queueMicrotask;
      tick(() => {
        this._resumeScheduled = false;
        if (!this._flowing) return;
        flow(this);
        // empty buffer: nothing in flow() asks the source for data, so kick it
        if (this._flowing && !this._buffer.length) this._pull();
        this._maybeClose();
      });
    }
    return this;
  }
  // Ask the source for data. Never re-enters _read (a sync _read that pushes
  // would otherwise recurse via flow()); if a sync _read pushed and everything
  // was consumed, ask again so one-chunk-per-call sources keep going.
  _pull() {
    if (this._inRead || this._ended || this.destroyed || typeof this._read !== "function") return;
    for (;;) {
      this._inRead = true;
      const before = this._pushCount;
      try { this._read(this._highWaterMark); }
      catch (e) { this._inRead = false; this.emit("error", e); return; }
      this._inRead = false;
      if (this._pushCount === before || this._ended || this.destroyed ||
          !this._flowing || this._buffer.length) return;
    }
  }
  // Enter paused/'readable' mode and arm the underlying source once. Node starts
  // the source as soon as a 'readable' listener attaches (or read() is called),
  // even though the stream stays paused. The native stdin reader is persistent,
  // so a single _pull keeps keystrokes flowing and pins the event loop alive.
  _startReadable() {
    if (!this._readableMode) {
      this._readableMode = true;
      this._pull();
    }
    if (this._buffer.length || this._ended) this._emitReadable();
  }
  // Emit 'readable' once per turn when data is available (or at end), deferred so
  // it fires outside the native read callback and coalesces bursts of chunks.
  _emitReadable() {
    if (this._readableScheduled || this._flowing) return;
    this._readableScheduled = true;
    const tick = globalThis.process?.nextTick ?? queueMicrotask;
    tick(() => {
      this._readableScheduled = false;
      if (this._flowing) return;
      if (this._buffer.length || this._ended) this.emit("readable");
    });
  }
  pause() { this._flowing = false; return this; }
  isPaused() { return this._flowing === false; }
  pipe(dest) {
    this.on("data", (c) => { if (dest.write(c) === false) this.pause(); });
    dest.on("drain", () => this.resume());
    this.on("end", () => { dest.end?.(); });
    return dest;
  }
  unpipe(dest) { if (dest) dest.emit("unpipe", this); return this; }
  setEncoding(enc) { this._encoding = enc; return this; }
  _maybeClose() {
    if (this._ended && !this._buffer.length && !this._closeEmitted) {
      this._closeEmitted = true;
      this.readableEnded = true;
      this.emit("end");
      this.emit("close");
    }
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
    return this;
  }
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      async next() {
        const chunk = self.read();
        if (chunk !== null) return { value: chunk, done: false };
        if (self._ended && !self._buffer.length) return { done: true };
        return new Promise((resolve, reject) => {
          const onData = (c) => { cleanup(); resolve({ value: c, done: false }); };
          const onEnd = () => { cleanup(); resolve({ done: true }); };
          const onErr = (e) => { cleanup(); reject(e); };
          const cleanup = () => {
            self.off("data", onData); self.off("end", onEnd); self.off("error", onErr);
          };
          self.once("data", onData); self.once("end", onEnd); self.once("error", onErr);
        });
      },
    };
  }
  on(ev, fn) {
    const r = super.on(ev, fn);
    if (ev === "data" && this._flowing !== false && this._flowing !== true) this.resume();
    if (ev === "readable" && !this._flowing) this._startReadable();
    if (ev === "readable" || ev === "data") this._maybeClose();
    return r;
  }
  once(ev, fn) {
    const r = super.once(ev, fn);
    if (ev === "data" && this._flowing !== false && this._flowing !== true) this.resume();
    if (ev === "readable" && !this._flowing) this._startReadable();
    return r;
  }
  // Base EventEmitter.addListener goes straight to the registry, NOT through our
  // on() override, and Ink attaches stdin input via addListener("readable", ...).
  // Route both (and prependListener) through the same start-reading logic.
  addListener(ev, fn) { return this.on(ev, fn); }
  prependListener(ev, fn) {
    const r = super.prependListener(ev, fn);
    if (ev === "data" && this._flowing !== false && this._flowing !== true) this.resume();
    if (ev === "readable" && !this._flowing) this._startReadable();
    if (ev === "readable" || ev === "data") this._maybeClose();
    return r;
  }
  get readableFlowing() { return this._flowing; }
  get readableLength() { return this._buffer.length; }
  unshift() {}
  wrap() { return this; }
}

export class Writable extends EventEmitter {
  constructor(opts = {}) {
    super();
    // Don't shadow a subclass's own _write()/_final() methods (see Readable).
    if (typeof opts.write === "function") this._write = opts.write;
    if (typeof opts.final === "function") this._final = opts.final;
    this._writable = true;
    this._queue = [];
    this._writing = false;
    this._needDrain = false;
    this.writable = true;
    this.destroyed = false;
    this.writableEnded = false;
    this._highWaterMark = opts.highWaterMark || 16384;
    this._writableEncoding = opts.encoding || null;
    this.on("newListener", (ev) => { if (ev === "drain") {} });
  }
  _write(chunk, enc, cb) { cb(); }   // default; subclasses override this method
  write(chunk, enc, cb) {
    if (typeof enc === "function") { cb = enc; enc = null; }
    if (this._writableEncoding && typeof chunk !== "string" && enc)
      chunk = Buffer.from(chunk).toString(enc);
    if (this.writableEnded) {
      const err = new Error("write after end");
      if (cb) cb(err); else this.emit("error", err);
      return false;
    }
    this._queue.push({ chunk, cb });
    this._needDrain = true;
    this._process();
    return this._queue.length < this._highWaterMark;
  }
  _process() {
    if (this._writing || !this._queue.length || !this._writable) return;
    this._writing = true;
    const { chunk, cb } = this._queue.shift();
    let sync = true;
    let called = false;
    const done = (err) => {
      if (called) return;
      called = true;
      if (err) { if (cb) cb(err); this.emit("error", err); return; }
      if (cb) cb();
      if (sync) { this._writing = false; queueMicrotask(() => this._process()); }
      else { this._writing = false; this._process(); }
      if (this._needDrain && !this._queue.length && !this.writableEnded) {
        this._needDrain = false;
        this.emit("drain");
      }
      if (this.writableEnded && !this._queue.length) this._finish();
    };
    try { this._write(chunk, this._writableEncoding || "utf8", done); }
    catch (e) { done(e); }
    sync = false;
  }
  end(chunk, enc, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = null; }
    if (typeof enc === "function") { cb = enc; enc = null; }
    if (typeof cb === "function") this.once("finish", cb);
    if (chunk != null) this.write(chunk, enc);
    this.writableEnded = true;
    if (!this._queue.length && !this._writing) this._finish();
    else this._process();
    return this;
  }
  _finish() {
    if (this._finished) return;
    this._finished = true;
    const emit = () => { this.emit("finish"); this.emit("close"); };
    if (this._final) {
      try { this._final(() => emit()); } catch (e) { this.emit("error", e); emit(); }
    } else emit();
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (err) this.emit("error", err);
    this.emit("close");
    return this;
  }
  get writableLength() { return this._queue.length; }
  setDefaultEncoding() { return this; }
  cork() {} uncork() {}
}

export class Duplex extends Readable {
  constructor(opts = {}) {
    const { read, write, final, ...rest } = opts;
    super({ read, ...rest });
    const w = new Writable({ write, final, ...rest });
    for (const k of ["write", "end", "cork", "uncork"]) {
      Object.defineProperty(this, k, { value: w[k].bind(w), writable: true, configurable: true });
    }
    this._w = w;
    this.writable = true;
    this.writableEnded = false;
    w.on("finish", () => { this.writableEnded = true; this.emit("finish"); });
    w.on("drain", () => this.emit("drain"));
    w.on("error", (e) => this.emit("error", e));
    this._proxiedEnd = true;
  }
  end(...args) { this._w.end(...args); return this; }
  write(...args) { return this._w.write(...args); }
  destroy(err) { super.destroy(err); this._w.destroy(err); return this; }
  get writableLength() { return this._w._queue.length; }
}

export class Transform extends Duplex {
  constructor(opts = {}) {
    const transform = opts.transform || ((c, e, cb) => cb(null, c));
    const flush = opts.flush;
    super({
      read: opts.read,
      write(chunk, enc, cb) {
        let sync = true, called = false;
        const done = (err, data) => {
          if (called) return; called = true;
          if (err) return cb(err);
          if (data != null) this.push(data);
          cb();
        };
        try { transform(chunk, enc, done); } catch (e) { done(e); }
        sync = false;
      },
      final(cb) {
        if (flush) flush((err, data) => { if (err) return cb(err); if (data != null) this.push(data); cb(); });
        else cb();
      },
    });
    this._transform = transform;
  }
  push(chunk) { return super.push(chunk); }
}

export class PassThrough extends Transform {}

export function pipeline(...streams) {
  let cb = typeof streams[streams.length - 1] === "function" ? streams.pop() : null;
  const parts = streams.flat();
  for (let i = 0; i + 1 < parts.length; i++) parts[i].pipe(parts[i + 1]);
  const last = parts[parts.length - 1];
  const done = (err) => { if (cb) { cb(err); cb = null; } };
  if (last) {
    last.on?.("finish", () => done(null));
    last.on?.("end", () => done(null));
    last.on?.("error", done);
  }
  return last;
}

export function finished(stream, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = null; }
  const done = (err) => { if (cb) { cb(err); cb = null; } };
  if (stream.destroyed || stream.readableEnded || stream.writableEnded || stream._finished) {
    done(null);
  } else {
    stream.once("end", () => done(null));
    stream.once("finish", () => done(null));
    stream.once("close", () => done(null));
    stream.once("error", done);
  }
  return { destroy() {} };
}

export function addAbortSignal(signal, stream) {
  if (signal) signal.addEventListener("abort", () => stream.destroy(new Error("aborted")));
  return stream;
}
export const isDisturbed = (s) => s.readable === false;
export const isErrored = (s) => !!s.errored;
export const isReadable = (s) => !!s.readable;
export const isWritable = (s) => !!s.writable;
export { pipeline as pipe };

// Legacy base class. Node's `Stream` is an EventEmitter with pipe(); Readable
// already implements pipe, so this is mainly for `instanceof`/subclass use and
// as the namespace carrier (Stream.Readable, etc.).
export class Stream extends EventEmitter {
  pipe(dest, opts) {
    const src = this;
    src.on("data", (chunk) => { if (dest.write(chunk) === false && src.pause) src.pause(); });
    dest.on && dest.on("drain", () => { if (src.resume) src.resume(); });
    if (!opts || opts.end !== false) src.on("end", () => dest.end && dest.end());
    return dest;
  }
}
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.Stream = Stream;

export default Object.assign(Stream, {
  Readable, Writable, Duplex, Transform, PassThrough, pipeline,
  finished, addAbortSignal, isDisturbed, isErrored, isReadable, isWritable, pipe: pipeline,
});
