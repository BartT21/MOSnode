// node:tls — TLSSocket over a net.Socket, driving OpenSSL via memory BIOs.
// The underlying net.Socket carries ciphertext; this layer feeds it to the
// SSL engine (tlsReceive), pulls decrypted plaintext (tlsRead), encrypts
// outgoing plaintext (tlsWrite) and flushes the ciphertext OpenSSL produces
// (tlsOutgoing) back onto the socket.
import * as N from "native";
import net from "net";
import { Duplex } from "./stream.js";
import { Buffer } from "./buffer.js";

export class TLSSocket extends Duplex {
  constructor(socket, options = {}) {
    const state = {
      tlssock: null, id: null, hs: false, destroyed: false,
      pending: [], finalCb: null,
    };
    super({
      read() { state.tlssock._pump(); },
      write(chunk, enc, cb) {
        if (!state.hs) { state.pending.push({ chunk, cb }); return; }
        state.tlssock._doWrite(chunk, cb);
      },
      final(cb) {
        if (!state.hs) { state.finalCb = cb; return; }
        try { N.tlsShutdown(state.id); state.tlssock._flushOut(); } catch {}
        cb();
      },
    });
    state.tlssock = this;
    this._state = state;
    this._socket = socket;
    this.encrypted = true;
    this.authorized = false;
    this.authorizationError = null;
    this.alpnProtocol = null;
    this._protocol = null;

    const reject = options.rejectUnauthorized !== false;
    this._rejectUnauthorized = reject;
    const servername = options.servername || (typeof options.host === "string" ? options.host : "");
    // mosnode speaks HTTP/1.1 only: strip h2/h2c so the server never negotiates
    // HTTP/2 (undici then transparently uses its HTTP/1.1 path).
    let alpnList = options.ALPNProtocols;
    if (alpnList) alpnList = (Array.isArray(alpnList) ? alpnList : [String(alpnList)]).filter((p) => p !== "h2" && p !== "h2c");
    if (!alpnList || !alpnList.length) alpnList = ["http/1.1"];
    const alpn = alpnList.join(",");
    state.id = N.tlsConnect(servername, reject, alpn);
    this.servername = servername;

    socket.on("data", (d) => this._onCipher(d));
    socket.on("error", (e) => { if (!state.destroyed) this.emit("error", e); });
    socket.on("close", () => {
      // Connection dropped before the handshake finished = handshake failure,
      // not a clean close (otherwise the TLSSocket would hang forever).
      if (!state.hs && !state.destroyed) {
        const err = new Error("TLS handshake failed: connection closed (" + N.tlsLastError(state.id) + ")");
        err.code = "ECONNRESET";
        this._fail(err);
        return;
      }
      this._cleanup();
      process.nextTick(() => this.emit("close"));
    });
    socket.on("end", () => { if (state.hs) this.push(null); });

    if (socket.connecting) socket.once("connect", () => this._startHandshake());
    else process.nextTick(() => this._startHandshake());
  }

  _startHandshake() {
    const s = this._state;
    if (s.destroyed) return;
    const st = N.tlsHandshake(s.id); // emits ClientHello into the out BIO
    this._flushOut();
    if (st < 0) this._fail();
  }

  _onCipher(d) {
    const s = this._state;
    if (s.destroyed) return;
    try { N.tlsReceive(s.id, d); } catch (e) { this._fail(e); return; }
    if (!s.hs) {
      const st = N.tlsHandshake(s.id);
      this._flushOut();
      if (st === 0) this._onHandshakeDone();
      else if (st < 0) this._fail();
      return; // still handshaking (or just finished — _pump happens there)
    }
    this._pump();
  }

  _onHandshakeDone() {
    const s = this._state;
    s.hs = true;
    const info = N.tlsInfo(s.id);
    this.authorized = info.authorized;
    this.authorizationError = info.authError ? new Error(info.authError) : null;
    this.alpnProtocol = info.alpn;
    this._protocol = info.protocol;
    this._cipher = info.cipher;
    if (this._rejectUnauthorized && !info.authorized) {
      const err = new Error(info.authError || "certificate verification failed");
      err.code = "CERT_VERIFY_FAILED";
      this._fail(err);
      return;
    }
    this.emit("secureConnect");
    const q = s.pending; s.pending = [];
    for (const w of q) this._doWrite(w.chunk, w.cb);
    if (s.finalCb) { const cb = s.finalCb; s.finalCb = null; try { N.tlsShutdown(s.id); this._flushOut(); } catch {} cb(); }
    this._pump();
  }

  _pump() {
    const s = this._state;
    if (!s.hs || s.destroyed) return;
    for (;;) {
      let chunk;
      try { chunk = N.tlsRead(s.id); } catch (e) { this._fail(e); return; }
      if (chunk === null) break;         // want more ciphertext
      if (chunk === false) { this.push(null); break; } // closed
      if (!this.push(chunk)) break;      // backpressure; resumes via read()
    }
    this._flushOut();
  }

  _doWrite(chunk, cb) {
    const s = this._state;
    if (typeof chunk === "string") chunk = Buffer.from(chunk);
    let off = 0;
    while (off < chunk.length) {
      let n;
      try { n = N.tlsWrite(s.id, off === 0 ? chunk : chunk.slice(off)); }
      catch (e) { this._flushOut(); return cb(e); }
      if (n < 0) { this._flushOut(); return cb(new Error("TLS write failed: " + N.tlsLastError(s.id))); }
      if (n === 0) break; // WANT_IO (rare with growable mem BIO)
      off += n;
    }
    this._flushOut();
    cb();
  }

  _flushOut() {
    const s = this._state;
    if (s.id == null) return;
    for (;;) {
      let out;
      try { out = N.tlsOutgoing(s.id); } catch { break; }
      if (!out || out.length === 0) break;
      this._socket.write(out);
    }
  }

  _fail(err) {
    const s = this._state;
    if (!err) err = new Error("TLS error: " + N.tlsLastError(s.id));
    this.destroy(err);
  }
  _cleanup() {
    const s = this._state;
    if (s.id != null) { try { N.tlsFree(s.id); } catch {} s.id = null; }
  }
  destroy(err) {
    const s = this._state;
    if (s.destroyed) return this;
    s.destroyed = true;
    this._cleanup();
    try { this._socket.destroy(); } catch {}
    if (err) process.nextTick(() => this.emit("error", err));
    process.nextTick(() => this.emit("close", !!err));
    return this;
  }

  getProtocol() { return this._protocol || null; }
  getCipher() { return { name: this._cipher || "" }; }
  getPeerCertificate() { return {}; }
  setTimeout(ms, cb) { this._socket.setTimeout(ms, cb); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { this._socket.ref(); return this; }
  unref() { this._socket.unref(); return this; }
  address() { return this._socket.address ? this._socket.address() : {}; }
  get remoteAddress() { return this._socket.remoteAddress; }
  get remotePort() { return this._socket.remotePort; }
  get localAddress() { return this._socket.localAddress; }
  get localPort() { return this._socket.localPort; }
}

export function connect(...args) {
  let options, cb;
  if (args[0] && typeof args[0] === "object") { options = { ...args[0] }; cb = args[1]; }
  else {
    options = {};
    let i = 0;
    options.port = args[i++];
    if (typeof args[i] === "string") options.host = args[i++];
    if (args[i] && typeof args[i] === "object") Object.assign(options, args[i++]);
    cb = args[i];
  }
  const host = options.host || "localhost";
  const port = options.port;
  if (!options.servername && typeof host === "string") options.servername = host;
  const socket = options.socket || net.connect({ host, port });
  const tsock = new TLSSocket(socket, options);
  if (typeof cb === "function") tsock.once("secureConnect", cb);
  return tsock;
}

export const createConnection = connect;
export function createSecureContext() { return {}; }
export const rootCertificates = [];
export const DEFAULT_MIN_VERSION = "TLSv1.2";

export default {
  connect, createConnection, TLSSocket, createSecureContext,
  rootCertificates, DEFAULT_MIN_VERSION,
};
