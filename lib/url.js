// node:url — WHATWG URL plus the legacy/helper functions.
import whatwg from "./_vendor/whatwg_url.js";
import legacy from "./_vendor/legacy_url.js";

const URL = whatwg.URL;
const URLSearchParams = whatwg.URLSearchParams;
export { URL, URLSearchParams };

export function fileURLToPath(url) {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "file:") {
    const e = new TypeError("The URL must be of scheme file");
    e.code = "ERR_INVALID_URL_SCHEME";
    throw e;
  }
  let pathname = u.pathname;
  // percent-decode
  pathname = pathname.replace(/%2[Ff]/g, "%2F").replace(/%([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  return pathname || "/";
}

export function pathToFileURL(path) {
  let resolved = path;
  if (typeof process !== "undefined" && !path.startsWith("/")) {
    resolved = (process.cwd ? process.cwd() : "") + "/" + path;
  }
  const u = new URL("file://");
  u.pathname = encodeURI(resolved).replace(/[?#]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return u;
}

export function urlToHttpOptions(url) {
  const o = {
    protocol: url.protocol,
    hostname: typeof url.hostname === "string" && url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ""}${url.search || ""}`,
    href: url.href,
  };
  if (url.port !== "") o.port = Number(url.port);
  if (url.username || url.password) o.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return o;
}

export const domainToASCII = whatwg.domainToASCII || ((d) => d);
export const domainToUnicode = whatwg.domainToUnicode || ((d) => d);

// Legacy url API (parse/format/resolve + Url class).
export const parse = legacy.parse;
export const format = legacy.format || ((u) => (typeof u === "string" ? u : (u && u.href) || ""));
export const resolve = legacy.resolve;
export const Url = legacy.Url;

const url = {
  URL, URLSearchParams, fileURLToPath, pathToFileURL, urlToHttpOptions,
  domainToASCII, domainToUnicode, parse, format, resolve, Url,
};
export { url };
export default url;
