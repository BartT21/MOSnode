// node:crypto — hashes via noble-hashes, random via native
import * as N from "native";
import * as h from "./_vendor/noble_hashes.js";

const algos = { md5: h.md5, sha1: h.sha1, sha224: h.sha224, sha256: h.sha256, sha384: h.sha384, sha512: h.sha512,
  sha3_256: h.sha3_256, sha3_512: h.sha3_512 };
if (h.hmac) algos.hmac = h.hmac;

function get(alg) {
  const f = algos[String(alg).toLowerCase()];
  if (!f) { const e = new TypeError(`Unknown digest: ${alg}`); e.code = "ERR_CRYPTO_INVALID_DIGEST"; throw e; }
  return f;
}

export function createHash(alg) {
  const fn = get(alg);
  const parts = [];
  return {
    update(data) { parts.push(Buffer.from(data)); return this; },
    digest(enc) {
      const out = Buffer.from(fn(Buffer.concat(parts)));
      if (!enc) return out;
      if (enc === "hex") return out.toString("hex");
      if (enc === "base64") return out.toString("base64");
      if (enc === "latin1" || enc === "ascii") return out.toString("latin1");
      return out.toString("utf8");
    },
  };
}
export function hash(alg, data) { return Buffer.from(get(alg)(data)); }
export function createHmac(alg, key) {
  const fn = get(alg);
  const parts = [];
  const keyBuf = Buffer.from(key);
  return {
    update(data) { parts.push(Buffer.from(data)); return this; },
    digest(enc) {
      let out;
      if (h.hmac) out = Buffer.from(h.hmac(fn, keyBuf, Buffer.concat(parts)));
      else {
        // simple hmac construction not available; fail loudly
        throw new Error("hmac unavailable");
      }
      if (!enc) return out;
      if (enc === "hex") return out.toString("hex");
      if (enc === "base64") return out.toString("base64");
      return out.toString("utf8");
    },
  };
}
export function hmac(alg, key, data) {
  const m = createHmac(alg, key); m.update(data); return m.digest();
}
export const randomBytes = (n) => Buffer.from(N.randomBytes(n));
export const randomFillSync = (buf, off, len) => { N.randomFill(buf, off, len); return buf; };
export const randomFill = (buf, off, len, cb) => {
  if (typeof off === "function") cb = off;
  Promise.resolve().then(() => { N.randomFill(buf); cb(null, buf); });
};
export function randomUUID() {
  const b = N.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const randomInt = (a, b) => {
  if (b === undefined) { b = a; a = 0; }
  return a + Math.floor(Math.random() * (b - a));
};
export function pbkdf2Sync(pw, salt, iters, keylen, alg) {
  // pbkdf2-hmac-sha256 via noble if present
  if (h.pbkdf2) return Buffer.from(h.pbkdf2(get(alg), Buffer.from(pw), Buffer.from(salt), iters, keylen));
  if (h.pbkdf2Async) throw new Error("pbkdf2 async-only");
  throw new Error("pbkdf2 unavailable");
}
export function pbkdf2(pw, salt, iters, keylen, alg, cb) {
  Promise.resolve().then(() => cb(null, pbkdf2Sync(pw, salt, iters, keylen, alg)));
}
export function scryptSync() { throw new Error("scrypt unavailable"); }
export function scrypt() { throw new Error("scrypt unavailable"); }
export function createCipheriv() { throw new Error("ciphers unavailable"); }
export function createDecipheriv() { throw new Error("ciphers unavailable"); }
export const getCiphers = () => [];
export const getHashes = () => Object.keys(algos);
export class WebCrypto {}
export const webcrypto = undefined;
export const constants = {};
export function generateKeyPairSync() { throw new Error("keygen unavailable"); }
export function generateKeyPair(type, opts, cb) { if (typeof opts === "function") { cb = opts; } process.nextTick(() => cb(new Error("keygen unavailable"))); }
export function createSign() { throw new Error("sign unavailable"); }
export function createVerify() { throw new Error("verify unavailable"); }

// KeyObject wrappers. These hold key material so it can be passed to TLS
// (client certs) etc.; they do not perform standalone sign/verify yet.
export class KeyObject {
  constructor(type, material) { this.type = type; this._material = material; this.asymmetricKeyType = undefined; }
  export(opts) { return this._material && this._material.key != null ? this._material.key : this._material; }
  get symmetricKeySize() { return this._material && this._material.length; }
}
export function createPrivateKey(key) {
  const material = typeof key === "string" || key instanceof Uint8Array ? { key } : key;
  return new KeyObject("private", material);
}
export function createPublicKey(key) {
  const material = typeof key === "string" || key instanceof Uint8Array ? { key } : key;
  return new KeyObject("public", material);
}
export function createSecretKey(key, encoding) {
  const buf = typeof key === "string" ? Buffer.from(key, encoding) : Buffer.from(key);
  return new KeyObject("secret", buf);
}
export const timingSafeEqual = (a, b) => {
  a = Buffer.from(a); b = Buffer.from(b);
  if (a.length !== b.length) throw new RangeError("buffers must be same length");
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
};

export default { createHash, createHmac, randomBytes, randomUUID, randomFillSync, pbkdf2Sync, getHashes, timingSafeEqual };
