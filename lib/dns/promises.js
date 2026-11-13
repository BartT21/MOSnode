// node:dns/promises
import * as N from "native";

export function lookup(hostname, options = {}) {
  const fam = typeof options === "number" ? options : options.family || 0;
  const all = !!options.all;
  return new Promise((resolve, reject) => {
    process.nextTick(() => {
      let r;
      try { r = N.dnsLookup(hostname, fam === 6 ? 6 : fam === 4 ? 4 : 0, all); }
      catch (e) { e.hostname = hostname; return reject(e); }
      if (all) return resolve((r || []).map((x) => ({ address: x.address, family: x.family })));
      if (!r) { const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`); e.code = "ENOTFOUND"; return reject(e); }
      resolve({ address: r.address, family: r.family });
    });
  });
}
function rf(fam) {
  return (hostname) => new Promise((res, rej) => process.nextTick(() => {
    let r; try { r = N.dnsLookup(hostname, fam, true); } catch (e) { return rej(e); }
    res((r || []).map((x) => x.address));
  }));
}
export const resolve4 = rf(4);
export const resolve6 = rf(6);
export function resolve(hostname, rrtype = "A") { return (rrtype === "AAAA" ? resolve6 : resolve4)(hostname); }
export class Resolver {
  resolve4(...a) { return resolve4(...a); }
  resolve6(...a) { return resolve6(...a); }
  setServers() {} getServers() { return []; }
}
export default { lookup, resolve, resolve4, resolve6, Resolver };
