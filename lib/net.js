// node:net — TCP sockets and servers on the mosnode native backend seam.
// A connected socket is just a non-blocking fd flowing through the same
// stream machinery as pipes; only connect/listen/accept/DNS are native.
import * as N from "native";
import { Duplex } from "./stream.js";
import { EventEmitter } from "./events.js";

/* ---------------- address validation ---------------- */

export function isIPv4(s) {
  if (typeof s !== "string") return false;
  const p = s.split(".");
  if (p.length !== 4) return false;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return false;
    if (x.length > 1 && x[0] === "0") return false;
    if (+x > 255) return false;
  }
  return true;
}
export function isIPv6(s) {
  if (typeof s !== "string") return false;
  // permissive: hex groups separated by ':', optional '::' and trailing v4
  if (s.indexOf(":") === -1) return false;
  return /^(::)?([0-9a-fA-F]{0,4}:){0,7}[0-9a-fA-F]{0,4}(::)?$/.test(s) ||
         /^[0-9a-fA-F:]+:(\d{1,3}\.){3}\d{1,3}$/.test(s);
}
export function isIP(s) { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }

/* ---------------- Socket ---------------- */

export class Socket extends Duplex {
  constructor(opts = {}) {
    // `state` is closed over by the read/write/final callbacks below, because
    // Duplex runs write/final with `this` bound to its inner Writable, not to
    // the Socket — so we cannot reach socket fields through `this` there.
    const state = {
      sock: null, h: null, connecting: false,
      pending: [], finalCb: null, reading: false, destroyed: false,
    };
    super({
      read() { state.sock._maybeRead(); },
      write(chunk, enc, cb) {
        if (state.h == null || state.connecting) { state.pending.push({ chunk, cb }); return; }
        N.streamWrite(state.h, chunk, (err) => (err ? cb(err) : cb()));
      },
      final(cb) {
        if (state.h == null || state.connecting) { state.finalCb = cb; return; }
        N.streamShutdown(state.h, () => cb());
      },
    });
    state.sock = this;
    this._state = state;
    this.connecting = false;
    this.pending = true;
    this.destroyed = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.remoteAddress = undefined;
    this.remotePort = undefined;
    this.remoteFamily = undefined;
    this.localAddress = undefined;
    this.localPort = undefined;
    this._timeout = null;

    if (opts.handle != null) {
      // Pre-connected socket from Server accept().
      state.h = opts.handle;
      if (opts.remoteAddress) this.remoteAddress = opts.remoteAddress;
      if (opts.remotePort) this.remotePort = opts.remotePort;
      this.pending = false;
      this._readAddrs();
      process.nextTick(() => this._maybeRead());
    }
  }

  _readAddrs() {
    const s = this._state;
    if (s.h == null) return;
    try {
      const loc = N.netAddr(s.h, false);
      if (loc) { this.localAddress = loc.address; this.localPort = loc.port; }
      const rem = N.netAddr(s.h, true);
      if (rem) { this.remoteAddress = rem.address; this.remotePort = rem.port; this.remoteFamily = rem.family; }
    } catch {}
  }

  _maybeRead() {
    const s = this._state;
    if (s.h == null || s.reading || s.destroyed) return;
    s.reading = true;
    N.streamReadStart(s.h, (err, chunk) => {
      this._bumpTimeout();
      if (err) { this.destroy(err); return; }
      if (chunk === null) { s.reading = false; this.push(null); return; }
      this.bytesRead += chunk.length;
      if (!this.push(chunk)) { s.reading = false; N.streamReadStop(s.h); }
    });
  }

  _flushPending() {
    const s = this._state;
    const q = s.pending; s.pending = [];
    for (const w of q)
      N.streamWrite(s.h, w.chunk, (err) => (err ? w.cb(err) : w.cb()));
    if (s.finalCb) { const cb = s.finalCb; s.finalCb = null; N.streamShutdown(s.h, () => cb()); }
  }

  connect(...args) {
    let opts, cb;
    if (args[0] && typeof args[0] === "object") { opts = args[0]; cb = args[1]; }
    else {
      opts = { port: args[0] };
      if (typeof args[1] === "string") { opts.host = args[1]; cb = args[2]; }
      else cb = args[1];
    }
    if (typeof cb === "function") this.once("connect", cb);

    const port = opts.port;
    const host = opts.host || "127.0.0.1";
    const s = this._state;
    s.connecting = true;
    this.connecting = true;

    const start = (ip) => {
      if (s.destroyed) return;
      try {
        s.h = N.netConnect(ip, port, (err) => {
          s.connecting = false;
          this.connecting = false;
          this.pending = false;
          if (err) { this.destroy(err); return; }
          this._readAddrs();
          this._bumpTimeout();
          this.emit("connect");
          this.emit("ready");
          this._flushPending();
          this._maybeRead();
        });
      } catch (e) { s.connecting = false; this.destroy(e); }
    };

    if (isIP(host)) { start(host); }
    else {
      process.nextTick(() => {
        if (s.destroyed) return;
        let r;
        try { r = N.dnsLookup(host, 0, false); }
        catch (e) { e.message = `getaddrinfo ${e.code || "ENOTFOUND"} ${host}`; s.connecting = false; this.destroy(e); return; }
        if (!r) { s.connecting = false; this.destroy(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" })); return; }
        this.emit("lookup", null, r.address, r.family, host);
        start(r.address);
      });
    }
    return this;
  }

  setTimeout(ms, cb) {
    const s = this._state;
    this._timeoutMs = ms;
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    if (ms > 0) {
      if (cb) this.once("timeout", cb);
      this._timeout = setTimeout(() => { this.emit("timeout"); }, ms);
      if (this._timeout && this._timeout.unref) this._timeout.unref();
    }
    return this;
  }
  _bumpTimeout() {
    if (this._timeoutMs > 0) this.setTimeout(this._timeoutMs);
  }

  setNoDelay() { return this; }      // TCP_NODELAY already set natively
  setKeepAlive() { return this; }
  setEncoding(enc) { super.setEncoding && super.setEncoding(enc); this._enc = enc; return this; }

  ref() { const s = this._state; if (s.h != null) try { N.ref(s.h); } catch {} return this; }
  unref() { const s = this._state; if (s.h != null) try { N.unref(s.h); } catch {} return this; }

  address() {
    return this.localAddress
      ? { address: this.localAddress, port: this.localPort, family: this.remoteFamily === 6 ? "IPv6" : "IPv4" }
      : {};
  }

  destroy(err) {
    const s = this._state;
    if (s.destroyed) return this;
    s.destroyed = true;
    this.destroyed = true;
    if (this._timeout) { clearTimeout(this._timeout); this._timeout = null; }
    if (s.h != null) { try { N.close(s.h); } catch {} s.h = null; }
    if (err) process.nextTick(() => this.emit("error", err));
    process.nextTick(() => { this.emit("close", !!err); });
    return this;
  }
}

/* ---------------- Server ---------------- */

export class Server extends EventEmitter {
  constructor(opts, connectionListener) {
    super();
    if (typeof opts === "function") { connectionListener = opts; opts = {}; }
    this._opts = opts || {};
    this._h = null;
    this._port = null; this._address = null; this._family = 4;
    this.listening = false;
    if (connectionListener) this.on("connection", connectionListener);
  }

  listen(...args) {
    let port = 0, host = "", cb;
    if (args[0] && typeof args[0] === "object") {
      port = args[0].port || 0; host = args[0].host || "";
      cb = typeof args[1] === "function" ? args[1] : undefined;
    } else {
      port = args[0] || 0;
      let i = 1;
      if (typeof args[i] === "string") { host = args[i]; i++; }
      if (typeof args[i] === "number") i++; // backlog, ignored (native default)
      if (typeof args[i] === "function") cb = args[i];
    }
    if (cb) this.once("listening", cb);
    try {
      const res = N.netListen(host, port, 511, () => {
        for (;;) {
          let c;
          try { c = N.netAccept(this._h); } catch (e) { this.emit("error", e); break; }
          if (c == null) break;
          const sock = new Socket({ handle: c.id, remoteAddress: c.remoteAddress, remotePort: c.remotePort });
          this.emit("connection", sock);
        }
      });
      this._h = res.id;
      this._port = res.port; this._address = res.address; this._family = res.family;
      this.listening = true;
      process.nextTick(() => this.emit("listening"));
    } catch (e) {
      process.nextTick(() => this.emit("error", e));
    }
    return this;
  }

  address() {
    if (this._h == null) return null;
    return { port: this._port, address: this._address, family: this._family === 6 ? "IPv6" : "IPv4" };
  }

  close(cb) {
    if (this._h != null) { try { N.close(this._h); } catch {} this._h = null; }
    this.listening = false;
    if (typeof cb === "function") this.once("close", cb);
    process.nextTick(() => this.emit("close"));
    return this;
  }
  ref() { if (this._h != null) try { N.ref(this._h); } catch {} return this; }
  unref() { if (this._h != null) try { N.unref(this._h); } catch {} return this; }
}

/* ---------------- factory functions ---------------- */

export function connect(...args) {
  const s = new Socket();
  return s.connect(...args);
}
export const createConnection = connect;

export function createServer(opts, connectionListener) {
  return new Server(opts, connectionListener);
}

export const Stream = Socket; // legacy alias

// BlockList — IP allow/deny rules. Stores rules and checks membership.
export class BlockList {
  constructor() { this.rules = []; }
  addAddress(address, type = "ipv4") { this.rules.push({ kind: "address", address: String(address.address || address), type }); }
  addRange(start, end, type = "ipv4") { this.rules.push({ kind: "range", start: String(start), end: String(end), type }); }
  addSubnet(net, prefix, type = "ipv4") { this.rules.push({ kind: "subnet", net: String(net.address || net), prefix, type }); }
  check(address, type = "ipv4") {
    const a = String(address);
    for (const r of this.rules) if (r.kind === "address" && r.address === a) return true;
    return false; // range/subnet checks not implemented; default allow
  }
  get rules_() { return this.rules; }
}

export class SocketAddress {
  constructor(options = {}) {
    this.address = options.address || "127.0.0.1";
    this.port = options.port || 0;
    this.family = options.family || "ipv4";
    this.flowlabel = options.flowlabel || 0;
  }
}

export const Stream_ = Socket;

export default {
  Socket, Server, Stream, connect, createConnection, createServer,
  isIP, isIPv4, isIPv6, BlockList, SocketAddress,
};
