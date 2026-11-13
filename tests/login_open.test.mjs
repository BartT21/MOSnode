// Node test for the MorphOS login fixes in lib/os.js + lib/child_process.js:
//   - os.homedir() fallback when HOME is unset
//   - browser-open intercept (xdg-open/$BROWSER <url>) -> N.amigaRun, with
//     AmigaDOS-safe quoting and a login.html fallback.
// Runs the real lib files with "native" swapped for a fake and the lib's own
// events/buffer/stream swapped for Node's built-ins.
//   node mosnode/tests/login_open.test.mjs [path/to/lib]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const LIB = path.resolve(process.argv[2] || new URL("../lib", import.meta.url).pathname);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mosnode-login-test-"));
const home = path.join(work, "home");
fs.mkdirSync(home);

// fake native module: env + recorded calls
fs.writeFileSync(path.join(work, "fake_native.mjs"), `
export const state = { env: {}, runs: [], amigaRun: (cmd) => 0, writes: [] };
export function getenv(k) { return state.env[k]; }
export function homedir() { return state.env.HOME || "/"; }
export function fsWriteFile(p, data, flags, mode) {
  state.writes.push(p);
  require_fs().writeFileSync(p, data);
}
import * as _fs from "node:fs";
function require_fs() { return _fs; }
export const constants = {};
export let amigaRun = (cmd) => { state.runs.push(cmd); return state.amigaRun(cmd); };
export function _dropAmigaRun() { amigaRun = undefined; }
`);
const rewrite = (src) => src
  .replace(/from "native"/g, 'from "./fake_native.mjs"')
  .replace(/from "\.\/events\.js"/g, 'from "node:events"')
  .replace(/from "\.\/buffer\.js"/g, 'from "node:buffer"')
  .replace(/from "\.\/stream\.js"/g, 'from "node:stream"')
  .replace(/from "\.\.\/fs\.js"/g, 'from "./fs.mjs"')
  .replace(/from "\.\/fs\/promises\.js"/g, 'from "./promises.mjs"')
  .replace(/from "\.\/fs\.js"/g, 'from "./fs.mjs"')
  .replace(/from "\.\/_ripgrep\.js"/g, 'from "./_ripgrep.mjs"');
for (const f of ["os.js", "fs.js", "_ripgrep.js", "child_process.js"])
  fs.writeFileSync(path.join(work, f.replace(/\.js$/, ".mjs")),
    rewrite(fs.readFileSync(path.join(LIB, f), "utf8")).replace(/"\.\/os\.js"/g, '"./os.mjs"'));
fs.writeFileSync(path.join(work, "promises.mjs"),
  rewrite(fs.readFileSync(path.join(LIB, "fs/promises.js"), "utf8")));

const N = await import(pathToFileURL(path.join(work, "fake_native.mjs")));
const OS = await import(pathToFileURL(path.join(work, "os.mjs")));
const CP = await import(pathToFileURL(path.join(work, "child_process.mjs")));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra); }
};
const reset = (env = {}) => { N.state.env = env; N.state.runs = []; N.state.writes = []; N.state.amigaRun = () => 0; };
const waitExit = (cp) => new Promise((res) => {
  let code; cp.on("exit", (c) => { code = c; });
  cp.on("close", (c) => res(code ?? c));
  cp.stdout?.resume(); cp.stderr?.resume();
});
const URL1 = "https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A4711%2Fcallback&state=x_y-Z";

// ---- homedir ----
reset({ HOME: "/Work/mosnode" });
ok("homedir: HOME wins", OS.homedir() === "/Work/mosnode", OS.homedir());
reset({ MOSNODE_LIB: "Work:mosnode/lib" });
ok("homedir: HOME unset -> MOSNODE_LIB parent", OS.homedir() === "/Work/mosnode", OS.homedir());
reset({ MOSNODE_HOME: "Work:Claude", MOSNODE_LIB: "Work:mosnode/lib" });
ok("homedir: MOSNODE_HOME beats MOSNODE_LIB", OS.homedir() === "/Work/Claude", OS.homedir());
reset({ MOSNODE_LIB: "/Work/mosnode/lib/" });
ok("homedir: unix-style MOSNODE_LIB", OS.homedir() === "/Work/mosnode", OS.homedir());
reset({});
ok("homedir: nothing set -> /", OS.homedir() === "/", OS.homedir());
ok("amigaToUnix volume root", OS._amigaToUnix("Work:") === "/Work");

// ---- detection ----
reset({});
ok("detect xdg-open url", CP._browserOpenUrl("xdg-open", [URL1]) === URL1);
ok("detect quoted url", CP._browserOpenUrl("xdg-open", ['"' + URL1 + '"']) === URL1);
ok("ignore non-url arg", CP._browserOpenUrl("xdg-open", ["/tmp/file"]) === null);
ok("ignore other programs", CP._browserOpenUrl("rg", [URL1]) === null);
ok("ignore 2 args", CP._browserOpenUrl("xdg-open", [URL1, "x"]) === null);
reset({ BROWSER: "mybrowser" });
ok("detect $BROWSER", CP._browserOpenUrl("mybrowser", [URL1]) === URL1);

// ---- quoting ----
ok("plain oauth url unchanged", CP._amigaQuoteUrl(URL1) === URL1);
ok("escape \" * ` $ ;", CP._amigaQuoteUrl('https://x/a"b*c`d$e;f') === "https://x/a%22b%2Ac%60d%24e%3Bf",
   CP._amigaQuoteUrl('https://x/a"b*c`d$e;f'));
ok("reject control chars", CP._amigaQuoteUrl("https://x/\n") === null);

// ---- spawn -> amigaRun ----
reset({ HOME: home });
let cp = CP.spawn("xdg-open", [URL1]);
let code = await waitExit(cp);
ok("spawn: exit 0", code === 0, code);
ok("spawn: Wayfarer command", N.state.runs[0] === '"SYS:Applications/Wayfarer/Wayfarer" "' + URL1 + '"', N.state.runs[0]);
ok("spawn: no pid (kill is a no-op)", cp.pid === undefined && cp.kill() === true);

reset({ HOME: home, MOSNODE_BROWSER: "Work:Apps/Other/Other" });
code = await waitExit(CP.spawn("xdg-open", [URL1]));
ok("MOSNODE_BROWSER override", N.state.runs[0] === '"Work:Apps/Other/Other" "' + URL1 + '"', N.state.runs[0]);

// ---- fallback when amigaRun fails ----
reset({ HOME: home });
N.state.amigaRun = () => -1;
code = await waitExit(CP.spawn("xdg-open", [URL1]));
const html = fs.readFileSync(path.join(home, "login.html"), "utf8");
ok("fallback: exit 1", code === 1, code);
ok("fallback: login.html has escaped url", html.includes(URL1.replace(/&/g, "&amp;")) && !html.includes("&client_id"));
ok("fallback: login_url.txt", fs.readFileSync(path.join(home, "login_url.txt"), "utf8") === URL1 + "\n");

// ---- execFile / spawnSync ----
reset({ HOME: home });
const r = await new Promise((res) => CP.execFile("xdg-open", [URL1], (err, so, se) => res({ err, so, se })));
ok("execFile: callback ok", r.err === null && r.so === "" && N.state.runs.length === 1, JSON.stringify(r));
reset({ HOME: home });
const s = CP.spawnSync("xdg-open", [URL1]);
ok("spawnSync: status 0", s.status === 0 && s.error === undefined && N.state.runs.length === 1, JSON.stringify(s));

// ---- older binary without amigaRun ----
reset({ HOME: home });
N._dropAmigaRun();
code = await waitExit(CP.spawn("xdg-open", [URL1]));
ok("no amigaRun: exit 1 + fallback file", code === 1 && N.state.runs.length === 0 && N.state.writes.length === 2, code);

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
