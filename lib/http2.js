// node:http2 — minimal surface. mosnode speaks HTTP/1.1 only (TLS offers just
// "http/1.1" via ALPN), so h2 is never negotiated and connect() is not driven
// in practice. constants are provided because code destructures them at load.
import { EventEmitter } from "./events.js";

export const constants = {
  // pseudo-headers and common header names
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_PROTOCOL: ":protocol",
  HTTP2_HEADER_CONTENT_TYPE: "content-type",
  HTTP2_HEADER_CONTENT_LENGTH: "content-length",
  HTTP2_HEADER_USER_AGENT: "user-agent",
  HTTP2_HEADER_ACCEPT: "accept",
  HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding",
  HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language",
  HTTP2_HEADER_TE: "te",
  HTTP2_HEADER_EXPECT: "expect",
  HTTP2_HEADER_COOKIE: "cookie",
  HTTP2_HEADER_SET_COOKIE: "set-cookie",
  HTTP2_HEADER_DATE: "date",
  HTTP2_HEADER_LOCATION: "location",
  HTTP2_HEADER_HOST: "host",
  HTTP2_HEADER_CONNECTION: "connection",
  HTTP2_HEADER_AUTHORIZATION: "authorization",
  // methods
  HTTP2_METHOD_GET: "GET",
  HTTP2_METHOD_POST: "POST",
  HTTP2_METHOD_PUT: "PUT",
  HTTP2_METHOD_DELETE: "DELETE",
  HTTP2_METHOD_HEAD: "HEAD",
  HTTP2_METHOD_PATCH: "PATCH",
  HTTP2_METHOD_OPTIONS: "OPTIONS",
  HTTP2_METHOD_CONNECT: "CONNECT",
  // flags
  NGHTTP2_FLAG_NONE: 0x0,
  NGHTTP2_FLAG_END_STREAM: 0x1,
  NGHTTP2_FLAG_END_HEADERS: 0x4,
  NGHTTP2_FLAG_ACK: 0x1,
  NGHTTP2_FLAG_PADDED: 0x8,
  NGHTTP2_FLAG_PRIORITY: 0x20,
  // error codes
  NGHTTP2_NO_ERROR: 0x0,
  NGHTTP2_PROTOCOL_ERROR: 0x1,
  NGHTTP2_INTERNAL_ERROR: 0x2,
  NGHTTP2_FLOW_CONTROL_ERROR: 0x3,
  NGHTTP2_SETTINGS_TIMEOUT: 0x4,
  NGHTTP2_STREAM_CLOSED: 0x5,
  NGHTTP2_FRAME_SIZE_ERROR: 0x6,
  NGHTTP2_REFUSED_STREAM: 0x7,
  NGHTTP2_CANCEL: 0x8,
  NGHTTP2_COMPRESSION_ERROR: 0x9,
  NGHTTP2_CONNECT_ERROR: 0xa,
  NGHTTP2_ENHANCE_YOUR_CALM: 0xb,
  NGHTTP2_INADEQUATE_SECURITY: 0xc,
  NGHTTP2_HTTP_1_1_REQUIRED: 0xd,
  // session/stream states
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  // common status codes used by callers
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NO_CONTENT: 204,
  HTTP_STATUS_NOT_MODIFIED: 304,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
  HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
};

export function getDefaultSettings() {
  return {
    headerTableSize: 4096,
    enablePush: true,
    initialWindowSize: 65535,
    maxFrameSize: 16384,
    maxConcurrentStreams: 4294967295,
    maxHeaderListSize: 65535,
    enableConnectProtocol: false,
  };
}

// mosnode negotiates HTTP/1.1 only; if something forces an h2 session we fail
// loudly rather than silently misbehaving. In practice this is never reached.
function unsupported() {
  const e = new Error("HTTP/2 is not supported by mosnode (HTTP/1.1 only)");
  e.code = "ERR_HTTP2_UNSUPPORTED";
  return e;
}

class Http2Session extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.closed = false; }
  request() { throw unsupported(); }
  close(cb) { this.closed = true; if (cb) cb(); this.emit("close"); }
  destroy(err) { this.destroyed = true; if (err) this.emit("error", err); this.emit("close"); }
  ref() { return this; }
  unref() { return this; }
  setTimeout() { return this; }
  ping() { return false; }
}

export function connect(authority, options, listener) {
  if (typeof options === "function") { listener = options; options = {}; }
  const session = new Http2Session();
  if (typeof listener === "function") session.once("connect", listener);
  // Emit error asynchronously so callers relying on h2 fall back / surface it.
  process.nextTick(() => session.emit("error", unsupported()));
  return session;
}

export function createServer() { throw unsupported(); }
export function createSecureServer() { throw unsupported(); }

export const sensitiveHeaders = Symbol("nodejs.http2.sensitiveHeaders");

export default {
  constants, getDefaultSettings, connect, createServer, createSecureServer,
  sensitiveHeaders, Http2Session,
};
