// Node test for the MorphOS Bash-tool output fix:
//   - fs/promises.open() returns a FileHandle (so cli.js's S.fd / S.close work)
//   - child_process.spawn(..., {stdio:["pipe", fd, fd]}) writes the captured
//     shell output to that fd's FILE (cli.js's uw.getStdout reads the file).
// Runs the REAL lib files (fs.js, fs/promises.js, child_process.js) with
// "native" swapped for a real-fs-backed fake whose amigaRun actually runs the
// ksh wrapper via /bin/sh.
//   node mosnode/tests/bash_output.test.mjs [path/to/lib]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const LIB = path.resolve(process.argv[2] || new URL("../lib", import.meta.url).pathname);
const PROMISES_SRC = new URL("../lib/fs/promises.js", import.meta.url).pathname; // promises only lives in the full lib set
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mosnode-bash-test-"));
fs.mkdirSync(path.join(work, "tmp"), { recursive: true });

// ---- fake native (real-fs backed) ----
fs.writeFileSync(path.join(work, "fake_native.mjs"), `
import * as _fs from "node:fs";
import { execSync } from "node:child_process";
export const state = { env: {} };
export function getenv(k) { return state.env[k]; }
export function setenv(k, v) { state.env[k] = String(v); }
export function homedir() { return state.env.HOME || "/"; }
export const constants = { fs: {} };
function flagMap(f) { return typeof f === "number" ? "a" : f; }
export function fsOpen(p, flags, mode) { return _fs.openSync(p, flagMap(flags), mode); }
export function fsClose(fd) { return _fs.closeSync(fd); }
export function fsWrite(fd, data, off, len, pos) {
  if (typeof data === "string") return _fs.writeSync(fd, data);
  return _fs.writeSync(fd, data, off ?? 0, (len ?? data.length), (pos == null || pos < 0) ? null : pos);
}
export function fsRead(fd, buf, off, len, pos) { return _fs.readSync(fd, buf, off ?? 0, len ?? buf.length, (pos == null || pos < 0) ? null : pos); }
export function fsReadFile(p, enc) { return enc ? _fs.readFileSync(p, enc) : _fs.readFileSync(p); }
export function fsWriteFile(p, data, flags, mode) { _fs.writeFileSync(p, data, { flag: (flags === "a" ? "a" : "w") }); }
export function fsStat(p) { return _fs.statSync(p); }
export function fsExists(p) { return _fs.existsSync(p); }
export function fsUnlink(p) { try { _fs.unlinkSync(p); } catch {} }
export function fsMkdir(p, mode, rec) { _fs.mkdirSync(p, { recursive: !!rec }); }
export function utf8Decode(b) { return Buffer.from(b).toString("utf8"); }
export function latin1Decode(b) { return Buffer.from(b).toString("latin1"); }
// amigaRun: "<ksh> <wrapper>" both in amiga VOL:rest form; run wrapper with sh.
export function amigaRun(cmdline) {
  const toks = cmdline.trim().split(/\\s+/);
  const amiga = toks[toks.length - 1];
  const real = "/" + amiga.replace(":", "/");
  try { execSync("sh " + JSON.stringify(real), { stdio: "ignore" }); return 0; }
  catch (e) { return 0; } // wrapper writes end$? regardless
}
`);

const rewrite = (src) => src
  .replace(/from "native"/g, 'from "./fake_native.mjs"')
  .replace(/from "\.\/events\.js"/g, 'from "node:events"')
  .replace(/from "\.\/buffer\.js"/g, 'from "node:buffer"')
  .replace(/from "\.\/stream\.js"/g, 'from "node:stream"')
  .replace(/from "\.\.\/fs\.js"/g, 'from "./fs.mjs"')
  .replace(/from "\.\/fs\/promises\.js"/g, 'from "./promises.mjs"')
  .replace(/from "\.\/fs\.js"/g, 'from "./fs.mjs"')
  .replace(/from "\.\/_ripgrep\.js"/g, 'from "./_ripgrep.mjs"')
  .replace(/from "\.\/os\.js"/g, 'from "./os.mjs"');

// os.js stub (child_process only needs homedir, off our path)
fs.writeFileSync(path.join(work, "os.mjs"), 'export const homedir = () => "/home";\n');
fs.writeFileSync(path.join(work, "fs.mjs"), rewrite(fs.readFileSync(path.join(LIB, "fs.js"), "utf8")));
fs.writeFileSync(path.join(work, "promises.mjs"), rewrite(fs.readFileSync(PROMISES_SRC, "utf8")));
fs.writeFileSync(path.join(work, "_ripgrep.mjs"), rewrite(fs.readFileSync(path.join(LIB, "_ripgrep.js"), "utf8")));
fs.writeFileSync(path.join(work, "child_process.mjs"), rewrite(fs.readFileSync(path.join(LIB, "child_process.js"), "utf8")));

const N = await import(pathToFileURL(path.join(work, "fake_native.mjs")));
N.setenv("MOSNODE_KSH", "/bin/sh");
N.setenv("MOSNODE_HOME", work);
N.setenv("HOME", work);

const FS = await import(pathToFileURL(path.join(work, "fs.mjs")));
const P = await import(pathToFileURL(path.join(work, "promises.mjs")));
const CP = await import(pathToFileURL(path.join(work, "child_process.mjs")));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra); }
};

// ---- 1. open() returns a FileHandle ----
const outPath = path.join(work, "tasks", "t1.output");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const S = await P.open(outPath, 0x301 /* O_WRONLY|O_CREAT|O_APPEND-ish */);
ok("open() returns FileHandle with numeric .fd", S && typeof S.fd === "number", "S=" + JSON.stringify(S));
ok("FileHandle has close()", typeof S.close === "function");

// ---- 2. spawn with stdio=['pipe', fd, fd]; output lands in the file ----
const U = CP.spawn("/bin/bash", ["-c", "echo HELLO && echo OOPS 1>&2"], { stdio: ["pipe", S.fd, S.fd] });
// mimic cli.js non-streaming path: do NOT read U.stdout; close the handle.
await S.close();
const code = await new Promise((res) => U.on("close", (c) => res(c)));
ok("child exit code 0", code === 0, "code=" + code);

const content = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "<missing>";
ok("output file contains stdout 'HELLO'", content.includes("HELLO"), "content=" + JSON.stringify(content));
ok("output file contains stderr 'OOPS'", content.includes("OOPS"), "content=" + JSON.stringify(content));

// ---- 3. readback via fs.readFileSync (how uw reads the file) ----
const rb = FS.readFileSync(outPath, "utf8");
ok("readFileSync reads output back", rb.includes("HELLO") && rb.includes("OOPS"), "rb=" + JSON.stringify(rb));

// ---- 4. createReadStream honours {fd} ----
const rfd = N.fsOpen(outPath, "r");
const rs = FS.createReadStream(null, { fd: rfd, encoding: "utf8" });
let acc = "";
rs.on("data", (c) => acc += c);
await new Promise((res) => rs.on("end", res));
N.fsClose(rfd);
ok("createReadStream({fd}) reads file", acc.includes("HELLO"), "acc=" + JSON.stringify(acc));

console.log("\n" + pass + " passed, " + fail + " failed");
try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
