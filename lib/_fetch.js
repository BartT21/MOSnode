// WHATWG fetch + Headers/Request/Response/Blob/FormData on top of http/https.
// response.body is a real web ReadableStream so streaming (SSE) works.
import http from "http";
import https from "https";
import { Buffer } from "./buffer.js";
import { URL, URLSearchParams } from "./url.js";

const g = globalThis;

/* ---------------- Headers ---------------- */
class Headers {
  constructor(init) {
    this._map = new Map(); // lowercased name -> array of values
    if (init) {
      if (init instanceof Headers) for (const [k, v] of init) this.append(k, v);
      else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
      else for (const k of Object.keys(init)) this.append(k, init[k]);
    }
  }
  append(name, value) {
    const k = String(name).toLowerCase();
    const arr = this._map.get(k) || [];
    arr.push(String(value));
    this._map.set(k, arr);
  }
  set(name, value) { this._map.set(String(name).toLowerCase(), [String(value)]); }
  get(name) { const a = this._map.get(String(name).toLowerCase()); return a ? a.join(", ") : null; }
  getSetCookie() { return this._map.get("set-cookie") || []; }
  has(name) { return this._map.has(String(name).toLowerCase()); }
  delete(name) { this._map.delete(String(name).toLowerCase()); }
  forEach(cb, thisArg) { for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this); }
  *entries() { for (const [k, arr] of this._map) yield [k, arr.join(", ")]; }
  *keys() { for (const k of this._map.keys()) yield k; }
  *values() { for (const [, arr] of this._map) yield arr.join(", "); }
  [Symbol.iterator]() { return this.entries(); }
  // raw per-request header object for http.request (preserve multi-values)
  _raw() { const o = {}; for (const [k, arr] of this._map) o[k] = arr.length === 1 ? arr[0] : arr; return o; }
}

/* ---------------- Blob ---------------- */
class Blob {
  constructor(parts = [], options = {}) {
    const bufs = [];
    for (const p of parts) {
      if (p instanceof Blob) bufs.push(p._buf);
      else if (typeof p === "string") bufs.push(Buffer.from(p, "utf8"));
      else if (p instanceof ArrayBuffer) bufs.push(Buffer.from(new Uint8Array(p)));
      else if (ArrayBuffer.isView(p)) bufs.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
      else bufs.push(Buffer.from(String(p), "utf8"));
    }
    this._buf = Buffer.concat(bufs);
    this.type = options.type || "";
  }
  get size() { return this._buf.length; }
  async text() { return this._buf.toString("utf8"); }
  async arrayBuffer() { return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength); }
  async bytes() { return new Uint8Array(this._buf); }
  slice(start, end, type) { const b = new Blob([], { type: type || this.type }); b._buf = this._buf.slice(start, end); return b; }
  stream() { const buf = this._buf; return new g.ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }); }
}
class File extends Blob {
  constructor(parts, name, options = {}) { super(parts, options); this.name = String(name); this.lastModified = options.lastModified || Date.now(); }
}

/* ---------------- FormData ---------------- */
class FormData {
  constructor() { this._entries = []; }
  append(name, value, filename) { this._entries.push([String(name), toFormValue(value, filename)]); }
  set(name, value, filename) { this.delete(name); this.append(name, value, filename); }
  get(name) { const e = this._entries.find((x) => x[0] === name); return e ? e[1] : null; }
  getAll(name) { return this._entries.filter((x) => x[0] === name).map((x) => x[1]); }
  has(name) { return this._entries.some((x) => x[0] === name); }
  delete(name) { this._entries = this._entries.filter((x) => x[0] !== name); }
  forEach(cb, thisArg) { for (const [k, v] of this._entries) cb.call(thisArg, v, k, this); }
  *entries() { yield* this._entries; }
  *keys() { for (const [k] of this._entries) yield k; }
  *values() { for (const [, v] of this._entries) yield v; }
  [Symbol.iterator]() { return this.entries(); }
}
function toFormValue(value, filename) {
  if (value instanceof Blob) { if (filename && !(value instanceof File)) return new File([value], filename, { type: value.type }); return value; }
  return String(value);
}
function serializeFormData(fd) {
  const boundary = "----mosnodeFormBoundary" + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [name, value] of fd._entries) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (value instanceof Blob) {
      head += `; filename="${value instanceof File ? value.name : "blob"}"\r\nContent-Type: ${value.type || "application/octet-stream"}\r\n\r\n`;
      parts.push(Buffer.from(head, "utf8"), value._buf, Buffer.from("\r\n", "utf8"));
    } else {
      head += `\r\n\r\n${value}\r\n`;
      parts.push(Buffer.from(head, "utf8"));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/* ---------------- body extraction ---------------- */
// Returns { body: Buffer|ReadableStream|null, contentType: string|null }
function extractBody(input) {
  if (input == null) return { body: null, contentType: null };
  if (typeof input === "string") return { body: Buffer.from(input, "utf8"), contentType: "text/plain;charset=UTF-8" };
  if (input instanceof URLSearchParams) return { body: Buffer.from(input.toString(), "utf8"), contentType: "application/x-www-form-urlencoded;charset=UTF-8" };
  if (input instanceof Blob) return { body: input._buf, contentType: input.type || null };
  if (input instanceof FormData) { const s = serializeFormData(input); return { body: s.body, contentType: s.contentType }; }
  if (Buffer.isBuffer(input)) return { body: input, contentType: null };
  if (input instanceof ArrayBuffer) return { body: Buffer.from(new Uint8Array(input)), contentType: null };
  if (ArrayBuffer.isView(input)) return { body: Buffer.from(input.buffer, input.byteOffset, input.byteLength), contentType: null };
  if (g.ReadableStream && input instanceof g.ReadableStream) return { body: input, contentType: null };
  if (input && typeof input.pipe === "function") return { body: input, contentType: null };
  return { body: Buffer.from(String(input), "utf8"), contentType: "text/plain;charset=UTF-8" };
}

async function streamToBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
  return Buffer.concat(chunks);
}

/* ---------------- Body mixin (for Request/Response) ---------------- */
function defineBody(proto) {
  proto.arrayBuffer = async function () { const b = await this._consume(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  proto.text = async function () { return (await this._consume()).toString("utf8"); };
  proto.json = async function () { return JSON.parse((await this._consume()).toString("utf8")); };
  proto.bytes = async function () { return new Uint8Array(await this._consume()); };
  proto.blob = async function () { return new Blob([await this._consume()], { type: this.headers.get("content-type") || "" }); };
  proto.formData = async function () {
    const ct = this.headers.get("content-type") || "";
    const text = (await this._consume()).toString("utf8");
    const fd = new FormData();
    if (ct.includes("application/x-www-form-urlencoded")) for (const [k, v] of new URLSearchParams(text)) fd.append(k, v);
    return fd;
  };
}

/* ---------------- Response ---------------- */
class Response {
  constructor(body, init = {}) {
    this.status = init.status != null ? init.status : 200;
    this.statusText = init.statusText != null ? init.statusText : "";
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    this.ok = this.status >= 200 && this.status < 300;
    this.redirected = !!init.redirected;
    this.type = init.type || "basic";
    this.url = init.url || "";
    this.bodyUsed = false;
    this._incoming = init._incoming || null; // node IncomingMessage (streaming)
    if (this._incoming) { this._bodyBuf = null; }
    else { const ex = extractBody(body); this._bodyBuf = ex.body == null ? Buffer.alloc(0) : (Buffer.isBuffer(ex.body) ? ex.body : Buffer.from(String(ex.body))); if (ex.contentType && !this.headers.has("content-type")) this.headers.set("content-type", ex.contentType); }
  }
  static json(data, init = {}) {
    const h = new Headers(init.headers); if (!h.has("content-type")) h.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { ...init, headers: h });
  }
  static error() { return new Response(null, { status: 0, type: "error" }); }
  static redirect(url, status = 302) { return new Response(null, { status, headers: { location: String(url) } }); }
  // Read the underlying IncomingMessage exactly once, caching the full buffer.
  // All consumers (text/json/arrayBuffer/body/clone) share this, so reading the
  // body more than once (e.g. the SDK peeking at an error body after the body
  // getter was touched) is idempotent rather than throwing "already consumed".
  _buffered() {
    if (this._bufPromise) return this._bufPromise;
    if (this._incoming) {
      this._bufPromise = new Promise((resolve, reject) => {
        const chunks = [];
        this._incoming.on("data", (c) => chunks.push(Buffer.from(c)));
        this._incoming.on("end", () => resolve(Buffer.concat(chunks)));
        this._incoming.on("error", reject);
      });
    } else {
      this._bufPromise = Promise.resolve(this._bodyBuf || Buffer.alloc(0));
    }
    return this._bufPromise;
  }
  async _consume() {
    const buf = await this._buffered();
    this.bodyUsed = true;
    return buf;
  }
  get body() {
    if (this._webBody) return this._webBody;
    const self = this;
    if (this._incoming && !this._bufPromise) {
      // True streaming path (not yet buffered): stream chunks as they arrive.
      this._webBody = new g.ReadableStream({
        start(controller) {
          self.bodyUsed = true;
          self._incoming.on("data", (c) => { try { controller.enqueue(new Uint8Array(Buffer.from(c))); } catch {} });
          self._incoming.on("end", () => { try { controller.close(); } catch {} });
          self._incoming.on("error", (e) => { try { controller.error(e); } catch {} });
        },
        cancel() { try { self._incoming.destroy(); } catch {} },
      });
    } else {
      // Already buffered (or inline body): serve from the cached buffer.
      this._webBody = new g.ReadableStream({
        start(c) {
          Promise.resolve(self._buffered()).then((buf) => {
            try { if (buf && buf.length) c.enqueue(new Uint8Array(buf)); c.close(); } catch {}
          });
        },
      });
    }
    return this._webBody;
  }
  clone() {
    // Buffer the body so both copies can be read independently.
    const r = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected, type: this.type });
    r._bufPromise = this._buffered();
    r._bodyBuf = null;
    return r;
  }
}
defineBody(Response.prototype);

/* ---------------- Request ---------------- */
class Request {
  constructor(input, init = {}) {
    if (input instanceof Request) {
      this.url = input.url; this.method = init.method || input.method;
      this.headers = new Headers(init.headers || input.headers);
      this._bodyInit = init.body !== undefined ? init.body : input._bodyInit;
    } else {
      this.url = typeof input === "string" ? input : String(input.url || input);
      this.method = (init.method || "GET").toUpperCase();
      this.headers = new Headers(init.headers);
      this._bodyInit = init.body;
    }
    this.signal = init.signal || null;
    this.redirect = init.redirect || "follow";
    this.credentials = init.credentials || "same-origin";
    this.mode = init.mode || "cors";
    this.bodyUsed = false;
    this._bodyBuf = null;
  }
  async _consume() {
    if (this._bodyBuf) return this._bodyBuf;
    const ex = extractBody(this._bodyInit);
    this._bodyBuf = ex.body == null ? Buffer.alloc(0) : (Buffer.isBuffer(ex.body) ? ex.body : await streamToBuffer(ex.body));
    return this._bodyBuf;
  }
  clone() { return new Request(this.url, { method: this.method, headers: this.headers, body: this._bodyInit, signal: this.signal }); }
}
defineBody(Request.prototype);

/* ---------------- fetch ---------------- */
async function fetch(input, init = {}) {
  const req = input instanceof Request && init && Object.keys(init).length === 0 ? input : new Request(input, init);
  const signal = req.signal;
  if (signal && signal.aborted) { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }

  let redirectCount = 0;
  let url = req.url;
  let method = req.method;
  const ex = extractBody(req._bodyInit);
  let bodyBytes = ex.body;
  if (bodyBytes && g.ReadableStream && bodyBytes instanceof g.ReadableStream) bodyBytes = await streamToBuffer(bodyBytes);

  for (;;) {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers = req.headers._raw();
    if (ex.contentType && !req.headers.has("content-type")) headers["content-type"] = ex.contentType;
    if (bodyBytes && Buffer.isBuffer(bodyBytes) && !req.headers.has("content-length")) headers["content-length"] = String(bodyBytes.length);
    if (!req.headers.has("accept")) headers["accept"] = "*/*";

    const incoming = await new Promise((resolve, reject) => {
      const r = lib.request({
        protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), host: u.hostname,
        port: u.port || (isHttps ? 443 : 80), path: (u.pathname || "/") + (u.search || ""),
        method, headers,
      }, resolve);
      r.on("error", reject);
      let aborted = false;
      if (signal) {
        const onAbort = () => { if (aborted) return; aborted = true; r.destroy(); const e = new Error("The operation was aborted"); e.name = "AbortError"; reject(e); };
        signal.addEventListener ? signal.addEventListener("abort", onAbort, { once: true }) : (signal.onabort = onAbort);
      }
      if (bodyBytes && Buffer.isBuffer(bodyBytes) && bodyBytes.length) r.write(bodyBytes);
      r.end();
    });

    const status = incoming.statusCode;
    // handle redirects
    if ([301, 302, 303, 307, 308].includes(status) && req.redirect === "follow" && incoming.headers.location && redirectCount < 20) {
      redirectCount++;
      url = new URL(incoming.headers.location, url).href;
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) { method = "GET"; bodyBytes = null; }
      incoming.resume(); // drain
      continue;
    }

    const h = new Headers();
    for (const [k, v] of Object.entries(incoming.headers)) {
      if (Array.isArray(v)) for (const vv of v) h.append(k, vv); else h.append(k, v);
    }
    return new Response(null, {
      status, statusText: incoming.statusMessage || "",
      headers: h, url, redirected: redirectCount > 0, _incoming: incoming,
    });
  }
}

/* ---------------- install globals ---------------- */
if (typeof g.fetch === "undefined") g.fetch = fetch;
if (typeof g.Headers === "undefined") g.Headers = Headers;
if (typeof g.Request === "undefined") g.Request = Request;
if (typeof g.Response === "undefined") g.Response = Response;
if (typeof g.FormData === "undefined") g.FormData = FormData;
if (typeof g.Blob === "undefined") g.Blob = Blob;
if (typeof g.File === "undefined") g.File = File;

export { fetch, Headers, Request, Response, FormData, Blob, File };
export default { fetch, Headers, Request, Response, FormData, Blob, File };
