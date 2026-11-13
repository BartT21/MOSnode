# mosnode / Claude Code on MorphOS — TODO

Goal: run the real, unmodified Claude Code `cli.js` (2.1.112, last JS version)
natively on MorphOS/PowerPC via mosnode (QuickJS + Node-compat layer).

## ✅ Done (the hard, uncertain engineering)
- Linux→MorphOS **cross-compiler** (`metaneutrons/morphos-cross`, GCC 15) — build the
  whole runtime on x86 in ~2 min (`build_morphos.sh`).
- **mosnode runs JavaScript on MorphOS/PPC** (QuickJS engine + ~54 Node polyfills).
- **TLS**: static OpenSSL bundled in → full HTTPS to api.anthropic.com
  (handshake → 401 → body → clean exit).
- **gcc-15 `-O2` PPC miscompile** of QuickJS found & fixed (build at `-O1`
  `-fno-strict-aliasing -fwrapv`).
- **Real `cli.js 2.1.112` loads & executes** (printed its version on MorphOS).
- **Bytecode fast-load** path: `mosnode --emit-bc out.qbc in.js` + `.qbc` loader
  (validated on x86; PPC one-time compile in progress).

## Milestone A — headless `claude -p` works
- [x] A1. `--emit-bc` writes `cli.qbc` on PPC (40MB bytecode) ✅
- [x] A2. `mosnode cli.qbc --version` loads FAST (seconds, printed 2.1.112) ✅
- [ ] A3. Install the `claude` command (`C:claude` wrapper + `MOSNODE_LIB=work:mos/lib`)
- [ ] A4. `claude -p "reply X"` with a key → a real completion on MorphOS
- [ ] A5. Verify **streaming (SSE)** responses, not just the one-shot 401

## Milestone B — core tools (a real coding agent)
- [ ] B1. File tools (Read/Write/Edit) edit a real file on MorphOS (fs works)
- [ ] B2. Bash tool via ixemul/GG `sh` + coreutils (wire + test CC's shell commands)
- [ ] B3. **Search (Grep/Glob)**: no PPC `ripgrep` (Rust). Provide a native/JS grep,
      or make CC fall back. — biggest tool blocker
- [ ] B4. Git: the MorphOS git port usable by CC's git commands

## Milestone C — interactive + auth
- [ ] C1. Interactive TUI (Ink/React) rendering in the Ambient Shell (raw TTY/ANSI)
- [ ] C2. `/login` via Wayfarer (subscription OAuth; paste-code or loopback callback)
- [ ] C3. Permissions / `--dangerously-skip-permissions` behavior

## Milestone D — distribution (don't ship cli.js!)
- [ ] D1. README + installer script (fetch cli.js from npm per-user, emit-bc, install `claude`)
- [ ] D2. Prebuilt PPC `mosnode` release binary (MIT; no Anthropic code)
- [ ] D3. "emit-bc on install" so users never wait per-launch

## Infra / speed
- [x] S1. Bytecode (eliminates the per-launch 13MB parse)
- [ ] S2. Test on real PowerPC hardware (Pegasos/PowerMac) — ~10–30× faster than TCG
- [ ] S3. Narrow which flag fixes the `-O2` miscompile (keep `-O2` speed if possible)
- [ ] S4. (cosmetic) `list_empty(gc_obj_list)` teardown assert on natural exit of
      object-heavy scripts — bypassed by `process.exit()` (which cli.js uses)
- [ ] S5. (cosmetic) report `morphos`/`ppc` instead of `linux`/`x64` in process

## Notes
- QuickJS bytecode is native-endian + build-specific → `cli.qbc` must be generated
  by the same PPC mosnode (can't precompile on x86).
- Biggest remaining unknowns: B3 (ripgrep/search) and C1 (TUI). The brain
  (runtime + API + cli.js loading) is done.
