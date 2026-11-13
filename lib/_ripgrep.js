// lib/_ripgrep.js — minimal ripgrep shim for MorphOS.
//
// cli.js's Glob tool (and the file-listing side of Grep) shells out to a
// vendored ripgrep binary: `rg --files --glob <pattern> --sort=modified
// --no-ignore --hidden [--glob !<exclude>]... <path>`. That prebuilt binary is
// x86/arm and can't exec on PPC, so the spawn fails and the tool silently
// reports "no files" (exit 1 = ripgrep's no-match). This module reimplements the
// `--files` subset in JS so Glob actually finds files.
//
// Glob semantics follow ripgrep's gitignore-style `--glob`:
//   - a pattern with no '/' (ignoring a trailing one) matches the BASENAME at any
//     depth (so `*.js` matches `a.js` and `src/b.js`);
//   - a pattern containing '/' (or a leading '/') is ANCHORED to the search root;
//   - `*` matches within a path segment, `**` crosses '/', `?` one char,
//     `[...]` a class, `{a,b}` an alternation;
//   - a leading '!' negates (exclude); a directory match prunes its subtree.
// `--sort=modified` sorts ascending by mtime, exactly like ripgrep.
//
// No fs import here: the caller passes an fs implementation (`{readdirSync,
// statSync}`) into runRgFiles, which keeps this module pure and unit-testable
// under plain Node with node:fs.

// Convert a gitignore glob body (no leading '!', no trailing '/') to a RegExp
// source matching a POSIX relative path.
export function globBodyToRe(glob) {
  let i = 0, out = "";
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") { i++; out += "(?:.*/)?"; }   // `**/` => zero+ dirs
        else out += ".*";                                   // `**`  => anything
      } else { out += "[^/]*"; i++; }                        // `*`   => within segment
    } else if (c === "?") { out += "[^/]"; i++; }
    else if (c === "[") {
      let cls = "["; i++;
      if (glob[i] === "!" || glob[i] === "^") { cls += "^"; i++; }
      if (glob[i] === "]") { cls += "\\]"; i++; }
      while (i < n && glob[i] !== "]") {
        const ch = glob[i];
        if (ch === "\\") { cls += "\\" + (glob[i + 1] || ""); i += 2; continue; }
        if (ch === "[") { cls += "\\["; i++; continue; }
        cls += ch; i++;
      }
      cls += "]"; i++;
      out += cls;
    } else if (c === "{") {
      i++;
      let depth = 0, buf = "";
      const parts = [];
      while (i < n) {
        const ch = glob[i];
        if (ch === "{") { depth++; buf += ch; i++; }
        else if (ch === "}") { if (depth === 0) { i++; break; } depth--; buf += ch; i++; }
        else if (ch === "," && depth === 0) { parts.push(buf); buf = ""; i++; }
        else { buf += ch; i++; }
      }
      parts.push(buf);
      out += "(?:" + parts.map(globBodyToRe).join("|") + ")";
    } else if (c === "/") { out += "/"; i++; }
    else if (/[.+^$()|\\]/.test(c)) { out += "\\" + c; i++; }
    else { out += c; i++; }
  }
  return out;
}

// Build a matcher from a single `--glob` value.
export function buildMatcher(glob) {
  let g = glob, negated = false, dirOnly = false;
  if (g[0] === "!") { negated = true; g = g.slice(1); }
  if (g.endsWith("/")) { dirOnly = true; g = g.slice(0, -1); }
  let anchored = false;
  if (g[0] === "/") { anchored = true; g = g.slice(1); }
  if (g.includes("/")) anchored = true;
  const body = globBodyToRe(g);
  const src = (anchored ? "^" : "^(?:.*/)?") + body + "$";
  return { re: new RegExp(src), negated, dirOnly, anchored };
}

// A path is excluded if any exclude matcher matches it, OR (for a directory
// name/dir pattern) matches an ancestor directory prefix (pruning the subtree).
function _excluded(rel, excludes) {
  for (const m of excludes) {
    if (m.re.test(rel)) return true;
    const parts = rel.split("/");
    let prefix = "";
    for (let k = 0; k < parts.length - 1; k++) {
      prefix = prefix ? prefix + "/" + parts[k] : parts[k];
      if (m.re.test(prefix)) return true;
    }
  }
  return false;
}

// Does a directory (relative path `rel`) match any exclude as a directory?
function _dirExcluded(rel, excludes) {
  for (const m of excludes) if (m.re.test(rel)) return true;
  return false;
}

// A subset of ripgrep's built-in --type globs (the Grep tool occasionally sets
// --type). Unknown types are ignored (no filtering) rather than erroring.
const RG_TYPES = {
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue"],
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  py: ["*.py", "*.pyi", "*.pyw"],
  java: ["*.java"], c: ["*.c", "*.h"], cpp: ["*.cpp", "*.cc", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
  go: ["*.go"], rust: ["*.rs"], ruby: ["*.rb"], rb: ["*.rb"], php: ["*.php"],
  html: ["*.html", "*.htm"], css: ["*.css", "*.scss", "*.sass", "*.less"],
  json: ["*.json"], yaml: ["*.yaml", "*.yml"], toml: ["*.toml"], xml: ["*.xml"],
  md: ["*.md", "*.markdown"], sh: ["*.sh", "*.bash", "*.zsh"], sql: ["*.sql"],
  swift: ["*.swift"], kotlin: ["*.kt", "*.kts"], lua: ["*.lua"], config: ["*.cfg", "*.conf", "*.config", "*.ini"],
};

// Parse the ripgrep argv subset the Glob and Grep tools use.
export function parseRgArgs(args) {
  const globs = [], positionals = [], patterns = [], types = [];
  let files = false, sortModified = false;
  let filesWithMatches = false, count = false, lineNumbers = false;
  let ignoreCase = false, multiline = false;
  let before = 0, after = 0, maxColumns = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string") continue;
    if (a === "--files") files = true;
    else if (a === "--glob" || a === "-g" || a === "--iglob") globs.push(args[++i]);
    else if (a.startsWith("--glob=")) globs.push(a.slice(7));
    else if (a.startsWith("-g=")) globs.push(a.slice(3));
    else if (a === "--type" || a === "-t") types.push(args[++i]);
    else if (a.startsWith("--type=")) types.push(a.slice(7));
    else if (a === "-e" || a === "--regexp") patterns.push(args[++i]);
    else if (a.startsWith("-e=") ) patterns.push(a.slice(3));
    else if (a === "-l" || a === "--files-with-matches") filesWithMatches = true;
    else if (a === "-c" || a === "--count" || a === "--count-matches") count = true;
    else if (a === "-n" || a === "--line-number") lineNumbers = true;
    else if (a === "-N" || a === "--no-line-number") lineNumbers = false;
    else if (a === "-i" || a === "--ignore-case") ignoreCase = true;
    else if (a === "-U" || a === "--multiline") multiline = true;
    else if (a === "--multiline-dotall") { /* implied by our multiline */ }
    else if (a === "-A" || a === "--after-context") after = parseInt(args[++i], 10) || 0;
    else if (a === "-B" || a === "--before-context") before = parseInt(args[++i], 10) || 0;
    else if (a === "-C" || a === "--context") { before = after = parseInt(args[++i], 10) || 0; }
    else if (a.startsWith("-A")) after = parseInt(a.slice(2), 10) || 0;
    else if (a.startsWith("-B")) before = parseInt(a.slice(2), 10) || 0;
    else if (a.startsWith("-C")) { before = after = parseInt(a.slice(2), 10) || 0; }
    else if (a === "--max-columns" || a === "-M") maxColumns = parseInt(args[++i], 10) || 0;
    else if (a === "--sort" || a === "--sortr") { if (args[i + 1] === "modified") sortModified = true; i++; }
    else if (a === "--sort=modified" || a === "--sortr=modified") sortModified = true;
    else if (a === "-j" || a === "--threads" || a === "--max-count" || a === "-m" || a === "--color" || a === "--colors") i++;
    else if (a === "--") { for (let k = i + 1; k < args.length; k++) if (typeof args[k] === "string") positionals.push(args[k]); break; }
    else if (a[0] === "-") { /* ignore other flags (--hidden, --no-ignore, --multiline-dotall, ...) */ }
    else positionals.push(a);
  }
  return { files, globs, types, sortModified, positionals, patterns,
           filesWithMatches, count, lineNumbers, ignoreCase, multiline, before, after, maxColumns };
}

// Build include/exclude matcher lists from --glob and --type args.
function _buildMatchers(globs, types) {
  const includes = [], excludes = [];
  for (const g of globs) {
    if (g == null) continue;
    const m = buildMatcher(g);
    (m.negated ? excludes : includes).push(m);
  }
  // --type adds include globs (basename extension patterns).
  for (const t of types) {
    const pats = RG_TYPES[String(t).toLowerCase()];
    if (pats) for (const p of pats) includes.push(buildMatcher(p));
  }
  return { includes, excludes };
}

// Compile a ripgrep (Rust-regex) pattern to a JS RegExp. Most patterns are
// portable; on a syntax JS rejects, fall back to a literal (escaped) search so
// Grep degrades to substring matching instead of throwing.
function _compile(pattern, ignoreCase, multiline) {
  let flags = "g";
  if (ignoreCase) flags += "i";
  if (multiline) flags += "s";                 // -U/--multiline-dotall: . spans newlines
  // strip a leading Rust inline (?i) flag if present (JS supports (?i:) only in newer engines)
  let p = pattern;
  const inlineI = /^\(\?i\)/.exec(p);
  if (inlineI) { p = p.slice(4); if (!ignoreCase) flags += "i"; }
  try { return new RegExp(p, flags); }
  catch {
    const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { return new RegExp(esc, flags); } catch { return null; }
  }
}

// Collect the files ripgrep would search under `root` (honours include/exclude
// globs and prunes excluded dirs). Returns [{ printed, abs, mt }].
function _collectFiles(root, includes, excludes, fs, wantMtime) {
  const base = (root === "." || root === "") ? "" : root + "/";
  const out = [];
  const walk = (rel) => {
    const abs = rel ? root + "/" + rel : root;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const name = d.name;
      if (name === "." || name === "..") continue;
      const childRel = rel ? rel + "/" + name : name;
      const printed = base + childRel;
      let isDir = false;
      try { isDir = d.isDirectory(); } catch {}
      if (isDir) {
        if (_dirExcluded(printed, excludes)) continue;
        walk(childRel);
      } else {
        if (_excluded(printed, excludes)) continue;
        if (!(includes.length === 0 || includes.some((m) => m.re.test(printed)))) continue;
        let mt = 0;
        if (wantMtime) { try { mt = fs.statSync(abs + "/" + name).mtimeMs || 0; } catch {} }
        out.push({ printed, abs: abs + "/" + name, mt });
      }
    }
  };
  walk("");
  return out;
}

// Determine the search root (last positional) and, for content mode, the pattern.
function _rootAndPattern(p) {
  const pos = p.positionals.slice();
  let pattern = null;
  if (!p.files) {
    if (p.patterns.length) pattern = p.patterns[0];
    else if (pos.length) pattern = pos.shift();        // first bare positional is the pattern
  }
  const root = pos.length ? pos[pos.length - 1] : null;
  return { pattern, root };
}

// Run `rg --files ...` (the Glob tool). Returns ripgrep's `<root>/<rel>` listing.
export function runRgFiles(args, cwd, fs) {
  const p = parseRgArgs(args);
  let { root } = _rootAndPattern(p);
  root = String(root != null ? root : (cwd != null ? cwd : ".")).replace(/\/+$/, "") || "/";
  const { includes, excludes } = _buildMatchers(p.globs, p.types);
  const files = _collectFiles(root, includes, excludes, fs, p.sortModified);
  if (p.sortModified) files.sort((a, b) => a.mt - b.mt);
  const lines = files.map((f) => f.printed);
  return lines.length ? lines.join("\n") + "\n" : "";
}

const NUL_RE = /\u0000/;

// Run a ripgrep content/count/files-with-matches search (the Grep tool).
export function runRgSearch(args, cwd, fs) {
  const p = parseRgArgs(args);
  let { pattern, root } = _rootAndPattern(p);
  root = String(root != null ? root : (cwd != null ? cwd : ".")).replace(/\/+$/, "") || "/";
  if (pattern == null) return "";
  const re = _compile(pattern, p.ignoreCase, p.multiline);
  if (!re) return "";
  p.hasContext = p.before > 0 || p.after > 0;
  const { includes, excludes } = _buildMatchers(p.globs, p.types);
  const files = _collectFiles(root, includes, excludes, fs, false);

  const out = [];
  const groups = [];      // for content mode: array of printed line blocks
  for (const f of files) {
    let text;
    try { text = String(fs.readFileSync(f.abs)); } catch { continue; }
    if (NUL_RE.test(text.slice(0, 8192))) continue;          // skip binary (ripgrep does)
    const lines = text.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();   // trailing newline

    if (p.multiline) {
      // match across the whole file; report the line where each match starts
      re.lastIndex = 0;
      const hitLines = new Set();
      let m;
      while ((m = re.exec(text)) !== null) {
        const ln = text.slice(0, m.index).split("\n").length;    // 1-based
        hitLines.add(ln);
        if (m.index === re.lastIndex) re.lastIndex++;            // avoid zero-width loop
      }
      _emitFile(f.printed, lines, [...hitLines].sort((a, b) => a - b), p, out, groups);
      continue;
    }

    const matchLines = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) matchLines.push(i + 1);            // 1-based
    }
    if (!matchLines.length) continue;
    _emitFile(f.printed, lines, matchLines, p, out, groups);
  }

  if (p.filesWithMatches || p.count) return out.length ? out.join("\n") + "\n" : "";
  // content mode: groups joined by `--` when context is enabled
  if (!groups.length) return "";
  return groups.join(p.hasContext ? "\n--\n" : "\n") + "\n";
}

// Emit one file's results into `out` (files/count) or `groups` (content).
function _emitFile(printed, lines, matchLines, p, out, groups) {
  if (p.filesWithMatches) { out.push(printed); return; }
  if (p.count) { out.push(printed + ":" + matchLines.length); return; }
  // content mode
  const matchSet = new Set(matchLines);
  // build merged intervals [lineStart,lineEnd] (1-based, clamped)
  const intervals = [];
  for (const ml of matchLines) {
    const s = Math.max(1, ml - p.before), e = Math.min(lines.length, ml + p.after);
    if (intervals.length && s <= intervals[intervals.length - 1][1] + 1) {
      intervals[intervals.length - 1][1] = Math.max(intervals[intervals.length - 1][1], e);
    } else intervals.push([s, e]);
  }
  for (const [s, e] of intervals) {
    const block = [];
    for (let ln = s; ln <= e; ln++) {
      const isMatch = matchSet.has(ln);
      const sep = isMatch ? ":" : "-";
      const prefix = p.lineNumbers ? (printed + sep + ln + sep) : (printed + sep);
      block.push(prefix + (lines[ln - 1] ?? ""));
    }
    groups.push(block.join("\n"));
  }
}

// Dispatch any ripgrep invocation. Returns { code, stdout }: exit 0 when there
// was output (matches/files), 1 when none — matching ripgrep, which cli.js's
// dd() reads as an empty result.
export function runRipgrep(args, cwd, fs) {
  const a = Array.isArray(args) ? args : [args];
  let stdout;
  if (a.includes("--files")) stdout = runRgFiles(a, cwd, fs);
  else stdout = runRgSearch(a, cwd, fs);
  return { code: stdout && stdout.length ? 0 : 1, stdout: stdout || "" };
}

// True if (file,args) is a ripgrep `--files` invocation we can serve.
export function isRgFiles(args) {
  const a = Array.isArray(args) ? args : [args];
  return a.includes("--files");
}

export default { globBodyToRe, buildMatcher, parseRgArgs, runRgFiles, runRgSearch, runRipgrep, isRgFiles };
