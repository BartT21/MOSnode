// stdio streams over native fds
import * as N from "native";
import { Writable, Readable } from "./stream.js";

// --- Console charset shim -------------------------------------------------
// The MorphOS console renders bytes as Latin-1, so a multi-byte UTF-8 glyph
// (box-drawing, spinners, arrows, emoji) shows as mojibake AND throws off
// Ink's redraw column math (Ink counts 1 column; the console advances 3).
// Collapse every non-ASCII code point to ONE ASCII byte so 1 glyph = 1 column.
// ASCII — including every ANSI/VT escape and color code — passes through
// untouched. Done in JS (not C) so it is testable under Node and carries no
// native-memory or PPC-miscompile risk.
const _CP = new Map([
  // horizontals / dashes
  [0x2500,"-"],[0x2501,"-"],[0x2504,"-"],[0x2505,"-"],[0x2508,"-"],[0x2509,"-"],
  [0x2550,"-"],[0x2574,"-"],[0x2576,"-"],[0x2578,"-"],[0x257a,"-"],
  [0x2014,"-"],[0x2013,"-"],[0x2015,"-"],[0x2212,"-"],
  // verticals
  [0x2502,"|"],[0x2503,"|"],[0x2506,"|"],[0x2507,"|"],[0x250a,"|"],[0x250b,"|"],
  [0x2551,"|"],[0x2575,"|"],[0x2577,"|"],[0x2579,"|"],[0x257b,"|"],
  // blocks / filled
  [0x2588,"#"],[0x2593,"#"],[0x2592,"#"],[0x2591,"#"],[0x25a0,"#"],[0x25aa,"#"],[0x25ae,"#"],
  [0x2580,"="],[0x2584,"="],[0x258c,"="],[0x2590,"="],
  // arrows / carets
  [0x276f,">"],[0x25b6,">"],[0x25ba,">"],[0x25b8,">"],[0x2192,">"],[0x2794,">"],
  [0x2771,">"],[0x203a,">"],[0x00bb,">"],
  [0x276e,"<"],[0x25c0,"<"],[0x25c4,"<"],[0x25c2,"<"],[0x2190,"<"],[0x2770,"<"],
  [0x2039,"<"],[0x00ab,"<"],
  [0x2191,"^"],[0x25b2,"^"],[0x25b4,"^"],
  [0x2193,"v"],[0x25bc,"v"],[0x25be,"v"],
  // check / cross
  [0x2713,"v"],[0x2714,"v"],[0x221a,"v"],
  [0x2717,"x"],[0x2718,"x"],[0x2715,"x"],[0x2716,"x"],[0x00d7,"x"],[0x2573,"x"],[0x274c,"x"],
  // bullets / stars
  [0x25cf,"*"],[0x2b24,"*"],[0x26ab,"*"],[0x25c6,"*"],[0x2666,"*"],[0x2022,"*"],
  [0x2219,"*"],[0x00b7,"*"],[0x2027,"*"],[0x2605,"*"],[0x2606,"*"],[0x2737,"*"],
  [0x273b,"*"],[0x2748,"*"],
  [0x25cb,"o"],[0x25ef,"o"],[0x26aa,"o"],[0x25c7,"o"],[0x25e6,"o"],
  // punctuation
  [0x2026,"."],
  [0x2018,"'"],[0x2019,"'"],[0x2032,"'"],
  [0x201c,'"'],[0x201d,'"'],[0x2033,'"'],
  // spaces -> plain space
  [0x00a0," "],[0x2007," "],[0x202f," "],[0x2009," "],[0x200a," "],
]);

function cpToAscii(cp) {
  const m = _CP.get(cp);
  if (m !== undefined) return m;
  if (cp >= 0x2800 && cp <= 0x28ff) return "*";  // braille spinner frames
  if (cp >= 0x2500 && cp <= 0x257f) return "+";  // other box-drawing -> corner
  if (cp >= 0x2580 && cp <= 0x259f) return "#";  // block elements
  if (cp >= 0x2190 && cp <= 0x21ff) return ">";  // arrows
  if (cp >= 0x2460 && cp <= 0x24ff) return "o";  // enclosed alphanumerics
  if (cp >= 0x2600 && cp <= 0x27bf) return "*";  // misc symbols / dingbats
  if (cp >= 0x1f300 && cp <= 0x1faff) return "*"; // emoji
  return "?";                                      // keep the column aligned
}

// Fast path: pure-ASCII strings (the vast majority of writes, e.g. plain
// ANSI-colored text) are returned as-is with no per-char work.
function translitTTY(chunk) {
  if (typeof chunk === "string") {
    let ascii = true;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) >= 0x80) { ascii = false; break; }
    }
    if (ascii) return chunk;
    let out = "";
    for (const ch of chunk) {                 // iterates by code point
      const cp = ch.codePointAt(0);
      out += cp < 0x80 ? ch : cpToAscii(cp);
    }
    return out;
  }
  // Uint8Array: decode UTF-8 into code points, one ASCII byte out per point.
  const a = chunk;
  let out = "";
  for (let i = 0; i < a.length; ) {
    const c = a[i];
    if (c < 0x80) { out += String.fromCharCode(c); i++; continue; }
    let cp, n;
    if ((c & 0xe0) === 0xc0) { cp = c & 0x1f; n = 1; }
    else if ((c & 0xf0) === 0xe0) { cp = c & 0x0f; n = 2; }
    else if ((c & 0xf8) === 0xf0) { cp = c & 0x07; n = 3; }
    else { out += "?"; i++; continue; }
    if (i + n >= a.length) { out += "?"; break; }
    let ok = true;
    for (let k = 1; k <= n; k++) {
      if ((a[i + k] & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (a[i + k] & 0x3f);
    }
    if (!ok) { out += "?"; i++; continue; }
    out += cpToAscii(cp);
    i += n + 1;
  }
  return out;
}
// -------------------------------------------------------------------------

export function createStdio(fd) {
  const h = N.openFdStream(fd);
  const isTTY = N.isatty(fd);
  if (fd === 0) {
    const s = new Readable({ read() {
      N.streamReadStart(h, (err, chunk) => {
        if (err || chunk === null) { N.streamReadStop(h); s.push(null); }
        else if (!s.push(chunk)) N.streamReadStop(h);
      });
    } });
    N.unref(h);
    s.setRawMode = (m) => N.ttySetRawMode(fd, m);
    s.isTTY = isTTY;
    s.ref = () => N.ref(h); s.unref = () => N.unref(h);
    return s;
  }
  const s = new Writable({
    write(chunk, enc, cb) {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        process.stderr.write("[stdio] coercing chunk of type " + (chunk && chunk.constructor && chunk.constructor.name) + "\n");
        chunk = String(chunk);
      }
      // On a real TTY, collapse non-ASCII glyphs to one byte each so the
      // Latin-1 console reads cleanly and Ink's redraw columns line up.
      if (isTTY) chunk = translitTTY(chunk);
      // Report completion synchronously. N.streamWrite writes small chunks
      // directly and preserves order for anything it must queue; blocking the
      // JS Writable on the deferred native callback would stall back-to-back
      // writes across loop turns and lose output on process.exit().
      N.streamWrite(h, chunk, () => {});
      cb();
    },
  });
  s.fd = fd;
  s.isTTY = isTTY;
  const size = N.ttyGetWindowSize(fd);
  if (size) { s.columns = size[0]; s.rows = size[1]; }
  s._refreshSize = () => { const sz = N.ttyGetWindowSize(fd); if (sz) { s.columns = sz[0]; s.rows = sz[1]; } };
  s.clearLine = () => { N.fsWrite(fd, "\r\x1b[K"); };
  s.cursorTo = () => {};
  s.moveCursor = () => {};
  s.write = ((orig) => function (d, ...rest) {
    const cb = typeof rest[rest.length - 1] === "function" ? rest.pop() : null;
    try { orig.call(this, d, ...rest); if (cb) cb(); } catch (e) { if (cb) cb(e); }
    return true;
  })(s.write);
  return s;
}
