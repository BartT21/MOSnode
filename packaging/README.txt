MOSnode - Claude Code for MorphOS (PowerPC)
Made by Bart & Dave "skateman" Koelman. Ported with Claude Code.
https://github.com/BartT21/MOSnode

A Node.js-compatible runtime that runs Anthropic's Claude Code CLI natively on
MorphOS. No compiling needed - this archive is ready to run.

--------------------------------------------------------------------------------
INSTALL (3 steps)
--------------------------------------------------------------------------------

1. UNPACK this archive to  Work:mosnode
   (so you have Work:mosnode/mosnode, Work:mosnode/lib, etc.)

2. ADD Claude Code. It is Anthropic's software, so you supply your own copy
   (version 2.1.112). On any PC with Node.js:

       npm pack @anthropic-ai/claude-code@2.1.112
       tar xzf anthropic-ai-claude-code-2.1.112.tgz

   Copy  package/cli.js  to  Work:mosnode/cli.js

3. RUN it. In a MorphOS Shell:

       cd Work:mosnode
       execute claude

   The first run compiles cli.js to bytecode (one time, a few minutes), then
   starts Claude Code. Every run after that starts straight away.

Then type  /login  in Claude Code to sign in (opens your MorphOS web browser),
or set  ANTHROPIC_API_KEY  to use an API key instead.

--------------------------------------------------------------------------------
NOTES
--------------------------------------------------------------------------------

- Bash tool: for Claude's Bash tool you also need a MorphOS (ixemul) ksh at
  Work:mosnode/bin/ksh (from the free MorphOS SDK). Everything else - the chat,
  Read, Edit, Glob, Grep - works without it.

- Everything stays inside Work:mosnode. The launcher only ADDs a LIBS: search
  path (gone after reboot) and sets session-only environment variables; it does
  not touch any system files.

- Models: this build is Claude Code 2.1.112, which works with claude-haiku-5-5
  and claude-sonnet-5-5 (already wired into the launcher).

- The file .claude/CLAUDE.md tells Claude how this MorphOS environment works
  (how to launch apps, and not to modify its own runtime). Leave it in place.

Requires ixemul.library. MIT licensed.
