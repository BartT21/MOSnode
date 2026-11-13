MOSnode - Claude Code for MorphOS (PowerPC)
Made by Bart & Dave "skateman" Koelman. Ported with Claude Code.
https://github.com/BartT21/MOSnode

A Node.js-compatible runtime that runs Anthropic's Claude Code CLI natively on
MorphOS. No compiling needed - this archive is ready to run.

--------------------------------------------------------------------------------
INSTALL (2 steps)
--------------------------------------------------------------------------------

1. UNPACK this archive wherever you like - ANY volume works (a hard-drive
   partition, a RAM disk, even a USB stick). There is nothing special about
   Work:. You get a  MOSnode  drawer with mosnode, lib/, the claude launcher,
   etc. The launcher finds everything relative to its own drawer (PROGDIR:),
   so the volume does not matter.
   (The examples below use  Work:MOSnode  - substitute where you unpacked.)

2. RUN it. In a MorphOS Shell, cd into that drawer and run claude:

       cd Work:MOSnode
       execute claude

   The first run downloads Claude Code (cli.js, ~19 MB) straight from npm onto
   your MorphOS machine - no second computer needed - then compiles it to
   bytecode (one time, a few minutes) and starts Claude Code. Every run after
   that starts straight away.

Then type  /login  in Claude Code to sign in (opens your MorphOS web browser),
or set  ANTHROPIC_API_KEY  to use an API key instead.

Claude Code is Anthropic's software under its own license; MOSnode does not
include it. The first-run download fetches your own copy from Anthropic's
official npm registry (the same package "npm pack @anthropic-ai/claude-code"
gets). If the machine has no internet, you can instead copy cli.js in by hand:
on any PC with Node.js run  npm pack @anthropic-ai/claude-code@2.1.112  and
tar xzf it, then copy  package/cli.js  into the MOSnode drawer (next to
mosnode) before step 2.

--------------------------------------------------------------------------------
NOTES
--------------------------------------------------------------------------------

- Bash tool: for Claude's Bash tool you also need a MorphOS (ixemul) ksh at
  bin/ksh inside the MOSnode drawer (from the free MorphOS SDK). Everything
  else - the chat, Read, Edit, Glob, Grep - works without it.

- Everything stays inside the MOSnode drawer. The launcher only ADDs a LIBS: search
  path (gone after reboot) and sets session-only environment variables; it does
  not touch any system files.

- Models: this build is Claude Code 2.1.112, which works with claude-haiku-5-5
  and claude-sonnet-5-5 (already wired into the launcher).

- The file .claude/CLAUDE.md tells Claude how this MorphOS environment works
  (how to launch apps, and not to modify its own runtime). Leave it in place.

Requires ixemul.library. MIT licensed.
