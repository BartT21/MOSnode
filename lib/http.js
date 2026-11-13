// node:http — HTTP/1.1 client and server, hand-rolled over net.Socket.
// No llhttp/wasm: a small JS parser handles status/headers, Content-Length,
// chunked transfer-encoding, and read-until-close bodies.
import net from "net";
import { Readable } from "./stream.js";
import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";
import { URL } from "./url.js";

export const METHODS = [
  "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD",
  "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE",
  "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE",
  "PUT", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE",
  "UNBIND", "UNLOCK", "UNSUBSCRIBE",
];

export const STATUS_CODES = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
  204: "No Content", 205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
  208: "Already Reported", 226: "IM Used",
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other",
  304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden",
  404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable",
  407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict",
  410: "Gone", 411: "Length Required", 412: "Precondition Failed",
  413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type",
  416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot",
  421: "Misdirected Request", 422: "Unprocessable Entity", 425: "Too Early",
  426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
  507: "Insufficient Storage", 508: "Loop Detected", 511: "Network Authentication Required",
};

/* ---------------- byte helpers ---------------- */

function indexOfDblCRLF(buf, start = 0) {
  for (let i = start; i + 3 < buf.length; i++)
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  return -1;
}
function indexOfCRLF(buf, start = 0) {
  for (let i = start; i + 1 < buf.length; i++)
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}
function parseHeaderBlock(text) {
  const lines = text.split("\r\n");
  const first = lines.shift();
  const headers = {}; const rawHeaders = [];
  for (const line of lines) {
    if (!line) continue;
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const name = line.slice(0, ci).trim();
    const val = line.slice(ci + 1).trim();
    const lc = name.toLowerCase();
    rawHeaders.push(name, val);
    if (headers[lc] !== undefined) {
      if (lc === "set-cookie") { if (!Array.isArray(headers[lc])) headers[lc] = [headers[lc]]; headers[lc].push(val); }
      else headers[lc] += ", " + val;
    } else headers[lc] = lc === "set-cookie" ? [val] : val;
  }
  return { first, headers, rawHeaders };
}

/* ---------------- IncomingMessage ---------------- */

export class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = this.connection = socket;
    this.headers = {};
    this.rawHeaders = [];
    this.httpVersion = "1.1";
    this.httpVersionMajor = 1; this.httpVersionMinor = 1;
    this.statusCode = null; this.statusMessage = null;
    this.method = null; this.url = null;
    this.complete = false;
    this.aborted = false;
  }
  _read() {}
  setTimeout(ms, cb) { if (this.socket) this.socket.setTimeout(ms, cb); return this; }
}

/* ---------------- body parsers ---------------- */

function makeBodyParser(msg, onComplete) {
  const te = String(msg.headers["transfer-encoding"] || "").toLowerCase();
  const cl = msg.headers["content-length"];
  let finished = false;
  const done = () => { if (finished) return; finished = true; msg.complete = true; msg.push(null); onComplete && onComplete(); };

  if (te.indexOf("chunked") !== -1) {
    let buf = Buffer.alloc(0);
    const parse = () => {
      for (;;) {
        const idx = indexOfCRLF(buf);
        if (idx === -1) return;
        const size = parseInt(buf.slice(0, idx).toString("latin1").trim(), 16);
        if (Number.isNaN(size)) return;
        if (size === 0) { buf = Buffer.alloc(0); done(); return; }
        if (buf.length < idx + 2 + size + 2) return; // need full chunk + CRLF
        msg.push(buf.slice(idx + 2, idx + 2 + size));
        buf = buf.slice(idx + 2 + size + 2);
      }
    };
    return { push(d) { buf = Buffer.concat([buf, d]); parse(); }, end() { done(); } };
  }
  if (cl !== undefined) {
    let remaining = parseInt(cl, 10) || 0;
    if (remaining <= 0) return { push() {}, end() { done(); }, immediateDone: true };
    return {
      push(d) {
        if (remaining <= 0) return;
        if (d.length >= remaining) { msg.push(d.slice(0, remaining)); remaining = 0; done(); }
        else { msg.push(d); remaining -= d.length; }
      },
      end() { done(); },
    };
  }
  // no length => body runs until the socket closes
  return { push(d) { if (d.length) msg.push(d); }, end() { done(); } };
}

/* ---------------- ClientRequest ---------------- */

export class ClientRequest extends EventEmitter {
  constructor(options, cb) {
    super();
    const o = options;
    this.method = (o.method || "GET").toUpperCase();
    this.path = o.path || "/";
    this.host = o.hostname || o.host || "localhost";
    this.protocol = o.protocol || (o._https ? "https:" : "http:");
    this.port = o.port ? +o.port : (o._https ? 443 : 80);
    this._headers = {}; this._headerNames = {};
    this.headersSent = false;
    this.finished = false;
    this.destroyed = false;
    this.socket = this.connection = null;
    this.reusedSocket = false;
    this._body = [];
    this._opts = o;
    this._https = !!o._https;
    this._createConnection = o.createConnection;
    this._timeoutMs = o.timeout;
    this.agent = o.agent;
    if (o.headers) for (const k in o.headers) this.setHeader(k, o.headers[k]);
    if (o.auth) this.setHeader("Authorization", "Basic " + Buffer.from(o.auth).toString("base64"));
    if (cb) this.once("response", cb);
  }

  setHeader(name, val) { const lc = name.toLowerCase(); this._headerNames[lc] = name; this._headers[lc] = val; return this; }
  getHeader(name) { return this._headers[name.toLowerCase()]; }
  getHeaders() { const o = {}; for (const lc in this._headers) o[lc] = this._headers[lc]; return o; }
  hasHeader(name) { return this._headers[name.toLowerCase()] !== undefined; }
  removeHeader(name) { const lc = name.toLowerCase(); delete this._headers[lc]; delete this._headerNames[lc]; }
  setNoDelay() { return this; }
  flushHeaders() {}

  write(chunk, enc, cb) {
    if (typeof enc === "function") { cb = enc; enc = undefined; }
    if (chunk != null) {
      if (typeof chunk === "string") chunk = Buffer.from(chunk, enc || "utf8");
      if (chunk.length) this._body.push(chunk);
    }
    if (cb) cb();
    return true;
  }

  end(chunk, enc, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    else if (typeof enc === "function") { cb = enc; enc = undefined; }
    if (chunk != null) this.write(chunk, enc);
    if (cb) this.once("finish", cb);
    this._send();
    return this;
  }

  _hostHeader() {
    const def = this._https ? 443 : 80;
    return this.port === def ? this.host : `${this.host}:${this.port}`;
  }

  _send() {
    if (this.finished || this.destroyed) return;
    this.finished = true;
    const body = this._body.length ? Buffer.concat(this._body) : Buffer.alloc(0);
    if (body.length > 0 && !this.hasHeader("content-length") && !this.hasHeader("transfer-encoding"))
      this.setHeader("Content-Length", String(body.length));
    if (!this.hasHeader("host")) this.setHeader("Host", this._hostHeader());
    // Convenience for org-scoped API keys: inject the workspace header on all
    // Anthropic API requests (covers both fetch- and axios-based clients).
    try {
      const ws = (typeof process !== "undefined") && process.env && process.env.ANTHROPIC_WORKSPACE_ID;
      if (ws && /(^|\.)anthropic\.com$/.test(this.host || "") && !this.hasHeader("anthropic-workspace-id"))
        this.setHeader("anthropic-workspace-id", ws);
    } catch {}

    const onConnect = () => {
      if (this.destroyed) return;
      this.headersSent = true;
      let head = `${this.method} ${this.path} HTTP/1.1\r\n`;
      for (const lc in this._headers) {
        const name = this._headerNames[lc];
        const v = this._headers[lc];
        if (Array.isArray(v)) for (const vv of v) head += `${name}: ${vv}\r\n`;
        else head += `${name}: ${v}\r\n`;
      }
      head += "\r\n";
      this.socket.write(Buffer.from(head, "latin1"));
      if (body.length) this.socket.write(body);
      this.emit("finish");
      this._readResponse();
    };

    const connOpts = { host: this.host, port: this.port, ...this._opts };
    try {
      this.socket = this._createConnection
        ? this._createConnection(connOpts, onConnect)
        : net.connect(connOpts, onConnect);
    } catch (e) { process.nextTick(() => this.emit("error", e)); return; }
    this.connection = this.socket;
    this.emit("socket", this.socket);
    this.socket.on("error", (e) => { if (!this.destroyed) this.emit("error", e); });
    if (this._timeoutMs) this.socket.setTimeout(this._timeoutMs, () => this.emit("timeout"));
  }

  _readResponse() {
    let buf = Buffer.alloc(0);
    let parsing = "head";
    let res = null;
    let bodyParser = null;
    const self = this;

    const finishBody = () => { if (bodyParser) bodyParser.end(); else if (res) { res.complete = true; res.push(null); } };

    this.socket.on("data", (d) => {
      if (parsing === "head") {
        buf = Buffer.concat([buf, d]);
        const idx = indexOfDblCRLF(buf);
        if (idx === -1) return;
        const headText = buf.slice(0, idx).toString("latin1");
        const rest = buf.slice(idx + 4);
        const { first, headers, rawHeaders } = parseHeaderBlock(headText);
        const m = /^HTTP\/(\d)\.(\d)\s+(\d+)\s*(.*)$/.exec(first) || [];
        res = new IncomingMessage(this.socket);
        res.httpVersionMajor = +m[1] || 1; res.httpVersionMinor = +m[2] || 1;
        res.httpVersion = `${res.httpVersionMajor}.${res.httpVersionMinor}`;
        res.statusCode = +m[3] || 0; res.statusMessage = m[4] || "";
        res.headers = headers; res.rawHeaders = rawHeaders;
        parsing = "body";
        // No connection pooling: close the socket once the body is complete.
        bodyParser = makeBodyParser(res, () => { try { this.socket.destroy(); } catch {} });
        this.emit("response", res);
        if (rest.length) bodyParser.push(rest);
        if (bodyParser.immediateDone) {} // zero-length body already ended
      } else if (parsing === "body") {
        bodyParser.push(d);
      }
    });
    this.socket.on("end", finishBody);
    this.socket.on("close", () => { if (res && !res.complete) { res.aborted = true; finishBody(); } });
  }

  abort() { this.aborted = true; this.destroy(); this.emit("abort"); }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (this.socket) try { this.socket.destroy(err); } catch {}
    if (err) process.nextTick(() => this.emit("error", err));
    return this;
  }
  setTimeout(ms, cb) { this._timeoutMs = ms; if (this.socket) this.socket.setTimeout(ms, cb); else if (cb) this.once("timeout", cb); return this; }
}

/* ---------------- ServerResponse ---------------- */

export class ServerResponse extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = this.connection = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this._headers = {};
    this.headersSent = false;
    this.finished = false;
    this.sendDate = true;
  }
  setHeader(name, val) { this._headers[name.toLowerCase()] = [name, val]; return this; }
  getHeader(name) { const e = this._headers[name.toLowerCase()]; return e && e[1]; }
  hasHeader(name) { return this._headers[name.toLowerCase()] !== undefined; }
  removeHeader(name) { delete this._headers[name.toLowerCase()]; }
  writeHead(code, msg, headers) {
    this.statusCode = code;
    if (typeof msg === "string") this.statusMessage = msg; else headers = msg;
    if (headers) for (const k in headers) this.setHeader(k, headers[k]);
    return this;
  }
  _flushHead() {
    if (this.headersSent) return;
    this.headersSent = true;
    this._chunked = String(this.getHeader("transfer-encoding") || "").toLowerCase().indexOf("chunked") !== -1;
    const msg = this.statusMessage || STATUS_CODES[this.statusCode] || "";
    let h = `HTTP/1.1 ${this.statusCode} ${msg}\r\n`;
    if (this.sendDate && !this.hasHeader("date")) h += `Date: ${new Date().toUTCString()}\r\n`;
    if (!this.hasHeader("content-length") && !this.hasHeader("transfer-encoding")) this.setHeader("Connection", "close");
    for (const lc in this._headers) {
      const [name, v] = this._headers[lc];
      if (Array.isArray(v)) for (const vv of v) h += `${name}: ${vv}\r\n`;
      else h += `${name}: ${v}\r\n`;
    }
    h += "\r\n";
    this.socket.write(Buffer.from(h, "latin1"));
  }
  _writeBody(chunk) {
    if (!chunk || !chunk.length) return;
    if (this._chunked) {
      this.socket.write(Buffer.from(chunk.length.toString(16) + "\r\n", "latin1"));
      this.socket.write(chunk);
      this.socket.write(Buffer.from("\r\n", "latin1"));
    } else this.socket.write(chunk);
  }
  write(chunk, enc, cb) {
    if (typeof enc === "function") { cb = enc; enc = undefined; }
    this._flushHead();
    if (typeof chunk === "string") chunk = Buffer.from(chunk, enc || "utf8");
    this._writeBody(chunk);
    if (cb) cb();
    return true;
  }
  end(chunk, enc, cb) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
    else if (typeof enc === "function") { cb = enc; enc = undefined; }
    if (chunk != null && typeof chunk === "string") chunk = Buffer.from(chunk, enc || "utf8");
    if (!this.headersSent && !this.hasHeader("content-length") && !this.hasHeader("transfer-encoding"))
      this.setHeader("Content-Length", String(chunk ? chunk.length : 0));
    this._flushHead();
    this._writeBody(chunk);
    if (this._chunked) this.socket.write(Buffer.from("0\r\n\r\n", "latin1"));
    this.finished = true;
    this.emit("finish");
    const sock = this.socket;
    const keepAlive = !this._chunked && String(this.getHeader("connection") || "").toLowerCase() === "keep-alive";
    if (!keepAlive) process.nextTick(() => { try { sock.end(); } catch {} });
    if (cb) cb();
    return this;
  }
}

/* ---------------- Server ---------------- */

export class Server extends EventEmitter {
  constructor(opts, handler) {
    super();
    if (typeof opts === "function") { handler = opts; opts = {}; }
    this._opts = opts || {};
    if (handler) this.on("request", handler);
    this._net = net.createServer((sock) => this._onConn(sock));
    this._net.on("error", (e) => this.emit("error", e));
    this._net.on("close", () => this.emit("close"));
  }

  _onConn(sock) {
    this.emit("connection", sock);
    let buf = Buffer.alloc(0);
    let parsing = "head";
    let req = null, bodyParser = null;
    sock.on("data", (d) => {
      if (parsing === "head") {
        buf = Buffer.concat([buf, d]);
        const idx = indexOfDblCRLF(buf);
        if (idx === -1) return;
        const headText = buf.slice(0, idx).toString("latin1");
        const rest = buf.slice(idx + 4);
        buf = Buffer.alloc(0);
        const { first, headers, rawHeaders } = parseHeaderBlock(headText);
        const m = /^([A-Z-]+)\s+(\S+)\s+HTTP\/(\d)\.(\d)/.exec(first) || [];
        req = new IncomingMessage(sock);
        req.method = m[1] || "GET"; req.url = m[2] || "/";
        req.httpVersionMajor = +m[3] || 1; req.httpVersionMinor = +m[4] || 1;
        req.httpVersion = `${req.httpVersionMajor}.${req.httpVersionMinor}`;
        req.headers = headers; req.rawHeaders = rawHeaders;
        parsing = "body";
        const hasBody = headers["content-length"] !== undefined ||
          String(headers["transfer-encoding"] || "").indexOf("chunked") !== -1;
        const res = new ServerResponse(sock);
        if (hasBody) {
          bodyParser = makeBodyParser(req, null);
          this.emit("request", req, res);
          if (rest.length) bodyParser.push(rest);
        } else {
          // No body: emit 'request' first so the handler can attach its
          // 'end'/'data' listeners before we signal EOF on the next tick.
          this.emit("request", req, res);
          req.complete = true;
          process.nextTick(() => req.push(null));
        }
      } else if (parsing === "body" && bodyParser) {
        bodyParser.push(d);
      }
    });
    sock.on("end", () => { if (bodyParser) bodyParser.end(); });
    sock.on("error", () => {});
  }

  listen(...args) {
    this._net.once("listening", () => this.emit("listening"));
    this._net.listen(...args);
    return this;
  }
  address() { return this._net.address(); }
  close(cb) { this._net.close(cb); return this; }
  ref() { this._net.ref(); return this; }
  unref() { this._net.unref(); return this; }
  setTimeout() { return this; }
}

/* ---------------- Agent (minimal, no pooling) ---------------- */

export class Agent {
  constructor(opts) {
    this.options = opts || {};
    this.maxSockets = this.options.maxSockets || Infinity;
    this.maxFreeSockets = this.options.maxFreeSockets || 256;
    this.keepAlive = !!this.options.keepAlive;
    this.sockets = {}; this.freeSockets = {}; this.requests = {};
  }
  destroy() {}
  getName(o) { return `${o.host || "localhost"}:${o.port || ""}`; }
}
export const globalAgent = new Agent();

/* ---------------- factories ---------------- */

function toOptions(input, extra) {
  let o;
  if (typeof input === "string") o = urlToOptions(new URL(input));
  else if (input instanceof URL) o = urlToOptions(input);
  else o = { ...input };
  if (extra && typeof extra === "object") o = { ...o, ...extra };
  return o;
}
function urlToOptions(u) {
  const o = {
    protocol: u.protocol,
    hostname: u.hostname.replace(/^\[|\]$/g, ""),
    host: u.hostname,
    port: u.port || (u.protocol === "https:" ? 443 : 80),
    path: (u.pathname || "/") + (u.search || ""),
  };
  if (u.username || u.password) o.auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
  if (u.protocol === "https:") o._https = true;
  return o;
}

export function request(input, options, cb) {
  if (typeof options === "function") { cb = options; options = undefined; }
  return new ClientRequest(toOptions(input, options), cb);
}
export function get(input, options, cb) {
  const req = request(input, options, cb);
  req.end();
  return req;
}
export function createServer(opts, handler) { return new Server(opts, handler); }

export default {
  METHODS, STATUS_CODES, IncomingMessage, ClientRequest, ServerResponse, Server,
  Agent, globalAgent, request, get, createServer,
};
