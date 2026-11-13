// node:process — the global process object, plus named exports for code that
// does `import { cwd, env, ... } from "process"`.
const p = globalThis.process;

export default p;

export const env = p.env;
export const argv = p.argv;
export const argv0 = p.argv0;
export const execPath = p.execPath;
export const execArgv = p.execArgv;
export const platform = p.platform;
export const arch = p.arch;
export const version = p.version;
export const versions = p.versions;
export const pid = p.pid;
export const ppid = p.ppid;
export const release = p.release;
export const config = p.config;
export const title = p.title;
export const stdout = p.stdout;
export const stderr = p.stderr;
export const stdin = p.stdin;

// Methods must stay bound to the process object; guard any that may be absent.
const bind = (name, fallback) => (typeof p[name] === "function" ? p[name].bind(p) : (fallback || (() => undefined)));

export const cwd = bind("cwd", () => "/");
export const chdir = bind("chdir");
export const nextTick = bind("nextTick", (fn, ...a) => queueMicrotask(() => fn(...a)));
export const exit = bind("exit");
export const hrtime = bind("hrtime");
export const memoryUsage = bind("memoryUsage", () => ({}));
export const uptime = bind("uptime", () => 0);
export const on = bind("on", () => p);
export const once = bind("once", () => p);
export const off = (typeof p.off === "function" ? p.off.bind(p) : (typeof p.removeListener === "function" ? p.removeListener.bind(p) : () => p));
export const emit = bind("emit", () => false);
export const removeListener = bind("removeListener", () => p);
export const kill = bind("kill");
export const umask = bind("umask", () => 0);
