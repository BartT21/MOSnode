# mosnode `native` module API

The C runtime exposes one built-in module, `native`:

```js
import * as N from "native";
```

Only `lib/` code should import it. Everything OS-specific lives behind
`src/plat.h` (see the end of this file), so this API stays the same on MorphOS.

## Conventions

- **Sync and async.** Every `fs*` function runs synchronously. When the **last
  argument is a function**, nothing is thrown. Instead the callback is called on a
  later loop turn as `cb(err, result)`, with `err === null` on success. Right now
  "async" fs work also runs synchronously; only the callback is deferred.
- **Errors** are real `Error` instances. Their message is in Node format:
  `"ENOENT: no such file or directory, open '/x'"`. Their properties are:
  `code` ("ENOENT"), `errno` (negative number, as in Node/libuv, e.g. -2),
  `syscall` ("open"), `path` (when there is one) and `dest` (rename, link, symlink,
  copyfile). Bad-argument errors are plain `TypeError`s.
- **Binary input.** Use any `ArrayBuffer`, TypedArray or DataView. Where noted, a
  string is also allowed and is UTF-8 encoded.
- **Binary output** is always a fresh `Uint8Array`. Call
  `N.setBufferPrototype(Buffer.prototype)` once. After that, every Uint8Array that
  native returns gets that prototype, so it is already a `Buffer` and needs no copy.
- **Handles** are small positive integers. They stand for timers, immediates,
  streams, servers, child processes and signal watchers. `N.close(h)` frees any
  handle. A ref'd active handle keeps the process alive. `N.ref(h)`, `N.unref(h)`
  and `N.hasRef(h)` work on every handle type.
- **Strings** (paths, env values and so on) are UTF-8 on the native side.

## Runtime / module system

| export | description |
|---|---|
| `argv` | `string[]`: `[execPath, scriptAbsPath, ...args]` (the same as `process.argv`) |
| `execArgv` | `string[]` (flags given to mosnode before the script) |
| `execPath` | absolute path of the mosnode binary |
| `libDir` | absolute path of the lib dir |
| `mainModule` | absolute path of the entry script (or of the .qbc file) |
| `versions` | `{mosnode, quickjs, openssl, zlib}` |
| `platform`, `arch` | `"linux"`, `"x64"` (the MorphOS build will report `"morphos"`, `"ppc"`) |
| `endianness` | `"LE"` / `"BE"` |
| `requireModule(spec, parentPath)` | Loads an ES module **synchronously** and returns its namespace object. `spec` is resolved like an `import`, so `node:fs`, `fs`, `./x.js` and absolute paths all work. Use this in `createRequire` for builtins: `ns.default ?? ns`. Throws if the module throws. A module that uses top-level await, or one that is mid-evaluation (a circular require), is returned as its namespace without waiting. |
| `resolveModule(spec, parentPath)` | Returns the canonical module name (an absolute path, `"native"`, or throws `ERR_MODULE_NOT_FOUND`). |
| `isBuiltin(name)` | `true` if `name` (with or without `node:`) maps to `lib/<name>.js` |
| `evalScript(src, filename)` | Runs `src` as a sloppy global script and returns the completion value. Use it for CJS wrappers: `N.evalScript("(function(exports,require,module,__filename,__dirname){"+src+"\n})", file)` |
| `setBufferPrototype(proto)` | See above. |
| `gc()` | Runs the GC. |

## Event loop

| export | description |
|---|---|
| `timerStart(ms, repeatMs, cb)` → `h` | `cb()` fires after `ms`. If `repeatMs > 0` it repeats every `repeatMs`. A one-shot timer frees itself after it fires. The timer starts ref'd. |
| `timerRestart(h, ms)` | Re-arms the timer (for `refresh()`). |
| `immediate(cb)` → `h` | Queues `cb` for the check phase (setImmediate). `close(h)` cancels it. |
| `close(h)` | Closes or cancels any handle. Calling it twice is a no-op. |
| `ref(h)`, `unref(h)`, `hasRef(h)` | |
| `runMicrotasks()` | Drains the pending promise jobs now. |
| `setRejectionHandler(fn)` | `fn("unhandled", promise, reason)` is called after microtasks drain, for rejections that are still unhandled. `fn("handled", promise)` is called when one gets handled later. |
| `setBeforeExitHandler(fn)` | Called when no ref'd handles are left. If `fn` creates new ref'd work, the loop keeps going. |
| `exit(code)` | Restores the tty and exits **now**. The JS side runs `process.on('exit')` first. |

Loop order: timers, then pending callbacks (deferred fs callbacks), then poll
(I/O, child exits, signals), then check (immediates). Microtasks drain after
every callback. The process exits when no ref'd handles or pending callbacks
remain and the beforeExit handler adds none. The exit code is `process.exitCode`
(the bootstrap passes it on).

## Process / env / os

`pid()`, `ppid()`, `cwd()`, `chdir(p)`, `getenv(k)` → string|undefined,
`setenv(k, v)`, `unsetenv(k)`, `environ()` → `{k: v}`, `hrtime()` → BigInt ns
(monotonic), `now()` → ms (double, monotonic, relative to process start, for
`performance.now`), `timeOrigin` (epoch ms double), `uptime()` → seconds,
`memoryUsage()` → `{rss, heapTotal, heapUsed, external, arrayBuffers}`,
`umask(mask?)` → old mask, `getuid()`, `geteuid()`, `getgid()`, `getegid()`,
`kill(pid, sig)` (sig is a name or a number), `onSignal(name, cb)` → `h`
(**unref'd** by default; `cb(name)`). Supported signals: SIGINT, SIGTERM,
SIGHUP, SIGWINCH, SIGUSR1, SIGUSR2, SIGQUIT, SIGCONT, SIGTSTP. SIGPIPE is
always ignored.

`hostname()`, `homedir()`, `tmpdir()`, `userInfo()` →
`{username, uid, gid, shell, homedir}`, `cpuCount()`, `cpuModel()`,
`totalmem()`, `freemem()`, `osType()` ("Linux"), `osRelease()`,
`osVersion()`, `machine()` ("x86_64"), `loadavg()` → `[a, b, c]`,
`osUptime()`, `networkInterfaces()` → `{}` (stub, for now).

`constants` → `{ errno: {E2BIG: 7, ...}, signals: {SIGINT: 2, ...}, fs: {O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND, O_NOFOLLOW, O_DIRECTORY, O_SYNC, O_NONBLOCK, S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFIFO, S_IFSOCK, S_IFCHR, S_IFBLK, F_OK, R_OK, W_OK, X_OK, COPYFILE_EXCL, UV_DIRENT_*...}, os: {...} }`.
The errno values are positive OS numbers. Error objects carry `errno = -value`.

## fs (all sync; trailing `cb` = async)

| export | returns |
|---|---|
| `fsOpen(path, flags, mode=0o666)` | fd. `flags` is a number or a Node string (`r r+ rs+ w wx w+ wx+ a ax a+ ax+ as as+`) |
| `fsClose(fd)` | undefined |
| `fsRead(fd, buf, off=0, len=buf.len-off, pos=-1)` | bytesRead (`pos` null/-1 = current position) |
| `fsWrite(fd, data, off, len, pos=-1)` | bytesWritten. If `data` is a string, `off`/`len` are ignored and the whole UTF-8 string is written. Writes to fds 1 and 2 retry on EAGAIN. |
| `fsStat(path)` / `fsLstat(path)` / `fsFstat(fd)` | `{dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs}` (numbers) |
| `fsReaddir(path, withTypes=false)` | `string[]`, or `[{name, type}]` where type is one of `"file" "dir" "link" "fifo" "socket" "char" "block" "unknown"` |
| `fsMkdir(path, mode=0o777, recursive=false)` | undefined, or (recursive) the first dir it created / undefined |
| `fsRmdir(path)` | |
| `fsRm(path, recursive=false, force=false)` | |
| `fsUnlink(path)`, `fsRename(old, new)`, `fsLink(existing, new)`, `fsSymlink(target, path)` | |
| `fsRealpath(path)`, `fsReadlink(path)` | string |
| `fsChmod(path, mode)`, `fsFchmod(fd, mode)`, `fsChown(path, uid, gid)` | |
| `fsUtimes(path, atimeSec, mtimeSec)`, `fsFutimes(fd, a, m)` | |
| `fsAccess(path, mode=F_OK)` | throws on failure |
| `fsExists(path)` | bool (never throws) |
| `fsReadFile(pathOrFd, encoding?)` | Uint8Array, or a string when encoding is `"utf8"`/`"utf-8"` |
| `fsWriteFile(pathOrFd, data, flags="w", mode=0o666)` | data: string or binary. Use flags "a" for append. |
| `fsCopyFile(src, dst, flags=0)` | |
| `fsTruncate(path, len)`, `fsFtruncate(fd, len)`, `fsFsync(fd)` | |
| `fsMkdtemp(prefix)` | path |

## Encoding helpers (fast paths for Buffer/TextDecoder)

`utf8Encode(str)` → Uint8Array; `utf8Decode(buf, start=0, end=len)` → string
(invalid sequences become U+FFFD); `utf8Length(str)`; `latin1Encode(str)`,
`latin1Decode(buf, s, e)`; `base64Encode(buf, urlSafe=false)` → string;
`base64Decode(str)` → Uint8Array (accepts both alphabets, ignores
whitespace/padding); `hexEncode(buf)`; `hexDecode(str)`.

## Streams (pipes, TCP, TLS, wrapped fds)

| export | description |
|---|---|
| `streamReadStart(h, cb)` | `cb(err, chunk)` is called repeatedly with Uint8Array chunks. `cb(null, null)` means EOF. |
| `streamReadStop(h)` | pauses reading |
| `streamWrite(h, data, cb?)` | data is binary or a string. It is queued, and `cb(err)` runs once it is fully written. Returns `true` if it was written out at once. |
| `streamShutdown(h, cb?)` | Half-closes (FIN, or closes the write end of a pipe) after the queued writes. |
| `streamQueued(h)` | number of bytes still queued |
| `openFdStream(fd)` | Wraps an existing fd (stdin, or a pipe passed in) as a stream handle. For fd < 3, `close()` does not close the fd. |
| `streamIsTTY(h)` | bool |

Streams start **ref'd** (lib/net should `unref` when Node would). A stream that
is not reading and has no queued writes does **not** keep the loop alive (the
libuv behaviour).

## Child processes

`spawn(opts, onExit)` → `{handle, pid, stdio: [h|null, h|null, h|null]}`

- `opts = {file, args, cwd, env, stdio, detached}`. `args` is the full argv,
  including argv[0]. `env` is an object or an array of `"K=V"`, and defaults to the
  current env. `stdio` has three entries, each `"pipe" | "inherit" | "ignore" | <fd number>`.
- `file` is looked up in the `PATH` of the **child** env when it has no `/`.
- The spawn fails synchronously (throws an errno error such as ENOENT or EACCES)
  when the program cannot be found or executed. The lib should emit `'error'` on
  the next tick, as Node does.
- `onExit(exitCode, signalName|null)` runs once the process has exited. The child
  handle keeps the loop alive while it runs. `close(handle)` stops watching it.
- The pipe handles are streams. Use `streamShutdown` or `close` on stdin to send EOF.

`spawnSync(opts)` → `{pid, status, signal, stdout, stderr, error}`

- Takes the same `opts`, plus `input` (string or binary), `timeout` (ms),
  `killSignal` (default "SIGTERM") and `maxBuffer` (default 1 MiB × 64).
- `stdout`/`stderr` are a Uint8Array, or null when not piped. `error` is an
  errno Error (ENOENT, ETIMEDOUT, ENOBUFS) or undefined.

`kill(pid, sig)`: sends a signal (also see process).

## Net

| export | description |
|---|---|
| `tcpConnect(host, port, cb)` → `h` | Resolves the host (DNS runs synchronously at call time) and connects without blocking. `cb(err, info)` runs on connect. `info = {localAddress, localPort, remoteAddress, remotePort, remoteFamily}`. `h` is a stream. |
| `tcpListen(host, port, backlog, onConn)` → `{handle, address, port, family}` | `onConn(err, clientHandle, info)`. `port` 0 = an ephemeral port. |
| `socketInfo(h)` | same shape as `info` |
| `setNoDelay(h, bool)`, `setKeepAlive(h, bool, delayMs)` | |
| `getaddrinfo(host, family=0, cb?)` | `[{address, family}]` (family is 4 or 6). Sync when there is no cb. |

## TLS (OpenSSL on Linux)

`tlsConnect(tcpHandle, opts, cb)` → `tlsHandle`

- `opts = {servername, rejectUnauthorized=true, alpn: ["h2", "http/1.1"], ca: "<PEM string>"|undefined}`.
- The TCP handle **must already be connected**, and the TLS handle takes it over:
  do not use `tcpHandle` afterwards.
- `cb(err, {alpnProtocol, protocol, cipher, authorized, authorizationError, peerCertificate: {subject, issuer, valid_from, valid_to, fingerprint256}})`.
- After the handshake, use the normal `stream*` functions on `tlsHandle`.
  The system CA bundle is used unless `ca` is given. Hostname verification
  follows `servername`.

## Crypto

`randomBytes(n)` → Uint8Array; `randomFill(buf, off=0, len)`;
`hash(alg, data)` → Uint8Array (one-shot); `hashCreate(alg)` → obj;
`hmacCreate(alg, key)` → obj; `hashUpdate(obj, data)`; `hashDigest(obj)` →
Uint8Array (the obj can't be used after this); `hashCopy(obj)` → obj;
`getHashes()` → `["md5", "sha1", "sha224", "sha256", "sha384", "sha512"]`;
`pbkdf2(password, salt, iterations, keylen, digest)` → Uint8Array.
The algorithm names are Node's (`"sha256"`, ...); unknown names throw a
TypeError with code `ERR_CRYPTO_INVALID_DIGEST`. (randomUUID belongs in JS.)

## zlib (zlib library)

`zlibCreate(mode, opts)` → obj, where mode is `"deflate" | "inflate" | "gzip" | "gunzip" | "deflateRaw" | "inflateRaw" | "unzip"`
and `opts = {level, windowBits, memLevel, strategy}`.

`zlibPush(obj, data|null, flush)` → Uint8Array of the output produced (it may be
empty). `flush` is `"none" | "sync" | "full" | "finish"`. A data error throws an
Error with `code` set to `"Z_DATA_ERROR"` (or another `Z_*` code) and `errno`.

`zlibEnded(obj)` → bool (the stream end was reached). `zlibClose(obj)`.

`zlibSync(mode, data, opts)` → Uint8Array (one-shot, flushes with finish).

Brotli is not available.

## TTY

`isatty(fd)`, `ttySetRawMode(fd, bool)`, `ttyGetWindowSize(fd)` → `[cols, rows]` or null.
For resize events, use `onSignal("SIGWINCH", cb)` and query the size again.
The tty mode is restored on exit.

## Bootstrap contract (owned by the runtime, `lib/_bootstrap.js`)

mosnode first evaluates `lib/_bootstrap.js`, which sets up these globals before
any other lib module or the entry script loads:

- `globalThis.global`, `globalThis.process`. The process object has argv, env (a
  Proxy over native env), cwd, chdir, exit, exitCode, pid, ppid, platform, arch,
  version ("v22.12.0"), versions, release, execPath, execArgv, hrtime(+bigint),
  memoryUsage, uptime, umask, kill, nextTick, emitWarning, and
  on/once/off/emit/listeners. The bootstrap later swaps its prototype to
  `EventEmitter.prototype` from `node:events` when that exists.
- `setTimeout/setInterval/setImmediate/clear*`. These return Timeout/Immediate
  objects with `ref/unref/hasRef/refresh/[Symbol.toPrimitive]`.
- `queueMicrotask` (built into QuickJS).
- Then, **if `lib/_globals.js` exists**, the bootstrap imports it. This is the lib
  agent's hook for installing Buffer, TextEncoder/Decoder, URL, URLSearchParams,
  console, fetch, Headers, AbortController, EventTarget, Event, structuredClone,
  atob/btoa, performance, etc. Without it, the bootstrap installs a minimal
  `console`.
- `process.stdin/stdout/stderr` are lazy getters. They import `lib/_stdio.js` (lib
  agent): `export function createStdio(fd)` → stream. Without it, a minimal
  writable `{write(s)}` is used.
- `lib/timers.js` (lib) should simply re-export `globalThis.setTimeout` and the rest.

## Module resolution (runtime)

- `node:X` and the bare builtin `X` both map to `lib/X.js` (and `fs/promises`
  maps to `lib/fs/promises.js`). Both names resolve to the same absolute file path,
  so there is exactly one instance of each.
- A bare name counts as a builtin if `lib/<name>.js` exists.
- `native` is the C module.
- Relative and absolute specifiers resolve against the importing module's file.
  Files under lib/ can import `./_util.js` and the like.
- Other bare specifiers: walk up `node_modules/<pkg>` (package.json `main`,
  `module` or `exports["."]`, else index.js). Failing that, throw `ERR_MODULE_NOT_FOUND`.
- `import.meta.url` is a `file://` URL, `import.meta.filename`/`dirname` are set,
  and `import.meta.main` is true for the entry module.
- `.json` files are loaded as modules with a default export.

## Platform layer (C)

`src/plat.h` is the only header that touches the OS. `src/plat_posix.c` is the
Linux/POSIX implementation. `src/plat_openssl.c` holds TLS and hashing (on
MorphOS, AmiSSL offers the same OpenSSL API). zlib is portable C.
