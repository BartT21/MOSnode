// Web platform globals Node provides that cli.js depends on: globalThis.crypto
// (Web Crypto), AbortSignal.any, navigator, MessageChannel/MessagePort.
import { createHash, createHmac, randomUUID as nodeRandomUUID, randomBytes } from "./crypto.js";
import { Buffer } from "./buffer.js";

const g = globalThis;

/* ---------------- Web Crypto ---------------- */
function toBuf(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}
function toAB(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

function getRandomValues(arr) {
  if (!ArrayBuffer.isView(arr)) throw new TypeError("getRandomValues expects a TypedArray");
  const rnd = randomBytes(arr.byteLength);
  new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(new Uint8Array(rnd.buffer, rnd.byteOffset, rnd.byteLength));
  return arr;
}

const HASH = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" };
function hashName(algo) {
  const n = typeof algo === "string" ? algo : (algo && algo.name) || algo;
  return HASH[n] || HASH[String(n).toUpperCase()] || "sha256";
}

const subtle = {
  async digest(algo, data) {
    const h = createHash(hashName(algo));
    h.update(toBuf(data));
    return toAB(h.digest());
  },
  async importKey(format, keyData, algorithm, extractable, usages) {
    return { type: "secret", extractable: !!extractable, algorithm, usages: usages || [], _bytes: toBuf(keyData), _format: format };
  },
  async exportKey(format, key) {
    if ((format === "raw" || format === undefined) && key && key._bytes) return toAB(key._bytes);
    throw new Error("subtle.exportKey: only raw secret keys supported");
  },
  async generateKey(algorithm, extractable, usages) {
    const name = String((algorithm && algorithm.name) || algorithm).toUpperCase();
    if (name === "HMAC") {
      const bits = (algorithm && algorithm.length) || 256;
      return { type: "secret", extractable: !!extractable, algorithm, usages: usages || [], _bytes: randomBytes(Math.ceil(bits / 8)) };
    }
    throw new Error("subtle.generateKey: only HMAC supported in mosnode");
  },
  async sign(algorithm, key, data) {
    const name = String((algorithm && algorithm.name) || algorithm).toUpperCase();
    if (name === "HMAC") {
      const hn = hashName((key.algorithm && key.algorithm.hash) || "SHA-256");
      const hm = createHmac(hn, key._bytes);
      hm.update(toBuf(data));
      return toAB(hm.digest());
    }
    throw new Error("subtle.sign: only HMAC supported in mosnode");
  },
  async verify(algorithm, key, signature, data) {
    const expected = Buffer.from(new Uint8Array(await this.sign(algorithm, key, data)));
    const sig = toBuf(signature);
    return expected.length === sig.length && expected.equals(sig);
  },
};

const webcrypto = {
  randomUUID: () => nodeRandomUUID(),
  getRandomValues,
  subtle,
};
if (!g.crypto) g.crypto = webcrypto;
else {
  if (!g.crypto.subtle) try { g.crypto.subtle = subtle; } catch {}
  if (!g.crypto.getRandomValues) try { g.crypto.getRandomValues = getRandomValues; } catch {}
  if (!g.crypto.randomUUID) try { g.crypto.randomUUID = () => nodeRandomUUID(); } catch {}
}

/* AbortSignal.any/.timeout are defined on the AbortSignal class in _globals.js. */

/* ---------------- navigator ---------------- */
if (!g.navigator) {
  g.navigator = { userAgent: "mosnode", platform: "morphos", language: "en-US", languages: ["en-US"], hardwareConcurrency: 1, onLine: true };
}

/* ---------------- MessageChannel / MessagePort ---------------- */
if (!g.MessageChannel) {
  class MessagePort {
    constructor() { this._other = null; this._onmessage = null; this._listeners = []; this._started = false; this._queue = []; }
    postMessage(data) {
      const other = this._other;
      if (!other) return;
      const ev = { data, target: other };
      queueMicrotask(() => {
        if (!other._started && !other._onmessage && other._listeners.length === 0) { other._queue.push(ev); return; }
        other._deliver(ev);
      });
    }
    _deliver(ev) {
      if (this._onmessage) try { this._onmessage(ev); } catch {}
      for (const l of this._listeners.slice()) try { l(ev); } catch {}
    }
    set onmessage(fn) { this._onmessage = fn; this.start(); }
    get onmessage() { return this._onmessage; }
    addEventListener(type, fn) { if (type === "message") { this._listeners.push(fn); this.start(); } }
    removeEventListener(type, fn) { this._listeners = this._listeners.filter((l) => l !== fn); }
    start() { if (this._started) return; this._started = true; const q = this._queue; this._queue = []; for (const ev of q) queueMicrotask(() => this._deliver(ev)); }
    close() { this._other = null; }
    dispatchEvent() { return true; }
  }
  class MessageChannel {
    constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1._other = this.port2; this.port2._other = this.port1; }
  }
  g.MessagePort = MessagePort;
  g.MessageChannel = MessageChannel;
}
