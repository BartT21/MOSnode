// Download Claude Code (cli.js) directly on MorphOS, from Anthropic's official
// npm registry — no second computer needed. Uses mosnode's own HTTPS + gunzip.
// This is the same package `npm pack @anthropic-ai/claude-code@VERSION` fetches;
// each user downloads their own copy from the official source. Nothing is
// redistributed by MOSnode.
//
// Writes cli.js into the current directory. Run from the launcher, or by hand:
//   cd Work:mosnode
//   mosnode get-cli.js
import * as zlib from "zlib";
import { writeFileSync } from "fs";

const VERSION = "2.1.112";
const URL = `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${VERSION}.tgz`;
const WANT = "package/cli.js";
const OUT = "cli.js";

// Find one file in an (uncompressed) tar buffer. ustar/gnu, standard 512-byte
// records; the name we want ("package/cli.js") fits the 100-byte name field.
function untarFind(tar, want) {
  let p = 0;
  while (p + 512 <= tar.length) {
    let e = p;
    while (e < p + 100 && tar[e] !== 0) e++;
    const name = tar.toString("latin1", p, e);
    if (name === "") break;                      // end-of-archive zero block
    let so = p + 124, se = so;
    while (se < p + 136 && tar[se] !== 0 && tar[se] !== 32) se++;
    const size = parseInt(tar.toString("latin1", so, se), 8) || 0;
    const type = tar[p + 156];                   // '0' (0x30) or NUL = regular file
    const dataStart = p + 512;
    if (name === want && (type === 0x30 || type === 0))
      return tar.subarray(dataStart, dataStart + size);
    p = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function main() {
  console.error("Downloading Claude Code " + VERSION + " from npm (~19 MB)...");
  const res = await fetch(URL);
  if (!res.ok) throw new Error("HTTP " + res.status + " fetching the npm tarball");
  const gz = Buffer.from(await res.arrayBuffer());
  console.error("Downloaded " + gz.length + " bytes. Decompressing...");
  const tar = zlib.gunzipSync(gz);
  const cli = untarFind(tar, WANT);
  if (!cli) throw new Error(WANT + " not found in the package");
  writeFileSync(OUT, cli);
  console.error("Saved " + OUT + " (" + cli.length + " bytes).");
}

main().catch((e) => {
  console.error("get-cli failed: " + (e && e.message ? e.message : e));
  if (typeof process !== "undefined" && process.exit) process.exit(1);
});
