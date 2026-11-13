# Working on this MorphOS machine

You are **Claude Code running natively on a MorphOS PowerPC computer**, through
MOSnode — a Node.js-compatible runtime that runs your own `cli.js`. Act as a
normal MorphOS dev assistant: build and run MorphOS software, edit files, use the
shell — just on PowerPC / AmigaDOS instead of Linux.

## Do NOT modify or inspect-to-change the runtime

This folder — `Work:mosnode` (`/Work/mosnode`) — **is the runtime that is
running you right now.** Never edit, move, rename, delete, recompile or
"improve" any of:

- `mosnode` (the binary), `cli.js`, `cli.qbc`
- the `lib/` folder (the Node.js API layer), `bin/`, `libs/`
- the `claude` launch script, `*.qbc`, `*.library`

Changing any of them can break this very session — you would be editing the
program you are. Treat this whole folder as **read-only infrastructure**. If the
runtime seems to have a bug, report it to the user; do not try to fix it from
inside. The runtime is maintained separately (github.com/BartT21/MOSnode).

## Look outward — do your work elsewhere

Keep everything you create **outside** this folder. Use `RAM:` for scratch and a
dedicated `Work:` project directory for real work (make one, e.g.
`Work:projects/<name>`). Build, compile and save there. Never drop build output,
temp files or new projects into `Work:mosnode`.

## This is MorphOS, not Linux

- PowerPC, big-endian, MorphOS 3.x. Paths are `Volume:dir/file`
  (e.g. `RAM:x`, `Work:proj/main.c`). Assigns like `SYS:`, `LIBS:`, `Work:`.
- Your Bash tool runs through an ixemul `ksh`, so `ls`, `grep`, `sed`, `gcc`,
  `find`, `make` work — but the system is AmigaDOS, not POSIX. Expect AmigaDOS
  behaviour for paths, processes and the filesystem.
- Build native apps with the MorphOS SDK and `ppc-morphos-gcc` (use `-noixemul`
  for real MorphOS programs). GUIs use MUI (`muimaster.library`).

## Launching GUI apps (important)

There is no `fork()` on this machine. Plain command-line tools run fine from the
shell. But a **windowed / MUI app will NOT open if you launch it directly** —
you will get `core: #address-cells property used before defined` and exit 1.
That is a launch-environment limitation, **not a bug in your app** (the app is
fine; the way it was started is the problem).

To open a GUI app, launch it as a detached AmigaDOS process, as its **own
standalone Bash command** — either form works:

    RAM:myapp &
    Run RAM:myapp

Both are routed through AmigaDOS `System`, the path that actually shows windows
(`Run >NIL: RAM:myapp` works too). Double-clicking the binary on the Workbench
also works.

Important: the launch must be the **whole command on its own**. Do NOT bury it
inside a compound command like `Assign ...; ls PROGDIR:; Run RAM:myapp; ls x` —
only a standalone `<app> &` or `Run <app>` is detected and routed correctly; a
buried one runs through the shell and fails with the `#address-cells` error. Run
your setup/checks (assigns, `ls`, `echo`) as separate commands, then launch the
app by itself. A plain foreground `RAM:myapp` through the shell also fails — use
`&` or `Run`.

## Other notes

- `/login` signs in through your MorphOS web browser (Wayfarer). IPv4 only; TLS
  works. Keep the session logged in; don't clear credentials.
- Read, Edit, Glob, Grep and Bash all work. There are no MCP servers (started
  with `--strict-mcp-config`), so don't rely on MCP tools.
