// node:https — HTTPS by wrapping http's client over a tls.TLSSocket.
import http from "http";
import tls from "tls";
import { URL } from "./url.js";

export const METHODS = http.METHODS;
export const STATUS_CODES = http.STATUS_CODES;
export const IncomingMessage = http.IncomingMessage;
export const ServerResponse = http.ServerResponse;
export const ClientRequest = http.ClientRequest;

export class Agent extends http.Agent {
  constructor(opts) { super(opts); this.defaultPort = 443; this.protocol = "https:"; }
}
export const globalAgent = new Agent({});

// http's ClientRequest calls createConnection(opts, onConnect); for HTTPS we
// return a TLSSocket and fire onConnect on 'secureConnect' (the real "ready").
function tlsCreateConnection(opts, onConnect) {
  const tsock = tls.connect({
    host: opts.host,
    port: opts.port,
    servername: opts.servername || opts.host,
    rejectUnauthorized: opts.rejectUnauthorized,
    ALPNProtocols: opts.ALPNProtocols || ["http/1.1"],
  });
  if (typeof onConnect === "function") tsock.once("secureConnect", onConnect);
  tsock.on("error", () => {}); // surfaced to the ClientRequest via its own handler
  return tsock;
}

function buildOptions(input, options) {
  let o;
  if (typeof input === "string" || input instanceof URL) {
    o = options && typeof options === "object" ? { ...options } : {};
    const u = input instanceof URL ? input : new URL(input);
    o.hostname = o.hostname || u.hostname.replace(/^\[|\]$/g, "");
    o.host = o.host || o.hostname;
    o.port = o.port || (u.port || 443);
    o.path = o.path || (u.pathname || "/") + (u.search || "");
  } else {
    o = { ...input };
  }
  o._https = true;
  o.createConnection = tlsCreateConnection;
  if (o.port == null) o.port = 443;
  return o;
}

export function request(input, options, cb) {
  if (typeof options === "function") { cb = options; options = undefined; }
  return http.request(buildOptions(input, options), cb);
}
export function get(input, options, cb) {
  const req = request(input, options, cb);
  req.end();
  return req;
}

export default {
  METHODS, STATUS_CODES, IncomingMessage, ServerResponse, ClientRequest,
  Agent, globalAgent, request, get,
};
