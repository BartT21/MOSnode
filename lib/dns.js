// node:dns — async wrappers over the native getaddrinfo-backed resolver.
import * as N from "native";

function famNum(options) {
  if (typeof options === "number") return options;
  return (options && options.family) || 0;
}

export function lookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  const fam = famNum(options);
  const all = !!(options && options.all);
  process.nextTick(() => {
    let r;
    try { r = N.dnsLookup(hostname, fam === 6 ? 6 : fam === 4 ? 4 : 0, all); }
    catch (e) { e.hostname = hostname; return cb(e); }
    if (all) return cb(null, (r || []).map((x) => ({ address: x.address, family: x.family })));
    if (!r) { const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`); e.code = "ENOTFOUND"; e.hostname = hostname; return cb(e); }
    cb(null, r.address, r.family);
  });
}

function resolveFamily(fam) {
  return (hostname, cb) => {
    process.nextTick(() => {
      let r;
      try { r = N.dnsLookup(hostname, fam, true); }
      catch (e) { return cb(e); }
      cb(null, (r || []).map((x) => x.address));
    });
  };
}
export const resolve4 = resolveFamily(4);
export const resolve6 = resolveFamily(6);
export function resolve(hostname, rrtype, cb) {
  if (typeof rrtype === "function") { cb = rrtype; rrtype = "A"; }
  (rrtype === "AAAA" ? resolve6 : resolve4)(hostname, cb);
}
export function reverse(ip, cb) { process.nextTick(() => cb(null, [])); }

export class Resolver {
  constructor() {}
  resolve(...a) { return resolve(...a); }
  resolve4(...a) { return resolve4(...a); }
  resolve6(...a) { return resolve6(...a); }
  reverse(...a) { return reverse(...a); }
  setServers() {}
  getServers() { return []; }
  cancel() {}
}

export const ADDRCONFIG = 1024;
export const V4MAPPED = 8;
export const ALL = 16;

import promises from "./dns/promises.js";
export { promises };

export default {
  lookup, resolve, resolve4, resolve6, reverse, Resolver,
  ADDRCONFIG, V4MAPPED, ALL, promises,
};
