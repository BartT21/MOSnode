# MOSnode

**A Node.js-compatible JavaScript runtime for MorphOS (PowerPC) that runs the real Claude Code CLI natively.**

Made by **Bart** & **Dave "skateman" Koelman** · Ported with **[Claude Code](https://claude.com/claude-code)**

Claude Code for MorphOS · Claude Code on MorphOS · Claude Code harness on MorphOS · Claude Code on PowerPC

> **Download:** get the ready-to-run **[`.lha` release](https://github.com/BartT21/MOSnode/releases/latest)**
> for MorphOS (runtime + `lib/` + launch script), or build from source — see
> **[Install on MorphOS](#install-on-morphos)**. You supply your own copy of
> Claude Code's `cli.js` either way.

---

MOSnode is a small JavaScript runtime for [MorphOS](https://www.morphos-team.net/), the
Amiga-like operating system for PowerPC computers. It provides enough of the Node.js API
for Anthropic's **Claude Code** (`cli.js`, the AI coding agent for the terminal) to run
unmodified on MorphOS: the full interactive terminal UI, one-shot `claude -p` prompts,
and the Bash tool running commands on the MorphOS machine itself.

## How it works

```
 cli.js            Claude Code 2.1.112, unmodified (you supply it, see below)
   │  require("fs"), "https", "child_process", "stream", ...
 lib/              Node.js API written in JavaScript
   │  fs, path, os, process, events, streams, buffer, net, tls, http/https,
   │  fetch, child_process, crypto, zlib, url, WebAssembly, tty/stdio, ...
   │  calls into the built-in "native" module
 src/              C core: QuickJS-ng engine + event loop + native bindings
   │  POSIX through ixemul.library, sockets through bsdsocket,
   │  statically linked OpenSSL for TLS, AmigaDOS for launching programs
 MorphOS (PowerPC, big-endian)
```

- **JavaScript engine:** [QuickJS-ng](https://github.com/quickjs-ng/quickjs) with a small
  patch (`patches/`). `cli.js` is 13 MB, which is slow to parse on PowerPC, so MOSnode can
  compile it once to QuickJS bytecode (`.qbc`). After that it starts quickly.
- **Node.js API layer (`lib/`):** each Node core module is reimplemented in JavaScript on
  top of a small native API (see `NATIVE_API.md`). Pure-JS pieces such as Buffer, streams,
  URL, web streams, hashes and zlib come from MIT/BSD npm packages, bundled into
  `lib/_vendor/` by `tools/build-vendor.mjs`.
- **WebAssembly:** Claude Code ships small WebAssembly modules (the llhttp HTTP parser and
  the Yoga layout engine used by its terminal UI). MOSnode runs them through
  [wasm3](https://github.com/wasm3/wasm3), an interpreter that works on big-endian PowerPC.
- **Networking and TLS:** sockets go through MorphOS's bsdsocket stack (IPv4). OpenSSL is
  statically linked, so no AmiSSL or extra library is needed for HTTPS.
- **Processes:** MorphOS has no `fork()`. Commands from Claude Code's Bash tool run through
  `ksh` (ixemul), and plain AmigaDOS programs run through `System()`. GUI programs started
  with `&` are launched detached so they open on the Ambient desktop.
- **Terminal:** the MorphOS console uses Latin-1 and supports only part of xterm. MOSnode
  adapts Claude Code's output (character set, unsupported escape sequences) so the
  terminal UI renders correctly.

## Why Claude Code 2.1.112?

2.1.112 is the **last Claude Code release published as JavaScript** (`cli.js`). Later
versions are native x86-64/ARM binaries, which can't run on PowerPC. MOSnode is pinned to
2.1.112 for that reason.

**MOSnode does not include Claude Code.** Claude Code is Anthropic's software under its
own license. Download your own copy of `cli.js` from npm (see below).

## Status

Working on real hardware:

- Interactive Claude Code terminal UI: onboarding, `/login`, chat, slash commands
- `claude -p "..."` one-shot prompts
- HTTPS to the Claude API with streaming responses
- Bash tool (via ksh), including compiling and running programs on MorphOS
- Launching MorphOS GUI apps from Claude Code

Known limitations:

- **Models:** Sonnet 5.5 and Haiku 5.5 work. Opus 5.5 and Fable 5.2 need a newer Claude
  Code version than 2.1.112, so the API rejects them.
- **Extended thinking is off** (`MAX_THINKING_TOKENS=0`). 2.1.112 sends an older thinking
  parameter that current models reject.
- **Search:** Claude Code's Grep tool uses ripgrep, which has no MorphOS build. Claude
  falls back to `grep`/`find` through the Bash tool.
- Networking is IPv4 only.

## Install on MorphOS

Download the latest [`.lha` release](https://github.com/BartT21/MOSnode/releases/latest).
It is ready to run — no compiling. Three steps:

### 1. Unpack

Unpack the archive to `Work:mosnode` (double-click it, or `lha x MOSnode-*.lha`). You
get `Work:mosnode/` with `mosnode`, `lib/`, the `claude` launcher, `README.txt`,
`LICENSE` and a `.claude/` folder.

### 2. Add Claude Code

Claude Code is Anthropic's software and is **not included** — you supply your own copy
(version 2.1.112). On any computer with Node.js:

```sh
npm pack @anthropic-ai/claude-code@2.1.112
tar xzf anthropic-ai-claude-code-2.1.112.tgz
# copy package/cli.js to Work:mosnode/cli.js
```

### 3. Run

In a MorphOS Shell:

```
cd Work:mosnode
execute claude
```

The **first** run compiles `cli.js` to fast-start bytecode (one time, a few minutes),
then launches Claude Code. Every run after that starts straight away. Then type
`/login` to sign in (opens your MorphOS web browser — set `MOSNODE_BROWSER` to choose
it), or set `ANTHROPIC_API_KEY` to use an API key.

**For Claude's Bash tool** you also need a MorphOS (ixemul) `ksh` at
`Work:mosnode/bin/ksh` (from the free MorphOS SDK). Everything else — the chat, Read,
Edit, Glob, Grep — works without it.

Everything stays inside `Work:mosnode`: the launcher only ADDs a `LIBS:` search path
(gone after reboot) and sets session-only environment variables — it never touches
system files.

## Configuration

| Variable | Meaning |
|---|---|
| `MOSNODE_LIB` | Path to the `lib/` folder |
| `MOSNODE_HOME` | Home folder for Claude Code's settings and session data |
| `MOSNODE_KSH` | Path to the `ksh` binary used for shell commands |
| `MOSNODE_BROWSER` | Program used to open URLs (for `/login`) |
| `MOSNODE_DEBUG` | Enable debug logging |
| `IXPPCSTACK` | ixemul stack size. Use 16 MB (`16777216`); QuickJS needs a large stack |

## Building (optional — for developers)

Most people just use the `.lha` release above and never build anything. Build from
source only if you want to change the runtime. MOSnode is cross-compiled on Linux
x86-64.

Requirements:

- The [metaneutrons/morphos-cross](https://github.com/metaneutrons/morphos-cross) GCC 15
  toolchain, installed at `~/.morphos-cross/current` with the MorphOS SDK
- QuickJS-ng next to this repo, at the pinned commit with the patch applied:

```sh
git clone https://github.com/quickjs-ng/quickjs.git ../quickjs-ng
git -C ../quickjs-ng checkout 71e6367f050b42f25d8e5849425070c322705d63
git -C ../quickjs-ng apply ../MOSnode/patches/quickjs-ng.patch
./build_morphos.sh        # → build-morphos/mosnode_s (stripped) and build-morphos/mosnode
```

The build uses `-O1 -fno-strict-aliasing -fwrapv` on purpose: GCC 15 at `-O2` miscompiles
QuickJS on PowerPC.

To make a runnable MorphOS install from a source build, assemble a folder like the
`.lha`: `build-morphos/mosnode_s` → `mosnode`, this repo's `lib/`, and
`packaging/claude` → `claude` (and `packaging/CLAUDE.md` → `.claude/CLAUDE.md`). Then
follow the install steps above from step 2.

For development, `make` builds a native Linux version (`build/mosnode`, needs OpenSSL
headers and `../quickjs-ng/build/libqjs.a`), which can run `cli.js` on Linux too.

## Repository layout

| Path | Contents |
|---|---|
| `src/` | C core: runtime, event loop, native bindings, wasm3 bridge, AmigaDOS helpers |
| `lib/` | Node.js API in JavaScript, plus bundled polyfills in `lib/_vendor/` |
| `vendor-src/` | wasm3 source and the npm packages that `lib/_vendor/` is built from |
| `tools/` | Build helpers (`build-vendor.mjs`, `cli.js` import analyzer) |
| `tests/` | Runtime tests |
| `patches/` | Patch applied to QuickJS-ng |
| `NATIVE_API.md` | The native API contract between `src/` and `lib/` |

## Credits

**Made by Bart & Dave Koelman.**

- **Dave "skateman" Koelman**
- **Bart** ([@BartT21](https://github.com/BartT21))
- **Ported with [Claude Code](https://claude.com/claude-code):** Claude Code, Anthropic's AI
  coding agent, wrote this port: the C runtime, the Node.js API layer and the MorphOS
  fixes. In other words, Claude Code ported itself to MorphOS.

Built on [QuickJS-ng](https://github.com/quickjs-ng/quickjs) (MIT),
[wasm3](https://github.com/wasm3/wasm3) (MIT), the npm packages listed in
`vendor-src/package.json` (MIT/ISC/BSD), and the
[morphos-cross](https://github.com/metaneutrons/morphos-cross) toolchain.

## License

MIT. See [LICENSE](LICENSE). Third-party code keeps its own license
(for example `vendor-src/wasm3/LICENSE`).

MOSnode is an independent project. It is not affiliated with or endorsed by Anthropic.
"Claude" and "Claude Code" are trademarks of Anthropic.
