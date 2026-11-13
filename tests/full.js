import * as fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn, exec } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import util from "node:util";
import { EventEmitter } from "node:events";
import { Readable, Writable, pipeline } from "node:stream";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ok -", name); }
  else { fail++; console.log("  FAIL -", name); }
}

// Buffer
ok(Buffer.from("hello").length === 5, "Buffer.from");
ok(Buffer.from("hi").toString("base64") === "aGk=", "buffer base64");
ok(Buffer.from("aGk=", "base64").toString() === "hi", "buffer base64 decode");
ok(Buffer.alloc(3).fill(7)[2] === 7, "Buffer.alloc/fill");

// crypto
ok(crypto.createHash("sha256").update("abc").digest("hex") ===
   "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256");
ok(/^[0-9a-f-]{36}$/.test(crypto.randomUUID()), "randomUUID");

// zlib
const gz = zlib.gzipSync("compress me");
ok(zlib.gunzipSync(gz).toString() === "compress me", "gzip roundtrip");

// async fs callback
fs.writeFile("/tmp/mn2.txt", "abc", (err) => {
  ok(!err, "async writeFile");
  fs.readFile("/tmp/mn2.txt", "utf8", (err2, data) => {
    ok(data === "abc", "async readFile");
  });
});

// fs promises + await at top level
const txt = await fsp.readFile("/tmp/mn2.txt", "utf8").catch(() => "none");
ok(typeof txt === "string", "fsp.readFile");

// events
const ee = new EventEmitter();
let got = false;
ee.on("x", (v) => { got = v; });
ee.emit("x", 42);
ok(got === 42, "EventEmitter");

// streams: pipeline readable->writable
const src = Readable.from ? null : null;
async function streamTest() {
  const r = new Readable({ read() { this.push("chunk1"); this.push("chunk2"); this.push(null); } });
  let collected = "";
  const w = new Writable({ write(c, e, cb) { collected += c; cb(); } });
  await new Promise((res, rej) => pipeline(r, w, (err) => err ? rej(err) : res()));
  ok(collected === "chunk1chunk2", "stream pipeline");
}
await streamTest();

// child_process spawn with pipes
const child = spawn("cat");
let out = "";
child.stdout.on("data", (c) => out += c);
const closed = new Promise((res) => child.on("close", (code) => res(code)));
child.stdin.write("piped data\n");
child.stdin.end();
const code = await closed;
ok(code === 0 && out === "piped data\n", "spawn cat pipes");

// exec
const ex = await new Promise((res) => exec("echo shell-exec", (err, so) => res({ err, so })));
ok(!ex.err && ex.so.toString().trim() === "shell-exec", "exec");

// createRequire CJS
const req = createRequire(import.meta.filename);
const pathMod = req("node:path");
ok(pathMod.join("a", "b") === "a/b", "createRequire builtin");

// util
ok(util.format("%s-%d", "x", 5) === "x-5", "util.format");

// process.nextTick ordering
let order = [];
process.nextTick(() => order.push("tick"));
setTimeout(() => {
  ok(order[0] === "tick", "nextTick before timeout");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 80);
