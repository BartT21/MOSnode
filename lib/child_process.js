// node:child_process — spawn/exec over the native module
import * as N from "native";
import { EventEmitter } from "./events.js";
import { Buffer } from "./buffer.js";

import { homedir } from "./os.js";
import { writeFileSync as _wf, readFileSync as _rf, existsSync as _ex, mkdirSync as _mkd, unlinkSync as _unlink, fdToPath as _fdPath, readdirSync as _readdirSync, statSync as _statSync, readFileSync as _readFileSync } from "./fs.js";
import { runRipgrep as _runRipgrep } from "./_ripgrep.js";

// Append a Buffer/string to a file by PATH (the fd is already closed by the
// time our async shell poll returns). Opens O_APPEND|O_CREAT so the file cli.js
// created for the child's stdout is filled even if empty, and binary-safe.
function _appendToFile(path, data) {
  if (!path) return;
  let fd = null;
  try {
    fd = N.fsOpen(path, "a", 0o666);
    if (data && data.length) {
      if (typeof data === "string") N.fsWrite(fd, data);
      else N.fsWrite(fd, data, 0, data.length, -1);
    }
  } finally { if (fd != null) { try { N.fsClose(fd); } catch {} } }
}

// ---- MorphOS shell bridge (ksh via AmigaDOS System, no fork) ----------------
// fork()/exec() don't work under ixemul when pthreads are in use (mosnode links
// -lpthread), so N.spawn can't launch a POSIX shell. Instead we run cli.js's
// `sh -c "cmd"` through the gg `ksh` (a real POSIX shell) by writing the command
// to a temp script, launching `ksh script >out 2>err; echo end$? >rc` via the
// async AmigaDOS `amigaRun`, polling for the rc marker, and feeding the captured
// stdout/stderr/exit-code back as a ChildProcess. One-shot per command.
const _KSH_IX = N.getenv("MOSNODE_KSH") || "/Work/mosnode/bin/ksh";
const _BIN_IX = _KSH_IX.replace(/\/[^/]*$/, "");
const _TMP_IX = (N.getenv("MOSNODE_HOME") || "/Work/mosnode") + "/tmp";
let _shSeq = 0, _tmpReady = false;

function _cplog(s) { if (!N.getenv("MOSNODE_DEBUG")) return; try { N.fsWriteFile((N.getenv("MOSNODE_HOME") || "/Work/mosnode") + "/mosnode-debug.log", s + "\n", "a", 0o666); } catch {} }
function _shellBridgeOk() { return typeof N.amigaRun === "function"; }
function _ixToAmiga(p) {
  const m = /^\/([^/]+)(\/.*)?$/.exec(p);
  return m ? m[1] + ":" + (m[2] ? m[2].slice(1) : "") : p;
}
function _ensureTmp() {
  if (_tmpReady) return;
  try { _mkd(_TMP_IX, { recursive: true }); } catch {}
  _tmpReady = true;
}
function _shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function _envExports(env) {
  let s = "";
  if (env) {
    if (Array.isArray(env)) {
      for (const kv of env) { const i = kv.indexOf("="); if (i > 0) s += "export " + kv.slice(0, i) + "=" + _shQuote(kv.slice(i + 1)) + "\n"; }
    } else {
      for (const k of Object.keys(env)) if (env[k] != null) s += "export " + k + "=" + _shQuote(env[k]) + "\n";
    }
  }
  s += "export PATH=" + _BIN_IX + ":$PATH\n";   // always make our coreutils resolvable
  return s;
}

// Detect a backgrounded single-command launch inside cli.js's Bash wrapper
// (`... && eval '<app ...> &' < /dev/null && pwd -P >| <cwdfile>`). ksh would
// background it and then exit, which kills a GUI/Amiga app before it stays up.
// Return the ixemul command plus an AmigaDOS form so it can be launched DETACHED
// via AmigaDOS System (N.amigaRun) -- the path that actually shows GUI apps
// (Wayfarer, MUIProCalc) on the Workbench screen.
function _bgLaunch(cmd) {
  const m = /eval\s+'((?:[^'\\]|\\.)*)'/.exec(cmd);
  if (!m) return null;
  let inner = m[1].trim();
  if (!inner.endsWith("&")) return null;
  inner = inner.slice(0, -1).trim();
  if (!inner || /[|;\n]|&&/.test(inner)) return null;   // single simple command only
  // leading ixemul absolute path /VOL/rest -> AmigaDOS VOL:rest
  const amiga = inner.replace(/^\/([^/\s]+)(\/|\s|$)/, (mm, vol, sep) => vol + ":" + (sep === "/" ? "" : sep));
  return { inner, amiga };
}
function _cwdMarker(cmd) {
  const m = />\|?\s*(\S*cwd\S*)/.exec(cmd);   // `pwd -P >| /tmp/claude-XXXX-cwd`
  return m ? m[1] : null;
}

// Run `cmd` through ksh; done(code, stdoutBuf, stderrBuf, err). code null on launch/timeout error.
function _runViaShell(cmd, o, done) {
  // GUI/app launch (`... &`): launch detached via AmigaDOS instead of ksh.
  const _bg = _bgLaunch(cmd);
  if (_bg) {
    let rc = -1;
    try { rc = N.amigaRun(_bg.amiga); } catch (e) { _cplog("BGLAUNCH threw " + (e && e.message)); }
    const cwdf = _cwdMarker(cmd);
    if (cwdf && o && o.cwd) { try { _wf(cwdf, o.cwd + "\n"); } catch {} }
    _cplog("BGLAUNCH rc=" + rc + " amiga[" + _bg.amiga + "]");
    const ok = rc !== -1;
    return done(ok ? 0 : 1,
      Buffer.from(ok ? ("Launched (detached): " + _bg.inner + "\n") : ""),
      Buffer.from(ok ? "" : ("Failed to launch: " + _bg.inner + "\n")),
      null);
  }
  let files = [];
  try {
    _ensureTmp();
    const id = Date.now().toString(36) + "_" + (++_shSeq);
    const cF = _TMP_IX + "/c" + id, oF = _TMP_IX + "/o" + id, eF = _TMP_IX + "/e" + id,
          rF = _TMP_IX + "/r" + id, wF = _TMP_IX + "/w" + id;
    files = [cF, oF, eF, rF, wF];
    let script = _envExports(o.env);
    if (o.cwd) script += "cd " + _shQuote(o.cwd) + " 2>/dev/null\n";
    script += cmd + "\n";
    _wf(cF, script); _wf(oF, ""); _wf(eF, "");
    _wf(wF, _KSH_IX + " " + cF + " >" + oF + " 2>" + eF + "\necho end$? >" + rF + "\n");
    const rc = N.amigaRun(_ixToAmiga(_KSH_IX) + " " + _ixToAmiga(wF));
    if (rc === -1) {
      for (const f of files) { try { _unlink(f); } catch {} }
      return done(null, Buffer.alloc(0), Buffer.alloc(0), Object.assign(new Error("shell launch failed"), { code: "ENOENT" }));
    }
    const t0 = Date.now();
    const timeout = (o.timeout && o.timeout > 0) ? o.timeout : 0;
    const poll = () => {
      let code = null;
      try {
        if (_ex(rF)) { const m = /end(-?\d+)/.exec(_rf(rF).toString()); if (m) code = parseInt(m[1], 10); }
      } catch {}
      if (code !== null) {
        let so = Buffer.alloc(0), se = Buffer.alloc(0);
        try { so = Buffer.from(_rf(oF)); } catch {}
        try { se = Buffer.from(_rf(eF)); } catch {}
        _cplog("SHELL rc=" + code + " outlen=" + so.length + " errlen=" + se.length + " err[" + se.toString().slice(0, 160) + "] cmd[" + String(cmd).slice(0, 160) + "]");
        for (const f of files) { try { _unlink(f); } catch {} }
        return done(code, so, se, null);
      }
      if (timeout && Date.now() - t0 > timeout) {
        for (const f of files) { try { _unlink(f); } catch {} }
        return done(null, Buffer.alloc(0), Buffer.alloc(0), Object.assign(new Error("shell timeout"), { code: "ETIMEDOUT" }));
      }
      setTimeout(poll, 60);
    };
    setTimeout(poll, 40);
  } catch (e) {
    for (const f of files) { try { _unlink(f); } catch {} }
    done(null, Buffer.alloc(0), Buffer.alloc(0), e);
  }
}

// Synchronous variant: blocks (busy-polls) until the command finishes. ksh runs
// as a separate preemptive MorphOS task, so the rc file appears while we spin.
// Returns { status, stdout(Buffer), stderr(Buffer), error }.
function _runViaShellSync(cmd, o) {
  const empty = Buffer.alloc(0);
  let files = [];
  try {
    _ensureTmp();
    const id = Date.now().toString(36) + "_" + (++_shSeq);
    const cF = _TMP_IX + "/c" + id, oF = _TMP_IX + "/o" + id, eF = _TMP_IX + "/e" + id,
          rF = _TMP_IX + "/r" + id, wF = _TMP_IX + "/w" + id;
    files = [cF, oF, eF, rF, wF];
    let script = _envExports(o.env);
    if (o.cwd) script += "cd " + _shQuote(o.cwd) + " 2>/dev/null\n";
    script += cmd + "\n";
    _wf(cF, script); _wf(oF, ""); _wf(eF, "");
    _wf(wF, _KSH_IX + " " + cF + " >" + oF + " 2>" + eF + "\necho end$? >" + rF + "\n");
    if (o.input) { try { _wf(cF, script.replace(/\n$/, "") + "\n"); } catch {} }   // input via stdin not supported; ignore
    const rc = N.amigaRun(_ixToAmiga(_KSH_IX) + " " + _ixToAmiga(wF));
    if (rc === -1) { for (const f of files) { try { _unlink(f); } catch {} } return { status: null, stdout: empty, stderr: empty, error: Object.assign(new Error("shell launch failed"), { code: "ENOENT" }) }; }
    const timeout = (o.timeout && o.timeout > 0) ? o.timeout : 120000;
    const t0 = Date.now();
    let code = null;
    for (;;) {
      try { if (_ex(rF)) { const m = /end(-?\d+)/.exec(_rf(rF).toString()); if (m) { code = parseInt(m[1], 10); break; } } } catch {}
      if (Date.now() - t0 > timeout) break;
    }
    let so = empty, se = empty;
    try { so = Buffer.from(_rf(oF)); } catch {}
    try { se = Buffer.from(_rf(eF)); } catch {}
    for (const f of files) { try { _unlink(f); } catch {} }
    if (code === null) return { status: null, stdout: so, stderr: se, error: Object.assign(new Error("shell timeout"), { code: "ETIMEDOUT" }) };
    return { status: code, stdout: so, stderr: se, error: null };
  } catch (e) {
    for (const f of files) { try { _unlink(f); } catch {} }
    return { status: null, stdout: empty, stderr: empty, error: e };
  }
}

// If (file,args) is a `<shell> [-l] -c "cmd"` invocation, return cmd; else null.
// cli.js calls `/bin/bash -c -l "<script>"`, so the command is the first
// non-flag arg after "-c" (not necessarily args[1]).
function _asShellCmd(file, args) {
  const base = String(file || "").split(/[\/:]/).pop();
  if (!(base === "sh" || base === "ksh" || base === "bash" || base === "dash" || base === "zsh")) return null;
  const a = Array.isArray(args) ? args : [args];
  const ci = a.indexOf("-c");
  if (ci === -1) return null;
  for (let i = ci + 1; i < a.length; i++) {
    if (typeof a[i] === "string" && a[i][0] !== "-") return a[i];
  }
  return null;
}

// ---- Browser open on MorphOS ----------------------------------------------
// CLIs open a URL by running `$BROWSER <url>` or `xdg-open <url>` (Claude Code's
// /login does exactly that). MorphOS has no fork(), so a real spawn can't work;
// instead hand the URL to an Amiga program (Wayfarer by default, override with
// MOSNODE_BROWSER) via the native SystemTags helper, and report success to the
// caller like a finished xdg-open. If that's unavailable, leave the URL in
// HOME/login.html + login_url.txt so it can be opened in the browser by hand.
const _BROWSER_CMDS = new Set(["xdg-open", "open", "sensible-browser", "www-browser", "x-www-browser"]);
const _DEFAULT_BROWSER = "SYS:Applications/Wayfarer/Wayfarer";

export function _browserOpenUrl(file, args) {
  if (typeof file !== "string") return null;
  const a = Array.isArray(args) ? args : [args];
  if (a.length !== 1 || typeof a[0] !== "string") return null;
  const url = a[0].replace(/^"(.*)"$/, "$1");
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
  const base = file.replace(/^.*[\/:]/, "");
  const br = N.getenv("BROWSER");
  return (_BROWSER_CMDS.has(base) || (br && file === br)) ? url : null;
}

// Inside "..." the AmigaDOS shell still treats * as an escape, " as the end,
// ` as command substitution and $ as a variable. Percent-encode those (same
// meaning in a URL); refuse control characters outright.
export function _amigaQuoteUrl(url) {
  if (/[\x00-\x1f\x7f]/.test(url)) return null;
  return url.replace(/["*`$;]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

function _writeLoginFallback(url) {
  try {
    const h = homedir();
    const dir = h && h !== "/" ? h.replace(/\/+$/, "") + "/" : "";
    const att = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    N.fsWriteFile(dir + "login.html",
      '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + att + '">' +
      '<p><a href="' + att + '">Continue to sign in</a></p>\n', "w", 0o600);
    N.fsWriteFile(dir + "login_url.txt", url + "\n", "w", 0o600);
  } catch {}
}

export function _openUrlAmiga(url) {
  const q = _amigaQuoteUrl(url);
  if (q !== null && typeof N.amigaRun === "function") {
    const br = N.getenv("MOSNODE_BROWSER") || _DEFAULT_BROWSER;
    try { if (N.amigaRun('"' + br + '" "' + q + '"') !== -1) return true; } catch {}
  }
  _writeLoginFallback(url);
  return false;
}

// A ChildProcess that already "ran": empty ended stdio, then exit/close(code).
function _finishedCp(file, args, code) {
  const cp = new ChildProcess();
  cp.spawnargs = [file, ...args];
  cp.stdin = new Writable({ write(c, en, cb) { cb(); } });
  cp.stdout = new Readable({ read() { this.push(null); } });
  cp.stderr = new Readable({ read() { this.push(null); } });
  cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
  process.nextTick(() => {
    cp.emit("spawn");
    cp.exitCode = code;
    cp.emit("exit", code, null);
    cp.emit("close", code, null);
  });
  return cp;
}

function defaultOpts(opts = {}, defaults = {}) {
  return {
    cwd: opts.cwd ?? defaults.cwd,
    env: opts.env,
    stdio: opts.stdio ?? "pipe",
    shell: opts.shell ?? false,
  };
}

// Normalize a stdio spec into a 3-element array. In Node, null/undefined
// entries (and a bare array shorter than 3) default to "pipe" — NOT inherit.
// Our native layer treats undefined as inherit, so map null/undefined to "pipe"
// here to match Node and avoid a child's stdout/stderr leaking to our fds.
function normStdio(stdio) {
  let arr;
  if (typeof stdio === "string") arr = [stdio, stdio, stdio];
  else if (Array.isArray(stdio)) arr = stdio.slice(0, 3);
  else arr = [];
  const out = [];
  for (let i = 0; i < 3; i++) {
    const v = arr[i];
    out[i] = (v === undefined || v === null) ? "pipe" : v;
  }
  return out;
}

function withShell(file, args, opts) {
  if (!opts.shell) return [file, args, opts];
  const sh = typeof opts.shell === "string" ? opts.shell : "/bin/sh";
  const cmd = [file, ...args].join(" ");
  return [sh, [sh.endsWith("cmd.exe") ? "/s" : "-c", cmd], opts];
}

export class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = null; this.stdout = null; this.stderr = null;
    this.stdio = [null, null, null];
    this.pid = undefined;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.spawnargs = [];
  }
  kill(sig = "SIGTERM") {
    if (this.pid == null) return true;
    this.killed = true;
    try { return N.kill(this.pid, sig); } catch { return false; }
  }
  unref() {} ref() {}
  disconnect() {}
  send() { return false; }
  connected = false;
}

import { Readable, Writable } from "./stream.js";

function makePipeStream(h, isStdin) {
  const streams = isStdin
    ? new Writable({
        write(chunk, enc, cb) {
          N.streamWrite(h, chunk, (err) => err ? cb(err) : cb());
        },
        final(cb) { N.streamShutdown(h, () => cb()); },
      })
    : new Readable({
        read() {
          N.streamReadStart(h, (err, chunk) => {
            if (chunk === null || err) { N.close(h); this.push(null); }
            else if (this.push(chunk)) {} else N.streamReadStop(h);
          });
        },
      });
  return streams;
}

export function spawn(file, args = [], opts = {}) {
  _cplog("spawn " + JSON.stringify(file) + " " + JSON.stringify(args) + " shell=" + (opts && opts.shell) + " stdio=" + JSON.stringify(opts && opts.stdio) + " cwd=" + (opts && opts.cwd));
  const url = _browserOpenUrl(file, args);
  if (url) return _finishedCp(file, [url], _openUrlAmiga(url) ? 0 : 1);
  const cp = new ChildProcess();
  cp.spawnargs = [file, ...(Array.isArray(args) ? args : [args])];
  const o = defaultOpts(opts);
  const [f, a, oo] = withShell(file, Array.isArray(args) ? args : [args], o);
  const stdio = normStdio(oo.stdio);

  // MorphOS: a `sh -c "cmd"` spawn runs through ksh via AmigaDOS (no fork).
  const _shcmd = _shellBridgeOk() ? _asShellCmd(f, a) : null;
  if (_shcmd != null) {
    cp.pid = -1;
    cp.stdin = new Writable({ write(c, en, cb) { cb(); } });
    cp.stdout = new Readable({ read() {} });
    cp.stderr = new Readable({ read() {} });
    cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
    // cli.js's Bash tool passes the task .output file's fd as the child's
    // stdout/stderr (stdio=["pipe", fd, fd]) and reads the FILE back, not the
    // stream. We have no real child to inherit that fd, so resolve the fd to its
    // path NOW (cli.js closes it right after spawn returns) and append our
    // captured output there before signalling exit.
    const _outPath = typeof stdio[1] === "number" ? _fdPath(stdio[1]) : null;
    const _errPath = typeof stdio[2] === "number" ? _fdPath(stdio[2]) : null;
    _cplog("spawn-bridge outfd=" + stdio[1] + "->" + _outPath + " errfd=" + stdio[2] + "->" + _errPath);
    process.nextTick(() => cp.emit("spawn"));
    _runViaShell(_shcmd, oo, (code, so, se, err) => {
      // Write to the child's stdout/stderr file(s). If both map to the same file
      // (the usual ["pipe", fd, fd]), stdout then stderr, in order.
      try {
        if (_outPath) _appendToFile(_outPath, so);
        if (_errPath && _errPath === _outPath) _appendToFile(_outPath, se);
        else if (_errPath) _appendToFile(_errPath, se);
      } catch (e) { _cplog("spawn-bridge filewrite ERR " + (e && e.message)); }
      try { if (so && so.length) cp.stdout.push(so); } catch {}
      try { cp.stdout.push(null); } catch {}
      try { if (se && se.length) cp.stderr.push(se); } catch {}
      try { cp.stderr.push(null); } catch {}
      if (err) { process.nextTick(() => { cp.emit("error", err); cp.emit("close", -1, null); }); return; }
      cp.exitCode = code;
      // Defer exit/close so cli.js reads the .output file only after it is written.
      setTimeout(() => { cp.emit("exit", code, null); cp.emit("close", code, null); }, 0);
    });
    return cp;
  }

  // MorphOS: serve ripgrep (Glob --files and Grep search) from the JS shim.
  // (On PPC the vendored rg binary can't exec.)
  if (_isRipgrep(f)) {
    const r = _rgShim(a, oo);
    if (r != null) return _rgResultCp(f, a, r.stdout, null, undefined, r.code);
    return _cleanEmptyCp(cp, null, undefined);
  }

  let res;
  try {
    res = N.spawn({ file: f, args: [f, ...a], cwd: oo.cwd, env: oo.env, stdio },
      (code, signal) => {
        cp.exitCode = code;
        cp.signalCode = signal;
        process.nextTick(() => {
          cp.emit("exit", code, signal);
          cp.emit("close", code, signal);
        });
      });
  } catch (e) {
    if (_isRipgrep(f)) return _cleanEmptyCp(cp, null, undefined);
    process.nextTick(() => { cp.emit("error", e); cp.emit("close", -1, null); });
    return cp;
  }
  cp.pid = res.pid;
  if (res.stdio[0] != null) { cp.stdin = makePipeStream(res.stdio[0], true); cp.stdio[0] = cp.stdin; }
  if (res.stdio[1] != null) { cp.stdout = makePipeStream(res.stdio[1], false); cp.stdio[1] = cp.stdout; }
  if (res.stdio[2] != null) { cp.stderr = makePipeStream(res.stdio[2], false); cp.stdio[2] = cp.stderr; }
  process.nextTick(() => cp.emit("spawn"));
  return cp;
}

// Virtual bash: cli.js validates a shell by running `<path> --version`. Answer
// the /bin/bash probe with a bash version string so it selects us (we run the
// actual `-c "cmd"` through ksh below).
const _VBASH_VER = "GNU bash, version 5.2.37(1)-release (powerpc-morphos)\nCopyright (C) 2022 Free Software Foundation, Inc.\n";
function _isVBashProbe(file, args) {
  const a = Array.isArray(args) ? args : [args];
  return file === "/bin/bash" && a[0] === "--version";
}

export function spawnSync(file, args = [], opts = {}) {
  _cplog("spawnSync " + JSON.stringify(file) + " " + JSON.stringify(args) + " shell=" + (opts && opts.shell));
  if (_isVBashProbe(file, args)) {
    const useStr = opts.encoding && opts.encoding !== "buffer";
    const out = useStr ? _VBASH_VER : Buffer.from(_VBASH_VER), er = useStr ? "" : Buffer.alloc(0);
    return { pid: 0, status: 0, signal: null, stdout: out, stderr: er, output: [null, out, er], success: true };
  }
  const url = _browserOpenUrl(file, args);
  if (url) {
    const status = _openUrlAmiga(url) ? 0 : 1;
    const empty = Buffer.alloc(0);
    return { pid: 0, status, signal: null, stdout: empty, stderr: empty,
             output: [null, empty, empty], success: status === 0 };
  }
  const o = defaultOpts(opts);
  const [f, a, oo] = withShell(file, Array.isArray(args) ? args : [args], o);
  const stdio = normStdio(oo.stdio);

  // MorphOS: a synchronous `sh -c "cmd"` runs through ksh via AmigaDOS (no fork).
  const _shcmd = _shellBridgeOk() ? _asShellCmd(f, a) : null;
  if (_shcmd != null) {
    const r = _runViaShellSync(_shcmd, { cwd: oo.cwd, env: oo.env, timeout: opts.timeout, input: opts.input });
    const out = { pid: 0, status: r.status, signal: null, stdout: r.stdout, stderr: r.stderr };
    if (opts.encoding && opts.encoding !== "buffer") {
      try { out.stdout = r.stdout.toString(opts.encoding); } catch {}
      try { out.stderr = r.stderr.toString(opts.encoding); } catch {}
    }
    out.output = [opts.input ?? null, out.stdout, out.stderr];
    out.success = r.status === 0;
    if (r.error) { out.error = r.error; out.status = null; }
    return out;
  }

  // MorphOS: ripgrep can't exec; serve Glob/Grep from the JS shim.
  if (_isRipgrep(f)) {
    const r = _rgShim(a, oo);
    const useStr = opts.encoding && opts.encoding !== "buffer";
    if (r != null) {
      const buf = Buffer.from(r.stdout), status = r.code;
      const so = useStr ? buf.toString(opts.encoding) : buf, se = useStr ? "" : Buffer.alloc(0);
      return { pid: 0, status, signal: null, stdout: so, stderr: se, output: [null, so, se], success: status === 0 };
    }
    const se = useStr ? "" : Buffer.alloc(0), so = useStr ? "" : Buffer.alloc(0);
    return { pid: 0, status: 1, signal: null, stdout: so, stderr: se, output: [null, so, se], success: false };
  }

  const res = N.spawnSync({
    file: f, args: [f, ...a], cwd: oo.cwd, env: oo.env, stdio,
    input: opts.input, timeout: opts.timeout, killSignal: opts.killSignal, maxBuffer: opts.maxBuffer,
  });
  const o2 = { ...res };
  if (res.stdout) { o2.stdout = res.stdout; if (opts.encoding) o2.stdout = Buffer.from(res.stdout).toString(opts.encoding); }
  if (res.stderr) { o2.stderr = res.stderr; if (opts.encoding) o2.stderr = Buffer.from(res.stderr).toString(opts.encoding); }
  if (o2.error) {
    const e = o2.error;
    o2.error = new Error(`${e.code} ${e.syscall} ${e.path ?? ""}`);
    o2.error.code = e.code; o2.error.errno = e.errno; o2.error.syscall = e.syscall;
    o2.status = null; o2.output = [null, o2.stdout, o2.stderr];
  }
  o2.output = [opts.input ?? null, o2.stdout, o2.stderr];
  o2.success = o2.status === 0;
  return o2;
}

export function execSync(cmd, opts = {}) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`Command failed: ${cmd}\n${r.stderr ?? ""}`);
    e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr;
    throw e;
  }
  return opts.encoding ? r.stdout : r.stdout;
}

export function execFileSync(file, args = [], opts = {}) {
  _cplog("execFileSync " + JSON.stringify(file) + " " + JSON.stringify(args));
  const r = spawnSync(file, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`Command failed: ${file} ${args.join(" ")}\n${r.stderr ?? ""}`);
    e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr;
    throw e;
  }
  return opts.encoding ? r.stdout : r.stdout;
}

// Node's async exec/execFile default `encoding` to 'utf8' (stdout/stderr come
// back as strings); 'buffer' or null yields Buffers. Many callers (e.g. tools
// that shell out to ripgrep) do string ops like stdout.trim() and will throw
// on a Buffer — which, thrown inside the exit callback, silently wedges the
// awaiting Promise. So decode here, defaulting to utf8.
function _decodeExecOut(buf, encoding) {
  if (encoding === "buffer" || encoding === null) return buf;
  try { return buf.toString(encoding || "utf8"); }
  catch { return buf.toString("utf8"); }
}

// Node reports a spawn failure (ENOENT, EACCES, ...) ASYNCHRONOUSLY — via the
// child's 'error' event and the exec callback — never as a synchronous throw.
// Our N.spawn throws instead, so callers like cli.js's ripgrep runner (which do
// `let cp = execFile(...)` and then attach 'error'/data handlers, exactly as on
// Linux) would get an unhandled rejection that stalls REPL startup. Emulate
// Node: return a ChildProcess whose empty stdio ends at once and which emits
// 'error' + 'close' and invokes the callback on the next tick.
function spawnFailCp(cp, callback, e, enc) {
  cp.stdin = new Writable({ write(c, en, cb) { cb(); } });
  cp.stdout = new Readable({ read() { this.push(null); } });
  cp.stderr = new Readable({ read() { this.push(null); } });
  cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
  process.nextTick(() => {
    cp.emit("error", e);
    cp.emit("close", -1, null);
    if (callback) callback(e, _decodeExecOut(Buffer.alloc(0), enc), _decodeExecOut(Buffer.alloc(0), enc));
  });
  return cp;
}

// Claude Code bundles a prebuilt ripgrep for x86/arm; on MorphOS/PPC that binary
// can't exec (ENOEXEC/ENOENT). cli.js's command/agent + file scanners spawn it and
// await its exit; a spawn 'error' leaves those promises unsettled and wedges
// startup before the UI mounts. Treat an un-runnable ripgrep as a process that
// ran and found nothing: empty stdio, exit code 1 (rg's "no matches"), no 'error'.
function _isRipgrep(file) {
  const f = String(file || "");
  const base = f.split(/[\/]/).pop();
  return base === "rg" || base === "rg.exe" || f.includes("/ripgrep/");
}

// cli.js's Glob tool runs `rg --files --glob … <path>` and its Grep tool runs
// `rg [-l|-c|-n|-C…] <pattern> --glob … <path>`. The vendored rg can't exec on
// PPC, so implement both in JS (see _ripgrep.js). Returns { code, stdout } that
// ripgrep would produce, or null if the shim threw.
function _rgShim(args, o) {
  const a = Array.isArray(args) ? args : [args];
  try { return _runRipgrep(a, o && o.cwd, { readdirSync: _readdirSync, statSync: _statSync, readFileSync: _readFileSync }); }
  catch (e) { _cplog("RGSHIM err " + (e && e.message)); return null; }
}

// A ChildProcess that "ran ripgrep": emits `out` on stdout and exits `code`
// (ripgrep: 0 when it matched, 1 when nothing — cli.js's dd() reads 1 as empty).
function _rgResultCp(file, args, out, callback, enc, code) {
  const buf = Buffer.from(out || "");
  if (code == null) code = buf.length ? 0 : 1;
  const cp = new ChildProcess();
  cp.spawnargs = [file, ...(Array.isArray(args) ? args : [args])];
  cp.stdin = new Writable({ write(c, en, cb) { cb(); } });
  cp.stdout = new Readable({ read() {} });
  cp.stderr = new Readable({ read() {} });
  cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
  cp.pid = 0; cp.exitCode = code;
  process.nextTick(() => {
    cp.emit("spawn");
    try { if (buf.length) cp.stdout.push(buf); } catch {}
    try { cp.stdout.push(null); } catch {}
    try { cp.stderr.push(null); } catch {}
    cp.emit("exit", code, null);
    cp.emit("close", code, null);
    // execFile semantics: a non-zero exit is reported as an error. cli.js's dd()
    // special-cases err.code===1 as "no matches", so this stays correct.
    if (callback) callback(code !== 0 ? Object.assign(new Error(`ripgrep exited ${code}`), { code }) : null,
      _decodeExecOut(buf, enc), _decodeExecOut(Buffer.alloc(0), enc));
  });
  return cp;
}
function _cleanEmptyCp(cp, callback, enc, code = 1) {
  cp.stdin = new Writable({ write(c, en, cb) { cb(); } });
  cp.stdout = new Readable({ read() { this.push(null); } });
  cp.stderr = new Readable({ read() { this.push(null); } });
  cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
  cp.pid = 0; cp.exitCode = code;
  process.nextTick(() => {
    cp.emit("spawn");
    cp.emit("exit", code, null);
    cp.emit("close", code, null);
    if (callback) callback(null, _decodeExecOut(Buffer.alloc(0), enc), _decodeExecOut(Buffer.alloc(0), enc));
  });
  return cp;
}

function execCommon(cmd, opts, callback) {
  _cplog("exec " + JSON.stringify(String(cmd).slice(0, 160)));
  const cp = new ChildProcess();
  const o = defaultOpts(typeof opts === "function" ? {} : opts);
  if (typeof opts === "function") callback = opts;
  let stdout = [], stderr = [], killed = false;
  const maxBuf = (typeof opts === "object" && opts?.maxBuffer) || 1024 * 1024;
  const enc = (typeof opts === "object" && opts) ? opts.encoding : undefined;

  // MorphOS: run the shell command through ksh via AmigaDOS (no fork).
  if (_shellBridgeOk()) {
    cp.pid = -1;
    cp.stdin = new Writable({ write(c, en, cb) { cb(); } });
    cp.stdout = new Readable({ read() {} });
    cp.stderr = new Readable({ read() {} });
    cp.stdio = [cp.stdin, cp.stdout, cp.stderr];
    process.nextTick(() => cp.emit("spawn"));
    _runViaShell(cmd, o, (code, so, se, err) => {
      if (killed) return;
      try { if (so && so.length) cp.stdout.push(so); } catch {}
      try { cp.stdout.push(null); } catch {}
      try { if (se && se.length) cp.stderr.push(se); } catch {}
      try { cp.stderr.push(null); } catch {}
      cp.exitCode = code;
      const sout = _decodeExecOut(so || Buffer.alloc(0), enc), serr = _decodeExecOut(se || Buffer.alloc(0), enc);
      const e2 = err
        ? err
        : (code !== 0 ? Object.assign(new Error(`Command failed: ${cmd}\n${serr.toString()}`), { code, killed: false, stdout: sout, stderr: serr }) : null);
      cp.emit("exit", code, null);
      cp.emit("close", code, null);
      if (callback) callback(e2, sout, serr);
    });
    if (o.timeout) { /* handled inside _runViaShell via o.timeout */ }
    return cp;
  }

  let res;
  try {
    res = N.spawn({ file: "/bin/sh", args: ["/bin/sh", "-c", cmd], cwd: o.cwd, env: o.env,
        stdio: ["pipe", "pipe", "pipe"] },
      (code, signal) => {
        cp.exitCode = code; cp.signalCode = signal;
        const so = _decodeExecOut(Buffer.concat(stdout), enc), se = _decodeExecOut(Buffer.concat(stderr), enc);
        if (killed) return;
        const err = code !== 0
          ? Object.assign(new Error(`Command failed: ${cmd}\n${se.toString()}`), { code, killed: false, stdout: so, stderr: se })
          : null;
        cp.emit("exit", code, signal);
        cp.emit("close", code, signal);
        if (callback) callback(err, so, se);
      });
  } catch (e) {
    return spawnFailCp(cp, callback, e, enc);
  }
  cp.pid = res.pid;
  cp.stdin = makePipeStream(res.stdio[0], true);
  cp.stdout = makePipeStream(res.stdio[1], false);
  cp.stderr = makePipeStream(res.stdio[2], false);
  cp.stdout.on("data", (c) => { stdout.push(c); if (stdout.reduce((n, b) => n + b.length, 0) > maxBuf) { killed = true; cp.kill("SIGKILL"); } });
  cp.stderr.on("data", (c) => stderr.push(c));
  if (o.timeout) setTimeout(() => cp.kill("SIGTERM"), o.timeout).unref?.();
  return cp;
}

export function exec(cmd, opts, callback) { return execCommon(cmd, opts, callback); }
export function execFile(file, args = [], opts = {}, callback) {
  _cplog("execFile " + JSON.stringify(file) + " " + JSON.stringify(Array.isArray(args) ? args : []));
  if (typeof args === "function") { callback = args; args = []; opts = {}; }
  else if (typeof opts === "function") { callback = opts; opts = {}; }
  const o = defaultOpts(opts);
  const enc = (opts && typeof opts === "object") ? opts.encoding : undefined;
  const url = _browserOpenUrl(file, args);
  if (url) {
    const ok = _openUrlAmiga(url);
    const bcp = _finishedCp(file, [url], ok ? 0 : 1);
    if (callback) process.nextTick(() => callback(
      ok ? null : Object.assign(new Error(`Command failed: ${file}`), { code: 1 }),
      _decodeExecOut(Buffer.alloc(0), enc), _decodeExecOut(Buffer.alloc(0), enc)));
    return bcp;
  }
  // MorphOS virtual bash: answer the `/bin/bash --version` probe.
  if (_isVBashProbe(file, args)) {
    const bcp = new ChildProcess();
    bcp.stdin = new Writable({ write(c, en, cb) { cb(); } });
    bcp.stdout = new Readable({ read() {} }); bcp.stderr = new Readable({ read() {} });
    bcp.stdio = [bcp.stdin, bcp.stdout, bcp.stderr];
    process.nextTick(() => {
      try { bcp.stdout.push(Buffer.from(_VBASH_VER)); } catch {}
      try { bcp.stdout.push(null); bcp.stderr.push(null); } catch {}
      bcp.exitCode = 0; bcp.emit("exit", 0, null); bcp.emit("close", 0, null);
      if (callback) callback(null, _decodeExecOut(Buffer.from(_VBASH_VER), enc), _decodeExecOut(Buffer.alloc(0), enc));
    });
    return bcp;
  }
  // MorphOS: a `<shell> -c "cmd"` execFile runs through ksh via AmigaDOS.
  const _shcmd = _shellBridgeOk() ? _asShellCmd(file, args) : null;
  if (_shcmd != null) {
    const bcp = new ChildProcess();
    bcp.stdin = new Writable({ write(c, en, cb) { cb(); } });
    bcp.stdout = new Readable({ read() {} }); bcp.stderr = new Readable({ read() {} });
    bcp.stdio = [bcp.stdin, bcp.stdout, bcp.stderr];
    process.nextTick(() => bcp.emit("spawn"));
    _runViaShell(_shcmd, o, (code, so, se, err) => {
      try { if (so && so.length) bcp.stdout.push(so); } catch {}
      try { bcp.stdout.push(null); } catch {}
      try { if (se && se.length) bcp.stderr.push(se); } catch {}
      try { bcp.stderr.push(null); } catch {}
      bcp.exitCode = code;
      const sout = _decodeExecOut(so || Buffer.alloc(0), enc), serr = _decodeExecOut(se || Buffer.alloc(0), enc);
      const e2 = err ? err : (code !== 0 ? Object.assign(new Error(`Command failed: ${file}\n${serr.toString()}`), { code, stdout: sout, stderr: serr }) : null);
      bcp.emit("exit", code, null); bcp.emit("close", code, null);
      if (callback) callback(e2, sout, serr);
    });
    return bcp;
  }

  // MorphOS: ripgrep can't exec; serve Glob (--files) and Grep (search) from the
  // JS shim. This is the path cli.js's dd() actually uses (execFile + callback).
  if (_isRipgrep(file)) {
    const r = _rgShim(args, o);
    if (r != null) return _rgResultCp(file, args, r.stdout, callback, enc, r.code);
    return _cleanEmptyCp(new ChildProcess(), callback, enc);
  }

  let stdout = [], stderr = [];
  const cp = new ChildProcess();
  let res;
  try {
    res = N.spawn({ file, args: [file, ...args], cwd: o.cwd, env: o.env,
        stdio: ["pipe", "pipe", "pipe"] },
      (code, signal) => {
        cp.exitCode = code;
        const so = _decodeExecOut(Buffer.concat(stdout), enc), se = _decodeExecOut(Buffer.concat(stderr), enc);
        const err = code !== 0 ? Object.assign(new Error(`Command failed: ${file}\n${se.toString()}`), { code, stdout: so, stderr: se }) : null;
        cp.emit("exit", code, signal);
        cp.emit("close", code, signal);
        if (callback) callback(err, so, se);
      });
  } catch (e) {
    if (_isRipgrep(file)) return _cleanEmptyCp(cp, callback, enc);
    return spawnFailCp(cp, callback, e, enc);
  }
  cp.pid = res.pid;
  cp.stdin = makePipeStream(res.stdio[0], true);
  cp.stdout = makePipeStream(res.stdio[1], false);
  cp.stderr = makePipeStream(res.stdio[2], false);
  cp.stdout.on("data", (c) => stdout.push(c));
  cp.stderr.on("data", (c) => stderr.push(c));
  return cp;
}

export function fork() { throw new Error("child_process.fork is not supported"); }
export const execSyncDefault = execSync;

export default { spawn, spawnSync, exec, execSync, execFile, execFileSync, ChildProcess };
