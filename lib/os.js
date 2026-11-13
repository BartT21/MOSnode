// node:os
import * as N from "native";

export const EOL = "\n";
export const devNull = "/dev/null";
export const type = () => N.procInfo?.osType ?? "Linux";
export const release = () => N.procInfo?.osRelease ?? "";
export const version = () => N.procInfo?.osVersion ?? "";
export const hostname = () => N.hostname;
// Amiga "VOL:a/b" -> ixemul "/VOL/a/b"; anything else is returned unchanged.
export function _amigaToUnix(p) {
  if (typeof p !== "string" || !p) return p;
  const c = p.indexOf(":");
  if (c <= 0 || p.indexOf("/") !== -1 && p.indexOf("/") < c) return p;
  const rest = p.slice(c + 1).replace(/\/+$/, "");
  return "/" + p.slice(0, c) + (rest ? "/" + rest : "");
}
// HOME unset (fresh Shell, after a reboot) makes the native homedir "/", the
// ixemul root, which is not writable -- Claude Code would then save its login
// there (fails) or in a different folder than the previous run. Fall back to
// MOSNODE_HOME, else the folder that holds the lib/ dir (MOSNODE_LIB's parent),
// so ~/.claude always resolves to the same place.
export const homedir = () => {
  const h = N.homedir();
  if (h && h !== "/") return h;
  const mh = N.getenv("MOSNODE_HOME");
  if (mh) return _amigaToUnix(mh);
  const lib = _amigaToUnix(N.getenv("MOSNODE_LIB") || "");
  if (lib && lib.lastIndexOf("/") > 0) return lib.replace(/\/+$/, "").replace(/\/[^/]*$/, "");
  return h || "/";
};
export const tmpdir = () => N.tmpdir();
export const userInfo = (opts) => N.userInfo();
export const totalmem = () => N.totalmem();
export const freemem = () => N.freemem();
export const cpus = () => {
  const model = N.cpuModel();
  const n = N.cpuCount();
  return Array.from({ length: n }, (_, i) => ({
    model, speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
};
export const arch = () => N.arch === "x64" ? "x64" : N.arch;
export const platform = () => N.platform;
export const endianness = () => N.endianness;
export const loadavg = () => N.loadavg();
export const uptime = () => N.osUptime ? N.osUptime() : 0;
export const networkInterfaces = () => ({});
export const getNetworkInterfaces = () => ({});
const _nc = (N.constants && typeof N.constants === "object") ? N.constants : {};
export const constants = {
  UV_UDP_REUSEADDR: 1,
  signals: _nc.signals || {},
  errno: _nc.errno || {},
  priority: {
    PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20,
  },
  dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 },
};
const osModule = { EOL, devNull, type, release, version, hostname, homedir, tmpdir,
  userInfo, totalmem, freemem, cpus, arch, platform, endianness, loadavg, uptime,
  networkInterfaces, getNetworkInterfaces, constants };
export default osModule;
