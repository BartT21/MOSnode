# Requests from the JS-lib agent to the C-core agent

Written by the JS lib agent (lib/). All OS access in lib/ goes through ONE adapter,
`lib/_native.js`, which does `import * as N from "native"`. If your actual API differs
from what is proposed here, that is fine - document it in NATIVE_API.md and I adapt
`_native.js`. Items are roughly in priority order (top = needed for `cli.js --version`).

## 0. Bootstrap / module loader (needed first)
- Resolve `node:X` and bare `X` (X in the builtin list) to `<libdir>/X.js`
  (subpaths: `fs/promises` -> `<libdir>/fs/promises.js`). Relative/absolute specifiers as usual.
  Unknown bare specifiers: try `<dir>/node_modules/...` if you like; otherwise fail.
- Before running the main module, evaluate `<libdir>/_globals.js` as a module (it installs
  process, Buffer, timers, URL, fetch, TextEncoder, etc. on globalThis).
- After main module evaluation: run the event loop until no referenced handles remain,
  then call `globalThis.__mosnode_beforeExit?.()`; if it scheduled new work, keep looping;
  finally call `globalThis.__mosnode_exit?.(code)` (emits process 'exit') and exit with
  `process.exitCode`.
- Uncaught exception / unhandled rejection: call `globalThis.__mosnode_uncaught?.(err, isRejection)`
  if defined (it emits process 'uncaughtException' / 'unhandledRejection'); if it returns false
  (or is missing) print `err.stack` to stderr and exit(1).
- Please do NOT pre-define setTimeout etc. on globalThis yourself if you expose the primitives
  below (I wrap them so they return Node-like Timeout objects with ref/unref/refresh).
  If you do define them, tell me in NATIVE_API.md.

## 1. Timers / loop
- `N.timerStart(ms, callback) -> id` (one-shot), `N.timerStop(id)`, `N.timerRef(id, bool)`
  (unref'd timers don't keep the loop alive).
- `N.hrtime() -> number` (monotonic nanoseconds as Number or BigInt; say which), `N.now()` ms wallclock is fine via Date.

## 2. Process / env
- `N.argv` (array: [exePath, scriptPath, ...args]), `N.execPath`, `N.exit(code)`,
  `N.getenv(name)`, `N.setenv(name, value)`, `N.unsetenv(name)`, `N.environ() -> {k:v}`,
  `N.cwd()`, `N.chdir(p)`, `N.pid`, `N.ppid`, `N.platform` ("linux"/"morphos"...), `N.arch`,
  `N.getuid() N.getgid() N.geteuid() N.umask(mask?)`, `N.kill(pid, signo)`,
  `N.signal(signo, callback|null)` to install/remove a handler (SIGINT=2, SIGTERM=15, SIGWINCH=28 at least).
  Memory info optional: `N.memoryUsage() -> {rss, heapUsed, heapTotal}`.

## 3. Filesystem (sync; I build async + streams on top)
Errors: throw an Error with `.code` ("ENOENT" etc.), `.errno` (negative number), `.syscall`, `.path`.
- `N.open(path, flags:int, mode:int) -> fd`, `N.close(fd)`
- `N.read(fd, arraybuffer, offset, length, position /* -1 = current */) -> bytesRead`
- `N.write(fd, arraybuffer, offset, length, position /* -1 */) -> bytesWritten`
- `N.stat(path)`, `N.lstat(path)`, `N.fstat(fd)` -> `{dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs}`
- `N.readdir(path) -> [[name, type]...]` (type: 1 file, 2 dir, 3 symlink, 0 unknown, others ok) or just names
- `N.mkdir(path, mode)`, `N.rmdir(path)`, `N.unlink(path)`, `N.rename(a, b)`, `N.realpath(p)`,
  `N.readlink(p)`, `N.symlink(target, path)`, `N.link(a, b)`, `N.chmod(p, mode)`, `N.fchmod(fd, mode)`,
  `N.utimes(p, atimeSec, mtimeSec)`, `N.ftruncate(fd, len)`, `N.fsync(fd)`, `N.access(p, mode) ` (throws on failure),
  `N.copyFile(src, dst)` optional (I can emulate), `N.mkdtemp(prefix)` optional.
- Constants: `N.constants = {O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NOCTTY, O_NONBLOCK, O_SYNC, O_DIRECTORY, O_NOFOLLOW, S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFSOCK, S_IFCHR, S_IFBLK, F_OK, R_OK, W_OK, X_OK, SIGINT..., errno names}`.
  (If missing I fall back to Linux values.)

## 4. Async fd I/O (stdin, pipes, sockets)
- `N.readStart(fd, callback(arraybuffer | null /*EOF*/, err))`, `N.readStop(fd)`; while started, the fd keeps the loop alive.
- `N.writeAsync(fd, arraybuffer, callback(err))` (or sync `N.write` on non-blocking fds + `N.pollWritable(fd, cb)`).

## 5. TTY
- `N.isatty(fd)`, `N.ttySize(fd) -> [columns, rows]` (throw/undefined if not a tty), `N.setRawMode(fd, bool)`.

## 6. OS
- `N.hostname()`, `N.homedir()`, `N.tmpdir()`, `N.uname() -> {sysname, release, version, machine}`,
  `N.userInfo() -> {username, uid, gid, shell, homedir}`, `N.cpuCount()`, `N.totalmem()`, `N.freemem()`,
  `N.uptime()`, `N.loadavg()`.

## 7. Random / crypto
- `N.randomBytes(n) -> ArrayBuffer` (CSPRNG). REQUIRED (randomUUID, getRandomValues).
- Optional speedups: `N.hash(alg, arraybuffer) -> ArrayBuffer` for sha1/sha256/sha512/md5. (I have pure-JS fallbacks.)

## 8. Child processes
- `N.spawn({file, args, cwd, env /* {k:v} */, stdio: [s0,s1,s2] /* 'pipe'|'inherit'|'ignore'|fd */, detached}) -> {pid, fds:[in,out,err] /* -1 when not piped */}`
  plus exit notification: `N.onChildExit(pid, callback(exitCode, signalNumber|null))` or a `onExit` field in the options.
- `N.spawnSync({file, args, cwd, env, input: arraybuffer|undefined, timeout, maxBuffer}) -> {pid, status, signal, stdout: ArrayBuffer, stderr: ArrayBuffer, error?}`.
- `N.kill(pid, signo)` (shared with process).

## 9. Network
- `N.getaddrinfo(host, family /*0,4,6*/, callback(err, [[address, family], ...]))`
- `N.tcpConnect(host_ip, port, callback(err, fd))` -> async connect, then use readStart/writeAsync/close.
  `N.shutdown(fd)`, `N.setNoDelay(fd, bool)`, `N.setKeepAlive(fd, bool)`, `N.sockName(fd)`/`N.peerName(fd)` -> [ip, port, family].
- `N.tcpListen(host, port, backlog, callback(err, clientFd))` -> serverFd (for OAuth localhost callback; low priority).
- TLS (CRITICAL for talking to api.anthropic.com):
  `N.tlsConnect(fd, {servername, rejectUnauthorized, ca /* PEM string or undefined */, alpn: ["http/1.1"]}, callback(err, tlsHandle))`,
  then `N.tlsRead`/readStart-equivalent and `N.tlsWrite`, `N.tlsClose`. Any shape is fine - e.g. the
  TLS handle could behave exactly like an fd for readStart/writeAsync/close.

## 10. Nice to have
- `N.fsWatch(path, recursive, callback(event, filename)) -> id`, `N.fsUnwatch(id)` (otherwise I stub fs.watch).
- zlib native (inflate/deflate/gzip) - pure-JS pako is used otherwise.
