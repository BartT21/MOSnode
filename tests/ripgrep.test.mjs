// Portable test for lib/_ripgrep.js — the JS ripgrep shim that backs Claude
// Code's Glob and Grep tools on MorphOS (the bundled rg binary can't exec on
// PPC). Runs under plain Node against a temp fixture; no `rg` binary needed.
//
//   node tests/ripgrep.test.mjs
import { runRgFiles, runRgSearch, runRipgrep } from "../lib/_ripgrep.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mosnode-rg-"));
const W = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
W("a.js", "export const x = 1;\nfunction foo() {}\n");
W("b.txt", "hello foo\nbar\n");
W("src/c.js", "// nested\nfunction foo() { return 2; }\n");
W("src/d.ts", "const y: number = 3;\n");
W("node_modules/dep/e.js", "ignored();\n");

const nfs = { readdirSync: fs.readdirSync, statSync: fs.statSync, readFileSync: fs.readFileSync };
let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) { pass++; } else { fail++; console.log("FAIL", name, "  got:", JSON.stringify(got)); } };
const lines = (s) => s.split("\n").filter(Boolean);
const rel = (a) => a.map((x) => x.replace(root + "/", "")).sort();

// --- Glob (--files) ---
ok("glob *.js finds all .js at any depth",
  JSON.stringify(rel(lines(runRgFiles(["--files", "--glob", "*.js", root], root, nfs)))) ===
  JSON.stringify(["a.js", "node_modules/dep/e.js", "src/c.js"]),
  rel(lines(runRgFiles(["--files", "--glob", "*.js", root], root, nfs))));

ok("glob *.js with !node_modules exclude prunes the dir",
  JSON.stringify(rel(lines(runRgFiles(["--files", "--glob", "*.js", "--glob", "!node_modules", root], root, nfs)))) ===
  JSON.stringify(["a.js", "src/c.js"]),
  rel(lines(runRgFiles(["--files", "--glob", "*.js", "--glob", "!node_modules", root], root, nfs))));

ok("glob *.{js,ts} brace expansion",
  rel(lines(runRgFiles(["--files", "--glob", "*.{js,ts}", "--glob", "!node_modules", root], root, nfs))).join(",") ===
  "a.js,src/c.js,src/d.ts",
  rel(lines(runRgFiles(["--files", "--glob", "*.{js,ts}", "--glob", "!node_modules", root], root, nfs))));

ok("anchored src/*.js does NOT match (absolute root, like ripgrep)",
  lines(runRgFiles(["--files", "--glob", "src/*.js", root], root, nfs)).length === 0,
  lines(runRgFiles(["--files", "--glob", "src/*.js", root], root, nfs)));

// --- Grep: files_with_matches (-l) ---
ok("grep -l foo lists matching files",
  JSON.stringify(rel(lines(runRgSearch(["-l", "foo", "--glob", "!node_modules", root], root, nfs)))) ===
  JSON.stringify(["a.js", "b.txt", "src/c.js"]),
  rel(lines(runRgSearch(["-l", "foo", "--glob", "!node_modules", root], root, nfs))));

// --- Grep: count (-c) ---
ok("grep -c counts matching lines per file",
  lines(runRgSearch(["-c", "function", "--glob", "a.js", root], root, nfs))[0].endsWith("/a.js:1"),
  lines(runRgSearch(["-c", "function", "--glob", "a.js", root], root, nfs)));

// --- Grep: content with -n ---
{
  const out = lines(runRgSearch(["-n", "foo", "--glob", "a.js", root], root, nfs));
  ok("grep -n emits path:line:text", out.length === 1 && /\/a\.js:2:function foo\(\) \{\}$/.test(out[0]), out);
}

// --- Grep: -i case-insensitive ---
{
  W("case.txt", "FOO\nfoo\n");
  const out = lines(runRgSearch(["-n", "-i", "foo", "--glob", "case.txt", root], root, nfs));
  ok("grep -i matches both cases", out.length === 2, out);
}

// --- Grep: context -C1 uses `-`/`--` separators ---
{
  const out = runRgSearch(["-n", "-C", "1", "return 2", "--glob", "c.js", root], root, nfs);
  ok("grep -C context: match line uses ':' and context uses '-'",
    /\/src\/c\.js-1-\/\/ nested\n.*\/src\/c\.js:2:function foo\(\) \{ return 2; \}/.test(out), out);
}

// --- dispatcher exit codes ---
ok("runRipgrep exit 0 when matched",  runRipgrep(["--files", "--glob", "*.js", root], root, nfs).code === 0);
ok("runRipgrep exit 1 when no match", runRipgrep(["--files", "--glob", "*.nope", root], root, nfs).code === 1);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
