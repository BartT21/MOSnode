# mosnode → MorphOS port: feasibility findings & plan

## Status (2026-11-10)
- **x86-64 Kali build: WORKS.** The official Claude Code `cli.js` 2.1.112 runs on
  mosnode: `--version`, `--help` render; it makes real HTTPS requests to
  api.anthropic.com over verified TLS 1.3 (401 with a fake key, proving the full
  SDK→fetch→https→TLS→API path); clean process lifecycle.
- **MorphOS build: NOT STARTED.** This doc is the plan.

## Compiler decision: use MorphOS-native gcc, NOT vbcc
- vbcc (`toolchain/vbcc_morphos`) compiles simple PPC programs (hello.c → ELF32
  MSB PowerPC, runs in the VM) BUT **cannot compile QuickJS**: it is a C89/partial
  -C99 compiler and QuickJS-ng uses computed goto (3×), `typeof` (3×), statement
  exprs (3×), `_Atomic` (16×), `__attribute__`, NAN/INFINITY macros. Death by a
  thousand cuts; some (computed goto, _Atomic, typeof) are fundamental vbcc gaps.
- **`ppc-morphos-gcc-15`** (`morphos_sdk/gcc15/bin/`) is real GCC 15.2 — supports
  ALL of the above. It is a **PPC MorphOS binary** (ELF MSB PowerPC), so it only
  runs INSIDE the QEMU VM, not on the x86 host (confirmed: "exec format error").
- The SDK ships a **full POSIX layer** in `morphos_sdk/tree/Development/gg/include/`:
  sys/time.h, sys/socket.h, unistd.h, fcntl.h, termios.h, poll.h, netdb.h,
  sys/wait.h, signal.h, dirent.h, netinet/in.h, pthread.h — ALL present. So
  QuickJS and most of mosnode's native.c should compile with few changes; the
  POSIX emulation sits over bsdsocket.library / dos.library.

## ⛔ CURRENT BLOCKER (2026-11-10): no bulk host→guest file-transfer channel yet

Reconnaissance done this session (VM is booted & healthy, shell works):
- **Target disk in-guest:** `DH1` = **"Work", 7.0 GB SFS, essentially empty** —
  plenty of room for the 437 MB gcc15 toolchain + 848 MB gg tree + sources.
  `DH0` = "System", 1 GB SFS, 647 MB free.
- **The ext2 `shared.img` does NOT mount in the installed system.** `info` shows
  only DH0/DH1 (from install.img) — MorphOS doesn't even enumerate the index=1
  disk as a device. Root cause: `shared.img` is a **raw ext2 image with no RDB**
  (Rigid Disk Block) partition table, so MorphOS's auto-mount (which scans RDBs)
  never sees it. `mos put/get/ls` work purely HOST-side via `debugfs`; they do
  NOT require/trigger a guest mount.
- `run_morphos_dev.sh` (in ~/Projects/morphos_vm) boots the **LiveCD** with the
  shared disk at index=0 and the comment "ext2, mountable both sides / conservative
  feature set so MorphOS's Ext2FileSystem handler can read it"
  (`mke2fs -O ^resize_inode,^dir_index,^ext_attr,^has_journal -I 128 -L MOSSHARE`).
  Our current `run.sh` boots the **installed** system (install.img idx0 + shared
  idx1) — different config, no auto-mount of the shared disk.
- **`MorphOS/L/Ext2FileSystem` (44 KB) IS on the ISO** → almost certainly installed
  in `MOSSYS:L` on the system (an earlier "not found" was a mangled search pattern,
  not a real absence — `tablet.py text` drops `|` chars, so AmigaDOS `PAT (a|b)`
  alternations fail; avoid `|` in typed commands).
- SDK packs are **`.tar.xz`** (`gcc15.pack` 63 MB, `sdk.pack` 133 MB); the toolchain
  is already extracted host-side at `~/Projects/morphos_sdk/gcc15` (437 MB) and the
  POSIX layer at `~/Projects/morphos_sdk/tree/Development/gg` (848 MB, includes
  sys/socket.h, poll.h, pthread.h, …). `ppc-morphos-gcc-15` is a PPC MorphOS binary
  → runs ONLY inside the VM (can't cross-compile on x86; qemu-user can't run a
  MorphOS binary either — it's not Linux-PPC ABI).

### Mount experiments run 2026-11-10 (RDB-ext2 disk — ALL FAILED to auto-mount)
Built a correct RDB-wrapped ext2 disk host-side with `rdbtool` (amitools in
scratchpad venv `amienv`): RDB block-2, embedded `Ext2FileSystem` v0.51 via
`fsadd dostype=0x45585432`, partition `DEVKIT` via `addimg ... start=4` (verified
host-side: valid ext2, marker file readable). Then tested 4 attach methods, each
a full reboot via `vm/run_devkit.sh` (a `run.sh` variant) — **none produced a new
volume/device in `info`:**
- **IDE `index=2`** (2nd channel): MorphOS never enumerates it. Only the index=0
  master is seen. `info` unchanged.
- **IDE `index=1`** (ch0 slave): also never enumerated. So MorphOS on this QEMU
  `pegasos2` sees ONLY the index=0 master IDE disk (install.img).
- **USB mass storage** (`-device usb-storage`): QEMU DOES attach it
  (`info usb` → "Device 1.4 … QEMU USB MSD" on the bus), but MorphOS/Poseidon does
  NOT auto-mount it — no new volume, nothing in serial_dev.log. Tried twice:
  ext2 with `large_file` feature, then strict conservative ext2
  (`features: filetype sparse_super`, `-I 128 -b 1024`, matching run_morphos_dev.sh).
  Neither mounted.
- NOTE: `run_morphos_dev.sh` mounts its ext2 shared disk fine ONLY because there
  it is at **index=0** (LiveCD boot, shared disk is the sole IDE disk). Our
  installed-system boot needs install.img at index=0, so that trick doesn't help.

### Open leads for the mount (not yet tried)
- USB disk may be enumerated by Poseidon but not AUTO-mounted — check Poseidon
  `Trident` prefs / whether a `uscsi.device`-style unit exists that can be mounted
  manually (needs a clean in-guest shell + `info`/`mount`).
- The RDB's embedded-fs (custom dostype) may be skipped by Poseidon's lighter
  mounter; using a dostype the installed FileSystem.resource already maps to ext2
  (unknown value) without `fsadd` might auto-mount.
- **install.img RDB is valid & readable** (RDSK at block 2, 512 B blocks, part list
  at block 3) but `rdbtool` says "No RDB Disk" (parse quirk). Growing install.img
  and adding an ext2 partition to its RDB would put the payload on the index=0 disk
  MorphOS DOES see — but it edits the system disk (risky) and needs the rdbtool
  parse issue solved or hand-written RDB blocks.

### ✅ CHANNEL CHOSEN & CONFIRMED (2026-11-10): NETWORK (HTTP over slirp)
User chose network after the disk mounts failed. **Guest→host HTTP is CONFIRMED
WORKING:** host runs `python3 -m http.server 8099 --bind 0.0.0.0` (in
scratchpad/webroot); in the guest shell `openurl http://10.0.2.2:8099/test.txt`
launched Wayfarer 11.3 which **rendered the host file's contents**. Guest requests
appear in the host log as **`127.0.0.1`** (slirp NATs them), NOT 10.0.2.15 — so
monitor downloads by request COUNT/timestamp, not source IP. Networking is already
configured/persisted (DHCP at boot; Wayfarer needs lo0 but renders anyway).

**DOWNLOAD PIPELINE — FULLY CONFIRMED 2026-11-10:**
- `openurl http://10.0.2.2:8099/<file>` in the guest shell launches Wayfarer at
  that URL. Text renders inline; a binary pops a **"Download …? Save/Cancel"**
  dialog. Click **Save** (≈ x=827,y=339 when Wayfarer is at its default position)
  → file saves to **`SYS:Downloads/`** (no path picker). VERIFIED: downloaded
  `wget` (8050 kB) → `dir SYS:Downloads` shows `wget`. Host log records each fetch
  as `127.0.0.1` (slirp NAT) — watch it to confirm transfers screen-independently.
- GOTCHA: `tablet.py text` intermittently DROPS a char (e.g. `SYS:`→`YS:`, which
  pops a "Please insert volume YS" requester — Cancel it). Screenshot BEFORE
  pressing ret on important typed commands and re-type if mangled.
- `ixemul.library` is NOT on the system (`list LIBS: PAT ixemul#?` → empty), so it
  must be installed before wget can run.

### ✅✅ wget BOOTSTRAP PROVEN 2026-11-10 — SCRIPTABLE TRANSFER NOW WORKS
Completed the bootstrap end-to-end:
1. Downloaded `wget` → `SYS:Downloads/wget` and `ixemul.library` → `SYS:Downloads/`
   via Wayfarer (openurl + Save).
2. `copy sys:downloads/ixemul.library libs:` → ixemul.library now in `LIBS:`
   (226191 bytes). `protect sys:downloads/wget rwed` (exec bit).
3. **`sys:downloads/wget http://10.0.2.2:8099/test.txt` → WORKS.** wget output:
   "Connecting to 10.0.2.2:8099… HTTP request sent… Length: 27 [text/plain]…
   test.txt 100% … 7.96 KB/s". File saved to CWD (RAM:). Host log shows the GET.
- **⚠️ TYPING GOTCHA (critical for driving the guest):** `tablet.py text` drops
  shift-chord chars under TCG load, so UPPERCASE mangles (`SYS:`→`SS:`/`YS:` → pops
  an "insert volume" requester; Deny/Cancel it). **Use lowercase** for everything
  (AmigaDOS is case-insensitive) — `sys:downloads`, `libs:`, `copy`, `protect` all
  typed clean in lowercase. Screenshot before pressing ret on long commands.
- Pointer drift: requester buttons sometimes need 2 clicks; "Deny" at ~(1010,587)
  worked when "Cancel" at ~(1058,588) missed.

**EXACT NEXT STEPS (resume here — the channel is ready):**
1. Restart host server if needed: `cd` to `scratchpad/webroot`, run
   `python3 -m http.server 8099 --bind 0.0.0.0`. (wget + ixemul.library already
   in `SYS:Downloads/` + `LIBS:` on the guest — survives across reboots since
   they're on SFS, NOT RAM:.)
2. Host-side: stage the toolchain into webroot as a few `.tar` files (tar binary
   is in gg/bin, or MorphOS `C:` has its own) — e.g. `gcc15.tar`, `gg.tar`,
   `src.tar` (quickjs 4 .c + headers + mosnode src/lib). Keep each < ~200 MB if
   possible for resumability.
3. In guest (lowercase!): `cd work:` then
   `sys:downloads/wget http://10.0.2.2:8099/gcc15.tar` etc. (or write a script).
   Watch the host log to confirm each transfer.
4. Extract on `Work:` (`tar xf` via gg tar or C:), set up the gcc assigns/PATH,
   compile libqjs.a (4 files) + mosnode with `ppc-morphos-gcc-15` (first build
   TLS-stubbed via `MOS_NO_TLS`).
- Host HTTP server was running on :8099 from `scratchpad/webroot/` (test.txt,
  wget, ixemul.library). May need restart next session.

**wget-bootstrap plan (the efficient path — avoids GUI-per-file for 450 MB):**
- The toolchain ships PPC MorphOS binaries of `wget` (7.9 MB), `curl` (8.3 MB),
  `tar`, `gzip` at `~/Projects/morphos_sdk/tree/Development/gg/bin/` (ELF MSB PPC,
  MorphOS relocatable). `wget` needs `ixemul.library` (+ intuition, random which
  are system libs). `ixemul.library` is on the clean ISO (`morphos-3.20.iso`,
  `MorphOS/Libs/ixemul.library`) — extract with `7z`, serve it too.
- BOOTSTRAP: serve `wget` + `ixemul.library` over HTTP; get them into the guest
  via Wayfarer's download-to-disk (save to RAM: or Work:); put `ixemul.library`
  in `LIBS:` (or `SYS:MorphOS/Libs`); then run `wget` from the shell.
  ⚠️ OPEN: Wayfarer's save-to-disk flow for binaries (location/dialog) not yet
  tested — that's the first thing to nail next session. Fallback if Wayfarer
  can't save binaries cleanly: MorphOS `inet-handler` (L:) TCP: scripting, or
  find another download path.
- THEN: `wget http://10.0.2.2:8099/<archive>.tar` for everything (scriptable,
  fast, monitored via host log). Serve the toolchain as `.tar` (tar binary is in
  gg/bin) or raw files. Extract in-guest with `tar`.
- Build payload host-side: gcc15 (437 MB) + gg POSIX layer (lib 270M, include
  ~24M, ppc-morphos 70M) + quickjs 4 .c files + their .h + mosnode src/lib.
  Target the 7 GB DH1 "Work" disk.

### Earlier candidate channels (superseded by the confirmed network choice)
1. **RDB-wrapped ext2 disk (RECOMMENDED, fully host-side & scriptable).** Build a
   devkit disk that carries its own **RDB** + one ext2 partition so MorphOS
   auto-mounts it device-agnostically (same mechanism as DH0/DH1). Needs `amitools`
   (`pip install amitools` → `rdbtool`) and the correct ext2 **DosType** that routes
   to `Ext2FileSystem` (TBD — inspect the handler / MorphOS docs). Populate the ext2
   partition host-side with `mke2fs -d <stagedir>` (conservative flags, ~1.5 GB).
   Risk: getting DosType/FS-routing right; verify with one reboot.
2. **DOSDriver/mountlist for the raw ext2 disk.** A small text file typed directly
   into the guest (`copy CON: TO DEVS:DOSDrivers/SHARED`, no transfer needed) that
   names Device/Unit/FileSystem=L:Ext2FileSystem + geometry. Blocker: the exact IDE
   **device name + unit** for the index=1 disk on QEMU `pegasos2` (VIA VT8231 IDE)
   is unknown (not stored in the RDB; supplied by the controller driver). Would
   need empirical discovery in-guest.
3. **Network (proven working: Wayfarer renders live internet, DHCP 10.0.2.15,
   DNS 10.0.2.3).** Host serves archives over HTTP on 10.0.2.2; guest downloads.
   No standard CLI downloader in base MorphOS → download is **Wayfarer GUI**
   (driveable but screenshot-heavy, per large archive). Extract in-guest with
   **lha** (guaranteed) — so repack the toolchain as `.lha` host-side, not `.tar.xz`.

Whichever is chosen, the guest build then compiles **libqjs.a = 4 files only**
(quickjs.c, libregexp.c, libunicode.c, dtoa.c — no CMake needed) + mosnode src.

## Remaining work (in order)
1. **Establish the transfer channel** (above) and get gcc15 + gg POSIX layer + the
   quickjs-ng sources + mosnode/src + mosnode/lib into DH1 (Work:).
2. **Prove the toolchain runs in-guest:** compile a trivial `hello.c` with
   `ppc-morphos-gcc-15` before attempting QuickJS.
3. **Compile QuickJS + mosnode with gcc-15 inside the VM.** Expect slow TCG builds
   (QuickJS is 65k lines; likely 20-40 min each) and some MorphOS-specific fixups.
   De-risk with a first **TLS-stubbed** build (guard the OpenSSL seam in native.c,
   lines ~1672–1889, behind `MOS_NO_TLS`).
4. **TLS via AmiSSL.** mosnode links OpenSSL (`-lssl -lcrypto`) for the TLS backend
   seam (src/native.c, the `tlsConnect/Receive/Handshake/...` functions). On MorphOS
   this becomes AmiSSL (OpenSSL-API-compatible). Swap headers + link AmiSSL; the
   memory-BIO model and all of lib/tls.js are unchanged.
5. **Net backend:** POSIX sockets should map onto bsdsocket.library via the gcc
   POSIX layer; if not, implement the `be_*`/`js_net_*` seam against bsdsocket +
   swap poll()→WaitSelect() (the NET BACKEND SEAM section in src/native.c).
6. **Big-endian audit.** PPC is big-endian. QuickJS is endian-portable; audit
   mosnode's Buffer/typed-array/crypto paths (lib/buffer.js, lib/crypto.js).
7. **Run cli.js in the VM** and test with a real key / the mosrelay.py endpoint.

## Operational reality
Driving the VM is GUI-only (screenshot + simulated mouse/keyboard via tablet.py;
read output from screenshots). No SSH/terminal. This makes the build an iterative,
slow, screen-scraped process — realistically multiple focused sessions, not one.

## Runtime gaps still open on x86 (fix before/alongside MorphOS)
- 2026-11-10: **`cli.js -p` stall FIXED** (spawn self-pipe exec-error + path.resolve
  trailing-slash bugs — see project_mosclaude memory / HANDOFF.md). `-p` now runs
  bundled ripgrep, completes agent init, and POSTs /v1/messages (401 on dummy key).
- Happy-path message completion with a REAL key still unprinted (old key revoked —
  need a fresh Haiku-scoped key to see the final completion text). Full
  SDK→fetch→https→TLS→API path already proven to the auth gate.
- cli.js's config ENOENT reads are noisy but handled (optional files).
