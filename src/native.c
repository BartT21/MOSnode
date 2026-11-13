/* mosnode `native` module: all OS access. Linux/POSIX implementation. */
#include "mosnode.h"
#include <stdarg.h>
#include <termios.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <sys/utsname.h>
#include <poll.h>
#include <dirent.h>
#include <pwd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#ifndef MOS_NO_TLS
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/bio.h>
#include <openssl/x509v3.h>
#endif
#include <limits.h>

#ifdef __MORPHOS__
/* ---- MorphOS bsdsocket compat ---------------------------------------------
 * Classic bsdsocket.library is IPv4-only BSD sockets: no IPv6, no getaddrinfo,
 * no inet_pton/inet_ntop. Provide IPv4-only shims so the POSIX NET seam below
 * compiles and runs unchanged. IPv6 types are defined only so those branches
 * compile; inet_pton(AF_INET6) always returns 0, so they are never taken. */
/* fork() is hidden behind _KERNEL in the SDK's unistd.h, but ixemul provides it. */
extern pid_t fork(void);
#ifndef AF_INET6
#define AF_INET6 23
#endif
#ifndef INET6_ADDRSTRLEN
#define INET6_ADDRSTRLEN 46
#endif
struct in6_addr { unsigned char s6_addr[16]; };
struct sockaddr_in6 { unsigned char sin6_len, sin6_family; unsigned short sin6_port;
    unsigned int sin6_flowinfo; struct in6_addr sin6_addr; unsigned int sin6_scope_id; };
struct sockaddr_storage { unsigned char ss_len, ss_family; char __ss_pad[126]; };
struct addrinfo { int ai_flags, ai_family, ai_socktype, ai_protocol;
    socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname;
    struct addrinfo *ai_next; };
static int inet_pton(int af, const char *src, void *dst) {
    if (af == AF_INET) {
        uint32_t a = (uint32_t)inet_addr(src);
        if (a == (uint32_t)INADDR_NONE && strcmp(src, "255.255.255.255") != 0) return 0;
        memcpy(dst, &a, 4); return 1;
    }
    return 0; /* IPv6 unsupported on MorphOS */
}
static const char *inet_ntop(int af, const void *src, char *dst, socklen_t size) {
    if (af == AF_INET) {
        struct in_addr in; memcpy(&in, src, 4);
        char *s = inet_ntoa(in); if (!s) return NULL;
        strncpy(dst, s, size); if (size) dst[size - 1] = 0; return dst;
    }
    if (size) dst[0] = 0; return NULL;
}
static const char *gai_strerror(int e) { (void)e; return "name resolution failed"; }
static void freeaddrinfo(struct addrinfo *ai) {
    while (ai) { struct addrinfo *n = ai->ai_next; free(ai->ai_addr); free(ai); ai = n; }
}
static int getaddrinfo(const char *node, const char *service,
                       const struct addrinfo *hints, struct addrinfo **res) {
    (void)service; (void)hints;
    struct hostent *he = gethostbyname(node);
    if (!he || he->h_addrtype != AF_INET) return -1;
    struct addrinfo *head = NULL, **tail = &head;
    for (char **ap = he->h_addr_list; ap && *ap; ap++) {
        struct addrinfo *ai = calloc(1, sizeof *ai);
        struct sockaddr_in *sin = calloc(1, sizeof *sin);
        sin->sin_family = AF_INET;
        memcpy(&sin->sin_addr, *ap, (size_t)he->h_length);
        ai->ai_family = AF_INET; ai->ai_socktype = SOCK_STREAM;
        ai->ai_addrlen = sizeof *sin; ai->ai_addr = (struct sockaddr *)sin;
        *tail = ai; tail = &ai->ai_next;
    }
    if (!head) return -1;
    *res = head; return 0;
}
#endif /* __MORPHOS__ */

/* ================= tables & small helpers ================= */

static const struct { int num; const char *name; } errno_names[] = {
    {E2BIG,"E2BIG"},{EACCES,"EACCES"},{EADDRINUSE,"EADDRINUSE"},{EAGAIN,"EAGAIN"},
    {EBADF,"EBADF"},{EBUSY,"EBUSY"},{ECHILD,"ECHILD"},{EEXIST,"EEXIST"},
    {EFAULT,"EFAULT"},{EFBIG,"EFBIG"},{EINTR,"EINTR"},{EINVAL,"EINVAL"},
    {EIO,"EIO"},{EISDIR,"EISDIR"},{ELOOP,"ELOOP"},{EMFILE,"EMFILE"},
    {ENAMETOOLONG,"ENAMETOOLONG"},{ENFILE,"ENFILE"},{ENOBUFS,"ENOBUFS"},
    {ENODEV,"ENODEV"},{ENOENT,"ENOENT"},{ENOMEM,"ENOMEM"},{ENOSPC,"ENOSPC"},
    {ENOSYS,"ENOSYS"},{ENOTDIR,"ENOTDIR"},{ENOTEMPTY,"ENOTEMPTY"},{ENOTTY,"ENOTTY"},
    {ENXIO,"ENXIO"},{EPERM,"EPERM"},{EPIPE,"EPIPE"},{EROFS,"EROFS"},
    {ESPIPE,"ESPIPE"},{ESRCH,"ESRCH"},{ETIMEDOUT,"ETIMEDOUT"},{EXDEV,"EXDEV"},
    {0,NULL}
};
static const char *errno_name(int e) {
    for (int i = 0; errno_names[i].name; i++)
        if (errno_names[i].num == e) return errno_names[i].name;
    return "UNKNOWN";
}

static const struct { int num; const char *name; } signal_names[] = {
    {SIGHUP,"SIGHUP"},{SIGINT,"SIGINT"},{SIGQUIT,"SIGQUIT"},{SIGILL,"SIGILL"},
    {SIGABRT,"SIGABRT"},{SIGFPE,"SIGFPE"},{SIGKILL,"SIGKILL"},{SIGUSR1,"SIGUSR1"},
    {SIGUSR2,"SIGUSR2"},{SIGPIPE,"SIGPIPE"},{SIGALRM,"SIGALRM"},{SIGTERM,"SIGTERM"},
    {SIGCHLD,"SIGCHLD"},{SIGCONT,"SIGCONT"},{SIGSTOP,"SIGSTOP"},{SIGTSTP,"SIGTSTP"},
    {0,NULL}
};
static const char *sig_name(int s) {
    for (int i = 0; signal_names[i].name; i++)
        if (signal_names[i].num == s) return signal_names[i].name;
    return NULL;
}
static int sig_num(const char *s) {
    for (int i = 0; signal_names[i].name; i++)
        if (!strcmp(signal_names[i].name, s)) return signal_names[i].num;
    return -1;
}

JSValue js_type_error(JSContext *ctx, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    char buf[1024]; vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
    return JS_Throw(ctx, JS_NewTypeError(ctx, buf));
}

static JSValue js_errno_obj(JSContext *ctx, int errnum, const char *syscall,
                            const char *path, const char *dest) {
    const char *code = errno_name(errnum);
    char msg[2048];
    const char *strerr = strerror(errnum);
    if (path && dest) snprintf(msg, sizeof msg, "%s: %s, %s '%s' -> '%s'", code, strerr, syscall, path, dest);
    else if (path)    snprintf(msg, sizeof msg, "%s: %s, %s '%s'", code, strerr, syscall, path);
    else              snprintf(msg, sizeof msg, "%s: %s, %s", code, strerr, syscall);
    JSValue e = JS_NewError(ctx);
    JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, e, "code", JS_NewString(ctx, code), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, e, "errno", JS_NewInt32(ctx, -errnum), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, e, "syscall", JS_NewString(ctx, syscall), JS_PROP_C_W_E);
    if (path) JS_DefinePropertyValueStr(ctx, e, "path", JS_NewString(ctx, path), JS_PROP_C_W_E);
    if (dest) JS_DefinePropertyValueStr(ctx, e, "dest", JS_NewString(ctx, dest), JS_PROP_C_W_E);
    return e;
}

JSValue js_errno_error(JSContext *ctx, int errnum, const char *syscall,
                       const char *path, const char *dest) {
    return JS_Throw(ctx, js_errno_obj(ctx, errnum, syscall, path, dest));
}

static char *arg_str(JSContext *ctx, JSValueConst v, const char *what) {
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, v);
    if (!s) { js_type_error(ctx, "%s must be a string", what); return NULL; }
    char *r = strdup(s);
    JS_FreeCString(ctx, s);
    (void)len;
    return r;
}

/* Byte view of a value. TypedArray/ArrayBuffer/DataView: pointer into the
   buffer (borrowed, no free). String: malloc'd UTF-8 (caller frees). */
uint8_t *js_get_bytes(JSContext *ctx, size_t *plen, JSValueConst val, bool allow_string) {
    size_t size = 0;
    /* Probes below raise pending TypeErrors on mismatch; each failed probe
       must be cleared or it resurfaces at an unrelated later call. */
    uint8_t *p = NULL;
    if (!JS_IsString(val)) {
        p = JS_GetUint8Array(ctx, &size, val);
        if (!p) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
        if (!p && JS_IsArrayBuffer(val))
            p = JS_GetArrayBuffer(ctx, &size, val);
        if (!p && JS_GetTypedArrayType(val) >= 0) {
            size_t off2 = 0, len2 = 0;
            JSValue buf = JS_GetTypedArrayBuffer(ctx, val, &off2, &len2, NULL);
            if (!JS_IsException(buf)) {
                p = JS_GetArrayBuffer(ctx, &size, buf);
                JS_FreeValue(ctx, buf);
            } else {
                JS_FreeValue(ctx, buf);
                JSValue e = JS_GetException(ctx);
                JS_FreeValue(ctx, e);
            }
        }
    }
    if (p) { *plen = size; return p; }
    if (allow_string && (JS_IsString(val) || JS_IsNumber(val) || JS_VALUE_GET_TAG(val) <= 0)) {
        size_t len8;
        const char *str = JS_ToCStringLen(ctx, &len8, val);
        if (str) {
            uint8_t *r = malloc(len8 + 1);
            memcpy(r, str, len8 + 1);
            JS_FreeCString(ctx, str);
            *plen = len8;
            return r; /* caller frees */
        }
        JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e);
        return NULL;
    }
    js_type_error(ctx, "expected binary data");
    return NULL;
}

JSValue js_new_bytes(JSContext *ctx, const uint8_t *buf, size_t len) {
    JSValue v = JS_NewUint8ArrayCopy(ctx, buf, len);
    if (JS_IsException(v)) return v;
    if (!JS_IsUninitialized(rt.buffer_proto) && !JS_IsUndefined(rt.buffer_proto))
        JS_SetPrototype(ctx, v, rt.buffer_proto);
    return v;
}

void defer_call(JSContext *ctx, JSValue fn, JSValue a, JSValue b) {
    if (rt.deferred_count >= (int)(sizeof rt.deferred / sizeof rt.deferred[0])) {
        fprintf(stderr, "mosnode: deferred queue overflow\n");
        JS_FreeValue(ctx, fn); JS_FreeValue(ctx, a); JS_FreeValue(ctx, b);
        return;
    }
    JSValue arr = JS_NewArray(ctx);
    JS_DefinePropertyValueUint32(ctx, arr, 0, fn, JS_PROP_C_W_E);
    JS_DefinePropertyValueUint32(ctx, arr, 1, a, JS_PROP_C_W_E);
    JS_DefinePropertyValueUint32(ctx, arr, 2, b, JS_PROP_C_W_E);
    rt.deferred[rt.deferred_count++] = arr;
}

/* ================= handles ================= */

typedef enum { H_TIMER, H_IMMEDIATE, H_SIGNAL, H_PIPE, H_CHILD } HType;

typedef struct WriteReq {
    uint8_t *data; size_t len, off;
    JSValue cb; /* undefined or fn(err) */
    struct WriteReq *next;
} WriteReq;

struct Handle {
    int id;
    HType type;
    bool ref;
    bool closed;
    JSValue cb;
    struct Handle *next, *prev;
    struct Handle *grave_next; /* deferred free list */
    union {
        struct { int64_t at_ms, repeat_ms; } timer;
        struct { int signum; } sig;
        struct {
            int fd;
            bool reading, is_std, shutdown;
            bool connecting;    /* socket awaiting async connect() completion */
            bool listening;     /* server socket: watch POLLIN -> accept */
            JSValue connect_cb; /* fn(err) fired once when connect resolves */
            WriteReq *wq;
        } pipe;
        struct {
            pid_t pid;
            bool reaped, exit_reported;
            int exit_status; char signame[16];
            Handle *pipes[3];
        } child;
    } u;
};

/* Handles closed during a loop turn stay allocated until the turn ends:
   callbacks may close a handle the loop is still iterating over or about
   to touch (e.g. N.close(h) from inside a pipe read callback). */
static Handle *graveyard;
static void graveyard_reap(void) {
    while (graveyard) { Handle *n = graveyard->grave_next; free(graveyard); graveyard = n; }
}

static Handle *handle_new(HType t) {
    Handle *h = calloc(1, sizeof *h);
    h->id = ++rt.next_handle_id;
    h->type = t;
    h->ref = true;
    h->cb = JS_UNDEFINED;
    if (t == H_PIPE) h->u.pipe.connect_cb = JS_UNDEFINED;
    h->next = rt.handles;
    if (rt.handles) rt.handles->prev = h;
    rt.handles = h;
    return h;
}

static void handle_free(JSContext *ctx, Handle *h) {
    if (h->closed) return;
    h->closed = true;
if (h->type == H_PIPE) {
        if (h->u.pipe.fd >= 3) close(h->u.pipe.fd);
        JS_FreeValue(ctx, h->u.pipe.connect_cb);
        h->u.pipe.connect_cb = JS_UNDEFINED;
        WriteReq *w = h->u.pipe.wq;
        while (w) { WriteReq *n = w->next; free(w->data); JS_FreeValue(ctx, w->cb); free(w); w = n; }
    }
    if (h->type == H_CHILD && !h->u.child.reaped) {
        kill(h->u.child.pid, SIGKILL);
        waitpid(h->u.child.pid, NULL, 0);
    }
    JS_FreeValue(ctx, h->cb);
    h->cb = JS_UNDEFINED;
    if (h->type == H_PIPE) /* drop dangling refs from child handles */
        for (Handle *c = rt.handles; c; c = c->next)
            if (c->type == H_CHILD)
                for (int i = 0; i < 3; i++) if (c->u.child.pipes[i] == h) c->u.child.pipes[i] = NULL;
    if (h->prev) h->prev->next = h->next; else rt.handles = h->next;
    if (h->next) h->next->prev = h->prev;
    h->grave_next = graveyard;
    graveyard = h;
}

/* Explicitly close every open handle (sockets, pipes, children) at exit.
   MorphOS/ixemul does NOT reliably reclaim bsdsocket.library sockets on bare
   process exit, so without this each run leaks its sockets and, after a handful
   of runs, the box's socket pool is exhausted and the network stack wedges.
   Called from main before exit; closes fds without touching JS_FreeRuntime
   (which would assert on the retained gc_obj_list). */
void mos_close_all_handles(void) {
    if (!rt.ctx) return;
    Handle *h = rt.handles;
    while (h) { Handle *next = h->next; handle_free(rt.ctx, h); h = next; }
    graveyard_reap();
}

/* Diagnostic: dump every live handle (called at loop-drain to see why
   mos_loop_alive() returned false). */
void mos_dbg_dump_handles(void) {
    int n = 0;
    for (Handle *h = rt.handles; h; h = h->next) {
        n++;
        if (h->type == H_PIPE)
            mos_dbglog("  H[%d] PIPE ref=%d reading=%d wq=%d conn=%d listen=%d fd=%d is_std=%d closed=%d\n",
                h->id, h->ref, h->u.pipe.reading, h->u.pipe.wq ? 1 : 0, h->u.pipe.connecting,
                h->u.pipe.listening, h->u.pipe.fd, h->u.pipe.is_std, h->closed);
        else
            mos_dbglog("  H[%d] type=%d ref=%d closed=%d\n", h->id, h->type, h->ref, h->closed);
    }
    mos_dbglog("  (total %d handles live)\n", n);
}

static Handle *handle_from_int(JSContext *ctx, JSValueConst v) {
    int32_t id;
    if (JS_ToInt32(ctx, &id, v) < 0) return NULL;
    for (Handle *h = rt.handles; h; h = h->next)
        if (h->id == id && !h->closed) return h;
    js_type_error(ctx, "invalid handle %d", id);
    return NULL;
}

static int64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* microsecond monotonic clock, public (used by the main loop's rate limiter) */
int64_t mos_now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

/* Diagnostic log to Work:mosnode/mosdbg.log (relative = cwd). Enabled
   only when env MOSNODE_DEBUG is set, so normal runs pay nothing. */
void mos_dbglog(const char *fmt, ...) {
    static int on = -1;
    if (on < 0) on = getenv("MOSNODE_DEBUG") ? 1 : 0;
    if (!on) return;
    FILE *f = fopen("mosdbg.log", "a");
    if (!f) return;
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fclose(f);
}

/* ================= runtime / module system ================= */

static JSValue js_gc(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}

static JSValue js_exit(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int32_t code = 0;
    if (argc > 0) JS_ToInt32(ctx, &code, argv[0]);
    mos_dbglog("*** process.exit(%d) called ***\n", (int)code);
    rt.exit_code = code;
    rt.running = false;
    /* Node's process.exit() terminates immediately. Flush buffered output and
       restore the terminal, then exit — do not return to JS. */
    mos_flush_pending_writes();
    mos_tty_restore();
    mos_close_all_handles();   /* close sockets/pipes so ixemul doesn't leak them */
    fflush(NULL);
    exit(code);
}

static JSValue js_set_buffer_proto(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JS_FreeValue(ctx, rt.buffer_proto);
    rt.buffer_proto = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}

static JSValue js_set_rejection_handler(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JS_FreeValue(ctx, rt.rejection_handler);
    rt.rejection_handler = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}
static JSValue js_set_before_exit(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JS_FreeValue(ctx, rt.before_exit);
    rt.before_exit = JS_DupValue(ctx, argv[0]);
    return JS_UNDEFINED;
}
static JSValue js_run_microtasks(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &(JSContext *){ctx}) > 0) {}
    return JS_UNDEFINED;
}

static JSValue js_eval_script(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *src = JS_ToCString(ctx, argv[0]);
    if (!src) return JS_EXCEPTION;
    const char *fn = argc > 1 ? JS_ToCString(ctx, argv[1]) : "<eval>";
    JSValue v = JS_Eval(ctx, src, strlen(src), fn ? fn : "<eval>", JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(ctx, src);
    if (argc > 1 && fn) JS_FreeCString(ctx, fn);
    return v;
}

static JSValue js_require_module(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    char *spec = arg_str(ctx, argv[0], "spec");
    if (!spec) return JS_EXCEPTION;
    char *parent = argc > 1 ? arg_str(ctx, argv[1], "parentPath") : strdup("");
    if (!parent) { free(spec); return JS_EXCEPTION; }
    char *name = mos_normalize(ctx, parent, spec);
    free(spec); free(parent);
    if (!name) return JS_EXCEPTION; /* normalize threw ERR_MODULE_NOT_FOUND */
    /* Wrapper module: the registry caches by name, so the target is evaluated
       once; after jobs drain we pick the namespace off the global. */
    JSValue namestr = JS_NewString(ctx, name);
    free(name);
    const char *n = JS_ToCString(ctx, namestr);
    char src[4200];
    snprintf(src, sizeof src, "import * as __ns from \"%s\"; globalThis.__mosnode_ns = __ns;", n);
    JS_FreeCString(ctx, n);
    JS_FreeValue(ctx, namestr);
    JSValue ret = JS_Eval(ctx, src, strlen(src), "<require>", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(ret)) ret = JS_EvalFunction(ctx, ret);
    if (!JS_IsException(ret) && JS_IsPromise(ret))
        while (JS_PromiseState(ctx, ret) == JS_PROMISE_PENDING &&
               JS_ExecutePendingJob(JS_GetRuntime(ctx), &(JSContext *){ctx}) > 0) {}
    JS_FreeValue(ctx, ret);
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue ns = JS_GetPropertyStr(ctx, g, "__mosnode_ns");
    JS_SetPropertyStr(ctx, g, "__mosnode_ns", JS_UNDEFINED);
    JS_FreeValue(ctx, g);
    return ns;
}

static JSValue js_resolve_module(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    char *spec = arg_str(ctx, argv[0], "spec");
    if (!spec) return JS_EXCEPTION;
    char *parent = argc > 1 ? arg_str(ctx, argv[1], "parentPath") : strdup("");
    if (!parent) { free(spec); return JS_EXCEPTION; }
    char *name = mos_normalize(ctx, parent, spec);
    free(spec); free(parent);
    if (!name) return JS_EXCEPTION;
    JSValue r = JS_NewString(ctx, name);
    free(name);
    return r;
}

static bool builtin_exists(const char *name);
static JSValue js_is_builtin(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *n0 = JS_ToCString(ctx, argv[0]);
    if (!n0) return JS_EXCEPTION;
    const char *n = n0;
    if (!strncmp(n, "node:", 5)) n += 5;
    bool r = !strcmp(n, "native") || builtin_exists(n);
    JS_FreeCString(ctx, n0); /* must free the original pointer, not n0+5 */
    return JS_NewBool(ctx, r);
}

/* ================= env / process ================= */

static JSValue js_getenv(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *k = JS_ToCString(ctx, argv[0]);
    if (!k) return JS_EXCEPTION;
    const char *v = getenv(k);
    JS_FreeCString(ctx, k);
    return v ? JS_NewString(ctx, v) : JS_UNDEFINED;
}
static JSValue js_setenv(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *k = JS_ToCString(ctx, argv[0]);
    const char *v = JS_ToCString(ctx, argv[1]);
    if (!k || !v) { JS_FreeCString(ctx,k); JS_FreeCString(ctx,v); return JS_EXCEPTION; }
    setenv(k, v, 1);
    JS_FreeCString(ctx, k); JS_FreeCString(ctx, v);
    return JS_UNDEFINED;
}
static JSValue js_unsetenv(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *k = JS_ToCString(ctx, argv[0]);
    if (k) { unsetenv(k); JS_FreeCString(ctx, k); }
    return JS_UNDEFINED;
}
extern char **environ;
static JSValue js_environ(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JSValue o = JS_NewObject(ctx);
    for (char **e = environ; *e; e++) {
        char *eq = strchr(*e, '=');
        if (!eq) continue;
        char *k = strndup(*e, eq - *e);
        JS_DefinePropertyValueStr(ctx, o, k, JS_NewString(ctx, eq + 1), JS_PROP_C_W_E);
        free(k);
    }
    return o;
}
static JSValue js_hrtime(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JS_NewBigInt64(ctx, (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec);
}
static double time_origin_ms = -1;
static JSValue js_now(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    double t = (double)((int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
    if (time_origin_ms < 0) time_origin_ms = t;
    return JS_NewFloat64(ctx, t - time_origin_ms);
}
static struct timespec start_ts;
static JSValue js_uptime(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JS_NewFloat64(ctx, (double)(ts.tv_sec - start_ts.tv_sec) +
                         (double)(ts.tv_nsec - start_ts.tv_nsec) / 1e9);
}
static JSValue js_memory_usage(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &mu);
    JSValue o = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, o, "rss", JS_NewFloat64(ctx, mu.memory_used_size), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "heapTotal", JS_NewFloat64(ctx, mu.malloc_size), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "heapUsed", JS_NewFloat64(ctx, mu.memory_used_size), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "external", JS_NewFloat64(ctx, 0), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "arrayBuffers", JS_NewFloat64(ctx, 0), JS_PROP_C_W_E);
    return o;
}
static JSValue js_umask(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        int32_t m;
        if (JS_ToInt32(ctx, &m, argv[0]) < 0) return JS_EXCEPTION;
        return JS_NewInt32(ctx, umask(m & 0777));
    }
    mode_t old = umask(0); umask(old);
    return JS_NewInt32(ctx, old);
}
static JSValue js_kill(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int32_t pid; int sig = SIGTERM;
    if (JS_ToInt32(ctx, &pid, argv[0]) < 0) return JS_EXCEPTION;
    if (argc > 1 && JS_IsString(argv[1])) {
        const char *s = JS_ToCString(ctx, argv[1]);
        sig = sig_num(s); JS_FreeCString(ctx, s);
        if (sig < 0) return js_type_error(ctx, "unknown signal");
    } else if (argc > 1 && JS_ToInt32(ctx, &sig, argv[1]) < 0) return JS_EXCEPTION;
    if (kill(pid, sig) < 0) return js_errno_error(ctx, errno, "kill", NULL, NULL);
    return JS_UNDEFINED;
}

static void signal_tramp(int sig) {
    if (sig > 0 && sig < 64) rt.pending_signals[sig] = 1;
}
static JSValue js_on_signal(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s) return JS_EXCEPTION;
    int sig = sig_num(s);
    JS_FreeCString(ctx, s);
    if (sig < 0) return js_type_error(ctx, "unknown signal");
    Handle *h = handle_new(H_SIGNAL);
    h->u.sig.signum = sig;
    h->ref = false;
    h->cb = JS_DupValue(ctx, argv[1]);
    struct sigaction sa = {0};
    sa.sa_handler = signal_tramp;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    sigaction(sig, &sa, NULL);
    return JS_NewInt32(ctx, h->id);
}

/* ================= os info ================= */

static JSValue os_info_str(JSContext *ctx, int which) {
    struct utsname u;
    if (uname(&u) < 0) return JS_UNDEFINED;
    switch (which) {
    case 0: return JS_NewString(ctx, u.nodename);
    case 1: return JS_NewString(ctx, u.release);
    case 2: return JS_NewString(ctx, u.version);
    default: return JS_NewString(ctx, u.machine);
    }
}
static JSValue js_os_info(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int which = 0;
    if (argc > 0) JS_ToInt32(ctx, &which, argv[0]);
    return os_info_str(ctx, which);
}
static JSValue js_totalmem(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    return JS_NewFloat64(ctx, (double)sysconf(_SC_PHYS_PAGES) * sysconf(_SC_PAGESIZE));
}
static JSValue js_freemem(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    return JS_NewFloat64(ctx, (double)sysconf(_SC_AVPHYS_PAGES) * sysconf(_SC_PAGESIZE));
}
static JSValue js_cpu_count(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    return JS_NewInt32(ctx, sysconf(_SC_NPROCESSORS_ONLN));
}
static JSValue js_cpu_model(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (!f) return JS_NewString(ctx, "unknown");
    char line[256];
    while (fgets(line, sizeof line, f))
        if (!strncmp(line, "model name", 10)) {
            char *c = strchr(line, ':'), *nl;
            fclose(f);
            if (!c) break;
            c++; while (*c == ' ') c++;
            if ((nl = strchr(c, '\n'))) *nl = 0;
            return JS_NewString(ctx, c);
        }
    fclose(f);
    return JS_NewString(ctx, "unknown");
}
static JSValue js_homedir(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *h = getenv("HOME");
    return JS_NewString(ctx, h ? h : "/");
}
#ifdef __MORPHOS__
/* amigaRun(cmdline) -> SystemTags rc (0 = started, -1 = failed). Starts an
   AmigaDOS command asynchronously; see src/amiga_run.c. */
int mos_amiga_run(const char *cmd);
static JSValue js_amiga_run(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *cmd = JS_ToCString(ctx, argv[0]);
    if (!cmd) return JS_EXCEPTION;
    int rc = mos_amiga_run(cmd);
    JS_FreeCString(ctx, cmd);
    return JS_NewInt32(ctx, rc);
}
#endif
static JSValue js_tmpdir(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *t = getenv("TMPDIR");
    return JS_NewString(ctx, t ? t : "/tmp");
}
static JSValue js_user_info(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    struct passwd *pw = getpwuid(getuid());
    JSValue o = JS_NewObject(ctx);
    if (pw) {
        JS_DefinePropertyValueStr(ctx, o, "username", JS_NewString(ctx, pw->pw_name), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, o, "shell", JS_NewString(ctx, pw->pw_shell), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, o, "homedir", JS_NewString(ctx, pw->pw_dir), JS_PROP_C_W_E);
    }
    JS_DefinePropertyValueStr(ctx, o, "uid", JS_NewInt32(ctx, getuid()), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "gid", JS_NewInt32(ctx, getgid()), JS_PROP_C_W_E);
    return o;
}
static JSValue js_loadavg(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    double av[3] = {0, 0, 0};
    getloadavg(av, 3);
    JSValue a = JS_NewArray(ctx);
    for (int i = 0; i < 3; i++)
        JS_DefinePropertyValueUint32(ctx, a, i, JS_NewFloat64(ctx, av[i]), JS_PROP_C_W_E);
    return a;
}

/* ================= timers / immediates / handles ================= */

static JSValue js_timer_start(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    double ms; int64_t repeat = 0;
    if (JS_ToFloat64(ctx, &ms, argv[0]) < 0) return JS_EXCEPTION;
    if (argc > 1 && JS_ToInt64(ctx, &repeat, argv[1]) < 0) return JS_EXCEPTION;
    Handle *h = handle_new(H_TIMER);
    h->u.timer.at_ms = now_ms() + (ms < 0 ? 0 : (int64_t)ms);
    h->u.timer.repeat_ms = repeat;
    h->cb = JS_DupValue(ctx, argv[2]);
    return JS_NewInt32(ctx, h->id);
}
static JSValue js_timer_restart(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    if (h->type != H_TIMER) return js_type_error(ctx, "not a timer");
    double ms;
    if (JS_ToFloat64(ctx, &ms, argv[1]) < 0) return JS_EXCEPTION;
    h->u.timer.at_ms = now_ms() + (int64_t)ms;
    return JS_UNDEFINED;
}
static JSValue js_immediate(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_new(H_IMMEDIATE);
    h->cb = JS_DupValue(ctx, argv[0]);
    /* keep-alive on the global object: guards the callback against any
       premature release while the handle is pending */
    JSValue g = JS_GetGlobalObject(ctx);
    char prop[48];
    snprintf(prop, sizeof prop, "__mos_imm_%d", h->id);
    JS_SetPropertyStr(ctx, g, prop, JS_DupValue(ctx, h->cb));
    JS_FreeValue(ctx, g);
return JS_NewInt32(ctx, h->id);
}
static void clear_imm_keepalive(JSContext *ctx, int id) {
    JSValue g = JS_GetGlobalObject(ctx);
    char prop[48];
    snprintf(prop, sizeof prop, "__mos_imm_%d", id);
    JS_SetPropertyStr(ctx, g, prop, JS_UNDEFINED);
    JS_FreeValue(ctx, g);
}
static JSValue js_close_handle(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    if (h->type == H_IMMEDIATE) clear_imm_keepalive(ctx, h->id);
    handle_free(ctx, h);
    return JS_UNDEFINED;
}
static JSValue js_ref_handle(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    bool r = h->ref; h->ref = true;
    return JS_NewBool(ctx, r);
}
static JSValue js_unref_handle(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    bool r = h->ref; h->ref = false;
    return JS_NewBool(ctx, r);
}
static JSValue js_has_ref(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    return JS_NewBool(ctx, h->ref);
}

/* ================= fs ================= */

static int parse_flags(JSContext *ctx, JSValueConst v) {
    if (JS_IsUndefined(v)) return O_RDONLY;
    if (JS_IsNumber(v)) { uint32_t f = 0; JS_ToUint32(ctx, &f, v); return (int)f; }
    const char *s = JS_ToCString(ctx, v);
    if (!s) return -1;
    int f;
    if (!strcmp(s,"r")) f=O_RDONLY;
    else if (!strcmp(s,"r+")) f=O_RDWR;
    else if (!strcmp(s,"rs+")||!strcmp(s,"sr+")) f=O_RDWR|O_SYNC;
    else if (!strcmp(s,"w")) f=O_WRONLY|O_CREAT|O_TRUNC;
    else if (!strcmp(s,"wx")) f=O_WRONLY|O_CREAT|O_TRUNC|O_EXCL;
    else if (!strcmp(s,"w+")) f=O_RDWR|O_CREAT|O_TRUNC;
    else if (!strcmp(s,"wx+")) f=O_RDWR|O_CREAT|O_TRUNC|O_EXCL;
    else if (!strcmp(s,"a")) f=O_WRONLY|O_CREAT|O_APPEND;
    else if (!strcmp(s,"ax")) f=O_WRONLY|O_CREAT|O_APPEND|O_EXCL;
    else if (!strcmp(s,"a+")) f=O_RDWR|O_CREAT|O_APPEND;
    else if (!strcmp(s,"ax+")) f=O_RDWR|O_CREAT|O_APPEND|O_EXCL;
    else if (!strcmp(s,"as")||!strcmp(s,"sa")) f=O_WRONLY|O_CREAT|O_APPEND|O_SYNC;
    else if (!strcmp(s,"as+")||!strcmp(s,"sa+")) f=O_RDWR|O_CREAT|O_APPEND|O_SYNC;
    else { JS_FreeCString(ctx,s); js_type_error(ctx,"invalid flags"); return -1; }
    JS_FreeCString(ctx, s);
    return f;
}

static JSValue stat_to_obj(JSContext *ctx, struct stat *st) {
    JSValue o = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, o, "dev", JS_NewFloat64(ctx, st->st_dev), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "ino", JS_NewFloat64(ctx, st->st_ino), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "mode", JS_NewInt32(ctx, st->st_mode), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "nlink", JS_NewInt32(ctx, st->st_nlink), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "uid", JS_NewInt32(ctx, st->st_uid), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "gid", JS_NewInt32(ctx, st->st_gid), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "rdev", JS_NewFloat64(ctx, st->st_rdev), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "size", JS_NewFloat64(ctx, st->st_size), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "blksize", JS_NewInt32(ctx, st->st_blksize), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "blocks", JS_NewFloat64(ctx, st->st_blocks), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "atimeMs", JS_NewFloat64(ctx, st->st_atim.tv_sec*1000.0 + st->st_atim.tv_nsec/1e6), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "mtimeMs", JS_NewFloat64(ctx, st->st_mtim.tv_sec*1000.0 + st->st_mtim.tv_nsec/1e6), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "ctimeMs", JS_NewFloat64(ctx, st->st_ctim.tv_sec*1000.0 + st->st_ctim.tv_nsec/1e6), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, o, "birthtimeMs", JS_NewFloat64(ctx, st->st_ctim.tv_sec*1000.0 + st->st_ctim.tv_nsec/1e6), JS_PROP_C_W_E);
    return o;
}

static int rm_recursive(const char *path) {
    struct stat st;
    if (lstat(path, &st) < 0) return errno == ENOENT ? 0 : -1;
    if (S_ISDIR(st.st_mode)) {
        DIR *d = opendir(path);
        if (!d) return -1;
        struct dirent *de;
        int rc = 0;
        while ((de = readdir(d))) {
            if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
            char sub[PATH_MAX];
            snprintf(sub, sizeof sub, "%s/%s", path, de->d_name);
            if (rm_recursive(sub) < 0) { rc = -1; break; }
        }
        closedir(d);
        if (rc < 0) return -1;
        if (rmdir(path) < 0) return -1;
        return 0;
    }
    return unlink(path) < 0 ? -1 : 0;
}

static int mkdir_recursive(const char *path, mode_t mode, char *first_created, size_t fsz) {
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s", path);
    size_t len = strlen(tmp);
    while (len > 1 && tmp[len-1] == '/') tmp[--len] = 0;
    struct stat st;
    if (stat(tmp, &st) == 0) return S_ISDIR(st.st_mode) ? 1 : -2;
    char *slash = strrchr(tmp, '/');
    if (slash && slash != tmp) {
        *slash = 0;
        int r = mkdir_recursive(tmp, mode, first_created, fsz);
        *slash = '/';
        if (r < 0) return r;
    }
    if (mkdir(tmp, mode) < 0) return errno == EEXIST ? 1 : -1;
    if (first_created && !*first_created)
        snprintf(first_created, fsz, "%s", tmp);
    return 0;
}

/* Generic fs dispatcher: trailing function arg = async (cb(err, result)). */
typedef JSValue (*FsSync)(JSContext *ctx, int argc, JSValueConst *argv);

static JSValue fs_wrap(JSContext *ctx, FsSync fn, int argc, JSValueConst *argv) {
    if (argc > 0 && JS_IsFunction(ctx, argv[argc - 1])) {
        JSValue cb = JS_DupValue(ctx, argv[argc - 1]);
        JSValue r = fn(ctx, argc - 1, argv);
        if (JS_IsException(r)) {
            JSValue err = JS_GetException(ctx); /* clears pending exception */
defer_call(ctx, cb, err, JS_UNDEFINED);
            return JS_UNDEFINED;
        }
defer_call(ctx, cb, JS_NULL, r); /* steals r */
        return JS_UNDEFINED;
    }
    return fn(ctx, argc, argv);
}

#define FS_FUNC(name) \
    static JSValue name##_s(JSContext *ctx, int argc, JSValueConst *argv); \
    static JSValue name(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) { \
        return fs_wrap(ctx, name##_s, argc, argv); \
    }

static int32_t arg_int32(JSContext *ctx, JSValueConst v, int32_t dflt) {
    int32_t r = dflt;
    if (!JS_IsUndefined(v)) JS_ToInt32(ctx, &r, v);
    return r;
}
static char *arg_path(JSContext *ctx, JSValueConst v) {
    return arg_str(ctx, v, "path");
}

FS_FUNC(js_fs_open)
static JSValue js_fs_open_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    int flags = parse_flags(ctx, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (flags < 0) { free(p); return JS_EXCEPTION; }
    int32_t mode = arg_int32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, 0666);
    int fd = open(p, flags, mode);
    if (fd < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "open", p, NULL); free(p); return _r; } }
    free(p);
    return JS_NewInt32(ctx, fd);
}

FS_FUNC(js_fs_close)
static JSValue js_fs_close_s(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t fd = arg_int32(ctx, argv[0], -1);
    if (close(fd) < 0) return js_errno_error(ctx, errno, "close", NULL, NULL);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_read)
static JSValue js_fs_read_s(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t fd = arg_int32(ctx, argv[0], -1);
    size_t blen;
    uint8_t *base = js_get_bytes(ctx, &blen, argv[1], false);
    if (!base) return JS_EXCEPTION;
    uint32_t off = arg_int32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, 0);
    uint32_t len = argc > 3 && !JS_IsUndefined(argv[3]) ? arg_int32(ctx, argv[3], 0)
                  : (blen > off ? blen - off : 0);
    int64_t pos = -1;
    if (argc > 4 && !JS_IsUndefined(argv[4]) && !JS_IsNull(argv[4]))
        JS_ToInt64(ctx, &pos, argv[4]);
    if (off + len > blen) return js_type_error(ctx, "read out of range");
    ssize_t n;
    do {
        n = pos >= 0 ? pread(fd, base + off, len, pos) : read(fd, base + off, len);
    } while (n < 0 && errno == EINTR);
    if (n < 0) return js_errno_error(ctx, errno, "read", NULL, NULL);
    return JS_NewInt32(ctx, n);
}

FS_FUNC(js_fs_write)
static JSValue js_fs_write_s(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t fd = arg_int32(ctx, argv[0], -1);
    bool is_str = JS_IsString(argv[1]);
    size_t blen;
    uint8_t *base = js_get_bytes(ctx, &blen, argv[1], true);
    if (!base) return JS_EXCEPTION;
    uint32_t off = 0, len = blen;
    if (!is_str) {
        off = arg_int32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, 0);
        len = argc > 3 && !JS_IsUndefined(argv[3]) ? arg_int32(ctx, argv[3], 0)
             : (blen > off ? blen - off : 0);
        if (off + len > blen) { js_type_error(ctx, "write out of range"); return JS_EXCEPTION; }
    }
    int64_t pos = -1;
    if (argc > 4 && !JS_IsUndefined(argv[4]) && !JS_IsNull(argv[4]))
        JS_ToInt64(ctx, &pos, argv[4]);
    ssize_t n;
    do {
        n = pos >= 0 ? pwrite(fd, base + off, len, pos) : write(fd, base + off, len);
    } while (n < 0 && errno == EINTR);
    if (is_str) free(base);
    if (n < 0) return js_errno_error(ctx, errno, "write", NULL, NULL);
    return JS_NewInt32(ctx, n);
}

static JSValue fs_stat_generic(JSContext *ctx, JSValueConst pathv, int fd,
                               bool use_lstat, bool is_fstat) {
    char *p = is_fstat ? NULL : arg_path(ctx, pathv);
    if (!is_fstat && !p) return JS_EXCEPTION;
    struct stat st;
    int r = is_fstat ? fstat(fd, &st) : use_lstat ? lstat(p, &st) : stat(p, &st);
    if (r < 0) { int e = errno; if (p) { JSValue _r = js_errno_error(ctx, e, is_fstat?"fstat":use_lstat?"lstat":"stat", p, NULL); free(p); return _r; } }
    free(p);
    return stat_to_obj(ctx, &st);
}
FS_FUNC(js_fs_stat)    static JSValue js_fs_stat_s(JSContext *ctx, int argc, JSValueConst *argv)    { return fs_stat_generic(ctx, argv[0], 0, false, false); }
FS_FUNC(js_fs_lstat)   static JSValue js_fs_lstat_s(JSContext *ctx, int argc, JSValueConst *argv)   { return fs_stat_generic(ctx, argv[0], 0, true, false); }
FS_FUNC(js_fs_fstat)   static JSValue js_fs_fstat_s(JSContext *ctx, int argc, JSValueConst *argv)   { return fs_stat_generic(ctx, JS_UNDEFINED, arg_int32(ctx, argv[0], -1), false, true); }

FS_FUNC(js_fs_readdir)
static JSValue js_fs_readdir_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    bool with_types = argc > 1 && (JS_ToBool(ctx, argv[1]) > 0);
    DIR *d = opendir(p);
    if (!d) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "scandir", p, NULL); free(p); return _r; } }
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    struct dirent *de;
    while ((de = readdir(d))) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        if (with_types) {
            const char *t = "unknown";
            switch (de->d_type) {
            case DT_REG: t = "file"; break;
            case DT_DIR: t = "dir"; break;
            case DT_LNK: t = "link"; break;
            case DT_FIFO: t = "fifo"; break;
            case DT_SOCK: t = "socket"; break;
            case DT_CHR: t = "char"; break;
            case DT_BLK: t = "block"; break;
            }
            JSValue e = JS_NewObject(ctx);
            JS_DefinePropertyValueStr(ctx, e, "name", JS_NewString(ctx, de->d_name), JS_PROP_C_W_E);
            JS_DefinePropertyValueStr(ctx, e, "type", JS_NewString(ctx, t), JS_PROP_C_W_E);
            JS_DefinePropertyValueUint32(ctx, arr, i++, e, JS_PROP_C_W_E);
        } else {
            JS_DefinePropertyValueUint32(ctx, arr, i++, JS_NewString(ctx, de->d_name), JS_PROP_C_W_E);
        }
    }
    closedir(d);
    free(p);
    return arr;
}

FS_FUNC(js_fs_mkdir)
static JSValue js_fs_mkdir_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    int32_t mode = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0777);
    bool rec = argc > 2 && (JS_ToBool(ctx, argv[2]) > 0);
    if (rec) {
        char first[PATH_MAX] = "";
        int r = mkdir_recursive(p, mode, first, sizeof first);
        if (r < 0) { int e = (r == -2 ? EEXIST : errno ? errno : EACCES); { JSValue _r = js_errno_error(ctx, e, "mkdir", p, NULL); free(p); return _r; } }
        free(p);
        return *first ? JS_NewString(ctx, first) : JS_UNDEFINED;
    }
    if (mkdir(p, mode) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "mkdir", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_rmdir)
static JSValue js_fs_rmdir_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    if (rmdir(p) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "rmdir", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_rm)
static JSValue js_fs_rm_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    bool rec = argc > 1 && (JS_ToBool(ctx, argv[1]) > 0);
    bool force = argc > 2 && (JS_ToBool(ctx, argv[2]) > 0);
    struct stat st;
    if (lstat(p, &st) < 0) {
        int e = errno;
        if (force && e == ENOENT) { free(p); return JS_UNDEFINED; }
        JSValue _r = js_errno_error(ctx, e, "rm", p, NULL);
        free(p);
        return _r;
    }
    if (S_ISDIR(st.st_mode) && !rec) { { JSValue _r = js_errno_error(ctx, EISDIR, "rm", p, NULL); free(p); return _r; } }
    if (rm_recursive(p) < 0) { int e = errno ? errno : EACCES; { JSValue _r = js_errno_error(ctx, e, "rm", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_unlink)
static JSValue js_fs_unlink_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    if (unlink(p) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "unlink", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_rename)
static JSValue js_fs_rename_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *a = arg_path(ctx, argv[0]), *b = argc > 1 ? arg_path(ctx, argv[1]) : NULL;
    if (!a || !b) { free(a); free(b); return JS_EXCEPTION; }
    if (rename(a, b) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "rename", a, b); free(a); free(b); return _r; } }
    free(a); free(b);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_link)
static JSValue js_fs_link_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *a = arg_path(ctx, argv[0]), *b = argc > 1 ? arg_path(ctx, argv[1]) : NULL;
    if (!a || !b) { free(a); free(b); return JS_EXCEPTION; }
    if (link(a, b) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "link", a, b); free(a); free(b); return _r; } }
    free(a); free(b);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_symlink)
static JSValue js_fs_symlink_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *a = arg_path(ctx, argv[0]), *b = argc > 1 ? arg_path(ctx, argv[1]) : NULL;
    if (!a || !b) { free(a); free(b); return JS_EXCEPTION; }
    if (symlink(a, b) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "symlink", a, b); free(a); free(b); return _r; } }
    free(a); free(b);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_realpath)
static JSValue js_fs_realpath_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    char buf[PATH_MAX];
    if (!realpath(p, buf)) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "realpath", p, NULL); free(p); return _r; } }
    free(p);
    return JS_NewString(ctx, buf);
}

FS_FUNC(js_fs_readlink)
static JSValue js_fs_readlink_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    char buf[PATH_MAX];
    ssize_t n = readlink(p, buf, sizeof buf - 1);
    if (n < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "readlink", p, NULL); free(p); return _r; } }
    buf[n] = 0;
    free(p);
    return JS_NewString(ctx, buf);
}

FS_FUNC(js_fs_chmod)
static JSValue js_fs_chmod_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    int32_t mode = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    if (chmod(p, mode) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "chmod", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_fchmod)
static JSValue js_fs_fchmod_s(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t fd = arg_int32(ctx, argv[0], -1);
    int32_t mode = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    if (fchmod(fd, mode) < 0) return js_errno_error(ctx, errno, "fchmod", NULL, NULL);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_chown)
static JSValue js_fs_chown_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    int32_t uid = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, -1);
    int32_t gid = arg_int32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, -1);
    if (chown(p, uid, gid) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "chown", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_utimes)
static JSValue js_fs_utimes_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    double at = 0, mt = 0;
    if (argc > 1) JS_ToFloat64(ctx, &at, argv[1]);
    if (argc > 2) JS_ToFloat64(ctx, &mt, argv[2]);
    struct timeval tv[2] = {{(time_t)at, 0}, {(time_t)mt, 0}};
    if (utimes(p, tv) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "utimes", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_access)
static JSValue js_fs_access_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    int32_t mode = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0 /*F_OK*/);
    if (access(p, mode) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "access", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

static JSValue js_fs_exists(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    bool r = access(p, 0) == 0;
    free(p);
    return JS_NewBool(ctx, r);
}

FS_FUNC(js_fs_readfile)
static JSValue js_fs_readfile_s(JSContext *ctx, int argc, JSValueConst *argv) {
    bool is_fd = JS_IsNumber(argv[0]);
    char *p = is_fd ? NULL : arg_path(ctx, argv[0]);
    if (!is_fd && !p) return JS_EXCEPTION;
    int fd = is_fd ? arg_int32(ctx, argv[0], -1) : open(p, O_RDONLY);
    if (fd < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "open", p, NULL); free(p); return _r; } }
    const char *enc = NULL;
    if (argc > 1 && JS_IsString(argv[1])) {
        enc = JS_ToCString(ctx, argv[1]);
        if (enc && strcmp(enc, "utf8") && strcmp(enc, "utf-8")) { JS_FreeCString(ctx, enc); enc = NULL; }
    }
    size_t cap = 65536, len = 0;
    uint8_t *buf = malloc(cap);
    for (;;) {
        if (len == cap) { cap *= 2; buf = realloc(buf, cap); }
        ssize_t n = read(fd, buf + len, cap - len);
        if (n < 0) { int e = errno; close(fd); { JSValue _r = js_errno_error(ctx, e, "read", p, NULL); free(buf); free(p); return _r; } }
        if (n == 0) break;
        len += n;
    }
    close(fd);
    free(p);
    if (enc) {
        JSValue r = JS_NewStringLen(ctx, (const char *)buf, len);
        JS_FreeCString(ctx, enc);
        free(buf);
        return r;
    }
    JSValue r = js_new_bytes(ctx, buf, len);
    free(buf);
    return r;
}

FS_FUNC(js_fs_writefile)
static JSValue js_fs_writefile_s(JSContext *ctx, int argc, JSValueConst *argv) {
    bool is_fd = JS_IsNumber(argv[0]);
    char *p = is_fd ? NULL : arg_path(ctx, argv[0]);
    if (!is_fd && !p) return JS_EXCEPTION;
    size_t dlen;
    uint8_t *data = js_get_bytes(ctx, &dlen, argv[1], true);
    if (!data) { free(p); return JS_EXCEPTION; }
    int flags = argc > 2 ? parse_flags(ctx, argv[2]) : O_WRONLY|O_CREAT|O_TRUNC;
    if (flags < 0) { free(p); free(data); return JS_EXCEPTION; }
    int fd = is_fd ? arg_int32(ctx, argv[0], -1) : open(p, flags, arg_int32(ctx, argc > 3 ? argv[3] : JS_UNDEFINED, 0666));
    if (fd < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "open", p, NULL); free(p); free(data); return _r; } }
    size_t off = 0;
    while (off < dlen) {
        ssize_t n = write(fd, data + off, dlen - off);
        if (n < 0) { int e = errno; close(fd); { JSValue _r = js_errno_error(ctx, e, "write", p, NULL); free(p); free(data); return _r; } }
        off += n;
    }
    close(fd);
    free(p);
    if (JS_IsString(argv[1])) free(data);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_copyfile)
static JSValue js_fs_copyfile_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *a = arg_path(ctx, argv[0]), *b = argc > 1 ? arg_path(ctx, argv[1]) : NULL;
    if (!a || !b) { free(a); free(b); return JS_EXCEPTION; }
    int32_t fl = arg_int32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, 0);
    int in = open(a, O_RDONLY), out;
    if (in < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "open", a, NULL); free(a); free(b); return _r; } }
    out = open(b, O_WRONLY|O_CREAT|(fl & 1 ? O_EXCL : 0)|O_TRUNC, 0666);
    if (out < 0) { int e = errno; close(in); { JSValue _r = js_errno_error(ctx, e, "open", b, NULL); free(a); free(b); return _r; } }
    char buf[65536];
    ssize_t n;
    while ((n = read(in, buf, sizeof buf)) > 0) {
        ssize_t w = 0;
        while (w < n) {
            ssize_t k = write(out, buf + w, n - w);
            if (k < 0) { int e = errno; close(in); close(out); { JSValue _r = js_errno_error(ctx, e, "write", b, NULL); free(a); free(b); return _r; } }
            w += k;
        }
    }
    if (n < 0) { int e = errno; close(in); close(out); { JSValue _r = js_errno_error(ctx, e, "read", a, NULL); free(a); free(b); return _r; } }
    close(in); close(out);
    free(a); free(b);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_truncate)
static JSValue js_fs_truncate_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    int32_t len = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    if (truncate(p, len) < 0) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "truncate", p, NULL); free(p); return _r; } }
    free(p);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_ftruncate)
static JSValue js_fs_ftruncate_s(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t fd = arg_int32(ctx, argv[0], -1);
    int32_t len = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    if (ftruncate(fd, len) < 0) return js_errno_error(ctx, errno, "ftruncate", NULL, NULL);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_fsync)
static JSValue js_fs_fsync_s(JSContext *ctx, int argc, JSValueConst *argv) {
    int32_t fd = arg_int32(ctx, argv[0], -1);
    if (fsync(fd) < 0) return js_errno_error(ctx, errno, "fsync", NULL, NULL);
    return JS_UNDEFINED;
}

FS_FUNC(js_fs_mkdtemp)
static JSValue js_fs_mkdtemp_s(JSContext *ctx, int argc, JSValueConst *argv) {
    char *p = arg_path(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    char *tmpl = malloc(strlen(p) + 7);
    sprintf(tmpl, "%sXXXXXX", p);
    if (!mkdtemp(tmpl)) { int e = errno; { JSValue _r = js_errno_error(ctx, e, "mkdtemp", p, NULL); free(p); free(tmpl); return _r; } }
    free(p);
    JSValue r = JS_NewString(ctx, tmpl);
    free(tmpl);
    return r;
}

/* ================= encodings ================= */

static JSValue js_utf8_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!s) return JS_EXCEPTION;
    JSValue r = js_new_bytes(ctx, (const uint8_t *)s, len);
    JS_FreeCString(ctx, s);
    return r;
}
static JSValue js_utf8_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *b = js_get_bytes(ctx, &len, argv[0], false);
    if (!b) return JS_EXCEPTION;
    uint32_t s = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    uint32_t e = argc > 2 && !JS_IsUndefined(argv[2]) ? arg_int32(ctx, argv[2], 0) : len;
    if (s > len || e > len || s > e) return js_type_error(ctx, "bad range");
    return JS_NewStringLen(ctx, (const char *)b + s, e - s);
}
static JSValue js_utf8_length(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!s) return JS_EXCEPTION;
    /* byte length is what Buffer wants for utf8 strings; QuickJS ToCString is UTF-8 */
    JS_FreeCString(ctx, s);
    return JS_NewInt32(ctx, len);
}
static JSValue js_latin1_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    uint32_t len;
    JSValue sv = JS_ToString(ctx, argv[0]);
    if (!JS_IsString(sv)) return JS_EXCEPTION;
    const char *s = JS_ToCString(ctx, sv);
    JS_FreeValue(ctx, sv);
    if (!s) return JS_EXCEPTION;
    len = strlen(s);
    uint8_t *buf = malloc(len);
    for (uint32_t i = 0; i < len; i++) buf[i] = (uint8_t)s[i];
    JS_FreeCString(ctx, s);
    JSValue r = js_new_bytes(ctx, buf, len);
    free(buf);
    return r;
}
static JSValue js_latin1_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *b = js_get_bytes(ctx, &len, argv[0], false);
    if (!b) return JS_EXCEPTION;
    uint32_t s = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    uint32_t e = argc > 2 && !JS_IsUndefined(argv[2]) ? arg_int32(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, 0) : len;
    uint8_t *buf = malloc(e - s + 1);
    for (uint32_t i = 0; i < e - s; i++) buf[i] = b[s + i];
    JSValue r = JS_NewStringLen(ctx, (const char *)buf, e - s);
    free(buf);
    return r;
}
static const char b64_tab[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static JSValue js_base64_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *b = js_get_bytes(ctx, &len, argv[0], false);
    if (!b) return JS_EXCEPTION;
    bool url = argc > 1 && (JS_ToBool(ctx, argv[1]) > 0);
    size_t ol = ((len + 2) / 3) * 4;
    char *out = malloc(ol + 1);
    size_t i, o = 0;
    for (i = 0; i + 2 < len; i += 3) {
        uint32_t v = (b[i] << 16) | (b[i+1] << 8) | b[i+2];
        out[o++] = b64_tab[(v >> 18) & 63];
        out[o++] = b64_tab[(v >> 12) & 63];
        out[o++] = b64_tab[(v >> 6) & 63];
        out[o++] = b64_tab[v & 63];
    }
    if (len - i == 1) {
        out[o++] = b64_tab[b[i] >> 2];
        out[o++] = b64_tab[(b[i] & 3) << 4];
        if (!url) { out[o++] = '='; out[o++] = '='; }
    } else if (len - i == 2) {
        out[o++] = b64_tab[b[i] >> 2];
        out[o++] = b64_tab[((b[i] & 3) << 4) | (b[i+1] >> 4)];
        out[o++] = b64_tab[(b[i+1] & 15) << 2];
        if (!url) out[o++] = '=';
    }
    JSValue r = JS_NewStringLen(ctx, out, o);
    free(out);
    return r;
}
static int b64_val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}
static JSValue js_base64_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s) return JS_EXCEPTION;
    size_t sl = strlen(s);
    uint8_t *out = malloc(sl);
    size_t o = 0;
    uint32_t acc = 0; int nbits = 0;
    for (size_t i = 0; i < sl; i++) {
        int v = b64_val(s[i]);
        if (v < 0) continue;
        acc = (acc << 6) | v;
        nbits += 6;
        if (nbits >= 8) {
            nbits -= 8;
            out[o++] = (acc >> nbits) & 0xff;
        }
    }
    JS_FreeCString(ctx, s);
    JSValue r = js_new_bytes(ctx, out, o);
    free(out);
    return r;
}
static JSValue js_hex_encode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *b = js_get_bytes(ctx, &len, argv[0], false);
    if (!b) return JS_EXCEPTION;
    char *out = malloc(len * 2 + 1);
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[i*2] = hex[b[i] >> 4];
        out[i*2+1] = hex[b[i] & 15];
    }
    JSValue r = JS_NewStringLen(ctx, out, len * 2);
    free(out);
    return r;
}
static JSValue js_hex_decode(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s) return JS_EXCEPTION;
    size_t sl = strlen(s);
    uint8_t *out = malloc(sl / 2 + 1);
    size_t o = 0;
    int hi = -1;
    for (size_t i = 0; i < sl; i++) {
        char c = s[i];
        int v;
        if (c >= '0' && c <= '9') v = c - '0';
        else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
        else continue;
        if (hi < 0) hi = v;
        else { out[o++] = (hi << 4) | v; hi = -1; }
    }
    JS_FreeCString(ctx, s);
    JSValue r = js_new_bytes(ctx, out, o);
    free(out);
    return r;
}

/* ================= random ================= */

static JSValue js_random_bytes(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int32_t n = arg_int32(ctx, argv[0], 0);
    if (n < 0) return js_type_error(ctx, "n must be >= 0");
    uint8_t *buf = malloc(n);
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f || fread(buf, 1, n, f) != (size_t)n) {
        if (f) fclose(f);
        free(buf);
        return JS_ThrowInternalError(ctx, "randomBytes failed");
    }
    fclose(f);
    JSValue r = js_new_bytes(ctx, buf, n);
    free(buf);
    return r;
}
static JSValue js_random_fill(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *b = js_get_bytes(ctx, &len, argv[0], false);
    if (!b) return JS_EXCEPTION;
    uint32_t off = arg_int32(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, 0);
    uint32_t n = argc > 2 && !JS_IsUndefined(argv[2]) ? arg_int32(ctx, argv[2], 0) : len - off;
    if (off + n > len) return js_type_error(ctx, "range");
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f || fread(b + off, 1, n, f) != n) { if (f) fclose(f); return JS_ThrowInternalError(ctx, "randomFill failed"); }
    fclose(f);
    return argv[0];
}

/* ================= tty ================= */

static void save_tty(int fd) {
    if (!rt.tty_raw_saved && isatty(fd)) {
        tcgetattr(fd, &rt.tty_saved);
        rt.tty_raw_saved = true;
    }
}
static JSValue js_isatty(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    return JS_NewBool(ctx, isatty(arg_int32(ctx, argv[0], 0)));
}
static JSValue js_tty_raw(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int fd = arg_int32(ctx, argv[0], 0);
    bool on = JS_ToBool(ctx, argv[1]) > 0;
    mos_dbglog("ttySetRawMode fd=%d on=%d isatty=%d\n", fd, on, isatty(fd));
    if (!isatty(fd)) return JS_UNDEFINED;
    if (on) {
        save_tty(fd);
        struct termios t = rt.tty_saved;
        t.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
        t.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
        t.c_oflag &= ~OPOST;
        t.c_cc[VMIN] = 1;
        t.c_cc[VTIME] = 0;
        tcsetattr(fd, TCSANOW, &t);
    } else if (rt.tty_raw_saved) {
        tcsetattr(fd, TCSANOW, &rt.tty_saved);
    }
    return JS_UNDEFINED;
}
static JSValue js_tty_size(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    struct winsize ws;
    if (ioctl(arg_int32(ctx, argv[0], 1), TIOCGWINSZ, &ws) < 0) return JS_NULL;
    JSValue a = JS_NewArray(ctx);
    JS_DefinePropertyValueUint32(ctx, a, 0, JS_NewInt32(ctx, ws.ws_col), JS_PROP_C_W_E);
    JS_DefinePropertyValueUint32(ctx, a, 1, JS_NewInt32(ctx, ws.ws_row), JS_PROP_C_W_E);
    return a;
}
void mos_tty_restore(void) {
    if (rt.tty_raw_saved) {
        tcsetattr(0, TCSANOW, &rt.tty_saved);
        rt.tty_raw_saved = false;
    }
}

/* ================= streams (pipes) ================= */

static Handle *pipe_by_handle(JSContext *ctx, JSValueConst v) {
    Handle *h = handle_from_int(ctx, v);
    if (h && h->type != H_PIPE) { js_type_error(ctx, "not a stream handle"); return NULL; }
    return h;
}

static JSValue js_stream_read_start(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = pipe_by_handle(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    JS_FreeValue(ctx, h->cb);
    h->cb = JS_DupValue(ctx, argv[1]);
    h->u.pipe.reading = true;
    mos_dbglog("readStart fd=%d is_std=%d\n", h->u.pipe.fd, h->u.pipe.is_std);
    /* A std stream is created unref'd (so idle stdin doesn't pin the loop), but
       once something starts reading it — as cli.js's interactive UI does — it
       must keep the event loop alive, exactly like Node's process.stdin. Without
       this the loop drains while the TUI is waiting for a keypress and the whole
       app exits on its own. */
    if (h->u.pipe.is_std) h->ref = true;
    return JS_UNDEFINED;
}
static JSValue js_stream_read_stop(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = pipe_by_handle(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    h->u.pipe.reading = false;
    mos_dbglog("readStop fd=%d is_std=%d\n", h->u.pipe.fd, h->u.pipe.is_std);
    if (h->u.pipe.is_std) h->ref = false;
    return JS_UNDEFINED;
}
/* Map a Unicode codepoint to ONE ASCII byte for the Latin-1 MorphOS console.
   cli.js (Ink) draws its UI with UTF-8 box-drawing/symbols; the console renders
   each raw byte as Latin-1, so a 1-column glyph becomes 3 bytes = 3 columns and
   Ink's redraw cursor math misaligns (garbled TUI) on top of the mojibake. By
   collapsing every codepoint to a single byte we keep 1 glyph = 1 column, which
   both de-mojibakes the output and realigns the in-place redraws. */
static __attribute__((unused)) uint8_t mos_cp_to_ascii(uint32_t cp) {
    switch (cp) {
        case 0x2500: case 0x2501: case 0x2504: case 0x2505: case 0x2508: case 0x2509:
        case 0x2550: case 0x2574: case 0x2576: case 0x2578: case 0x257A: return '-';
        case 0x2502: case 0x2503: case 0x2506: case 0x2507: case 0x250A: case 0x250B:
        case 0x2551: case 0x2575: case 0x2577: case 0x2579: case 0x257B: return '|';
        case 0x2588: case 0x2593: case 0x2592: case 0x2591: case 0x25A0: case 0x25AA:
        case 0x25AE: return '#';
        case 0x2580: case 0x2584: case 0x258C: case 0x2590: return '=';
        case 0x276F: case 0x25B6: case 0x25BA: case 0x25B8: case 0x2192: case 0x2794:
        case 0x2771: case 0x203A: case 0x00BB: return '>';
        case 0x276E: case 0x25C0: case 0x25C4: case 0x25C2: case 0x2190: case 0x2770:
        case 0x2039: case 0x00AB: return '<';
        case 0x2191: case 0x25B2: case 0x25B4: return '^';
        case 0x2193: case 0x25BC: case 0x25BE: return 'v';
        case 0x2713: case 0x2714: case 0x221A: return 'v';
        case 0x2717: case 0x2718: case 0x2715: case 0x2716: case 0x00D7: case 0x2573:
        case 0x274C: return 'x';
        case 0x25CF: case 0x2B24: case 0x26AB: case 0x25C6: case 0x2666: case 0x2022:
        case 0x2219: case 0x00B7: case 0x2027: case 0x2605: case 0x2606: case 0x2737:
        case 0x273B: case 0x2748: return '*';
        case 0x25CB: case 0x25EF: case 0x26AA: case 0x25C7: case 0x25E6: return 'o';
        case 0x2026: return '.';
        case 0x2014: case 0x2013: case 0x2015: case 0x2212: return '-';
        case 0x2018: case 0x2019: case 0x2032: return '\'';
        case 0x201C: case 0x201D: case 0x2033: return '"';
        case 0x00A0: case 0x2007: case 0x202F: case 0x2009: case 0x200A: return ' ';
    }
    if (cp >= 0x2800 && cp <= 0x28FF) return '*';   /* braille spinner frames */
    if (cp >= 0x2500 && cp <= 0x257F) return '+';   /* other box-drawing -> corner */
    if (cp >= 0x2580 && cp <= 0x259F) return '#';   /* block elements */
    if (cp >= 0x2190 && cp <= 0x21FF) return '>';   /* arrows */
    if (cp >= 0x2460 && cp <= 0x24FF) return 'o';   /* enclosed alphanumerics */
    if (cp >= 0x2600 && cp <= 0x27BF) return '*';   /* misc symbols / dingbats */
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return '*';  /* emoji */
    return '?';   /* anything else: one placeholder keeps the column aligned */
}

/* Rewrite a UTF-8 buffer so each codepoint becomes one byte (see above). ASCII
   (incl. all ANSI/VT escape sequences and colors) passes through untouched. */
static __attribute__((unused)) uint8_t *mos_translit_utf8(const uint8_t *in, size_t inlen, size_t *outlen) {
    uint8_t *out = malloc(inlen + 1);
    if (!out) return NULL;
    size_t o = 0, i = 0;
    while (i < inlen) {
        uint8_t c = in[i];
        if (c < 0x80) { out[o++] = c; i++; continue; }
        uint32_t cp; int n;
        if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; n = 1; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; n = 2; }
        else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; n = 3; }
        else { out[o++] = '?'; i++; continue; }      /* stray continuation/invalid */
        if (i + n >= inlen) { out[o++] = '?'; break; } /* incomplete at end */
        bool ok = true;
        for (int k = 1; k <= n; k++) {
            if ((in[i + k] & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (in[i + k] & 0x3F);
        }
        if (!ok) { out[o++] = '?'; i++; continue; }
        out[o++] = mos_cp_to_ascii(cp);
        i += n + 1;
    }
    *outlen = o;
    return out;
}

static JSValue js_stream_write(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = pipe_by_handle(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    size_t len;
    uint8_t *b = js_get_bytes(ctx, &len, argv[1], true);
    if (!b) return JS_EXCEPTION;
    /* Console UTF-8 -> ASCII transliteration is done in JS (lib/_stdio.js).
       An earlier C version (mos_translit_utf8 below, now unused) hung the real
       PPC box, so it must not run here. */
    uint8_t *to_free = JS_IsString(argv[1]) ? b : NULL;
    /* try direct write first */
    ssize_t n = 0;
    if (!h->u.pipe.wq) {
        while ((n = write(h->u.pipe.fd, b, len)) < 0 && errno == EINTR) {}
    }
    bool immediate = n == (ssize_t)len;
    if (n < 0) n = 0; /* EAGAIN etc: queue everything */
    if (!immediate) {
        WriteReq *w = calloc(1, sizeof *w);
        w->len = len - (n > 0 ? n : 0);
        w->data = malloc(w->len);
        memcpy(w->data, b + (n > 0 ? n : 0), w->len);
        if (argc > 2 && JS_IsFunction(ctx, argv[2])) w->cb = JS_DupValue(ctx, argv[2]);
        /* append to queue tail */
        WriteReq **pp = &h->u.pipe.wq;
        while (*pp) pp = &(*pp)->next;
        *pp = w;
    }
    if (to_free) free(to_free);
    if (immediate && argc > 2 && JS_IsFunction(ctx, argv[2]))
        defer_call(ctx, JS_DupValue(ctx, argv[2]), JS_NULL, JS_UNDEFINED);
return JS_NewBool(ctx, immediate);
}
/* Half-close the write side. shutdown() only works on sockets; for a plain
   pipe the only way to deliver EOF to the reader is to close our fd. */
static void pipe_shutdown_wr(Handle *h) {
    if (h->u.pipe.fd < 0) return;
    if (shutdown(h->u.pipe.fd, SHUT_WR) == 0) return;
    if (errno == ENOTSOCK && !h->u.pipe.reading && !h->u.pipe.is_std) {
        close(h->u.pipe.fd);
        h->u.pipe.fd = -1;
    }
}
static JSValue js_stream_shutdown(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = pipe_by_handle(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    h->u.pipe.shutdown = true; /* actual shutdown when write queue drains */
    if (!h->u.pipe.wq) pipe_shutdown_wr(h);
    if (argc > 1 && JS_IsFunction(ctx, argv[1]))
        defer_call(ctx, JS_DupValue(ctx, argv[1]), JS_NULL, JS_UNDEFINED);
    return JS_UNDEFINED;
}
static JSValue js_stream_queued(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = pipe_by_handle(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    size_t q = 0;
    for (WriteReq *w = h->u.pipe.wq; w; w = w->next) q += w->len - w->off;
    return JS_NewInt64(ctx, q);
}
static JSValue js_open_fd_stream(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int fd = arg_int32(ctx, argv[0], -1);
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    Handle *h = handle_new(H_PIPE);
    h->u.pipe.fd = fd;
    h->u.pipe.is_std = fd < 3;
    /* std streams should not keep the loop alive unless used */
    h->ref = false;
    return JS_NewInt32(ctx, h->id);
}
static JSValue js_stream_is_tty(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = pipe_by_handle(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    return JS_NewBool(ctx, isatty(h->u.pipe.fd));
}

/* ========================================================================
 * NET BACKEND SEAM  (POSIX sockets)
 * ------------------------------------------------------------------------
 * This section is the ONLY platform-specific socket code in mosnode. To port
 * to MorphOS, reimplement the be_* helpers against bsdsocket.library:
 *   socket/connect/bind/listen/accept  -> same names via the library base
 *   getaddrinfo                        -> bsdsocket getaddrinfo (or legacy
 *                                         gethostbyname on old stacks)
 *   getsockopt(SO_ERROR)               -> same
 *   fcntl(O_NONBLOCK)                  -> IoctlSocket(fd, FIONBIO, &one)
 * and swap poll() for WaitSelect() in the event loop (mos_loop_turn /
 * mos_poll_block). Everything below the seam — the data path (read/write/
 * shutdown via the pipe machinery) and all the JS in lib/net.js — stays
 * unchanged across platforms. Addresses are built from numeric strings with
 * explicit htons(), so the big-endian PPC build needs no byte-order fixups
 * here beyond what htons/ntohs already do.
 * ====================================================================== */

static void sock_set_nonblock(int fd) {
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

static int be_so_error(int fd) {
    int err = 0; socklen_t l = sizeof err;
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &l) < 0) return errno;
    return err;
}

/* Build a sockaddr from a NUMERIC ip string + port. Returns AF_INET/AF_INET6,
   or -1 if ip is not a valid numeric address (caller must resolve first). */
static int be_parse_addr(const char *ip, int port, struct sockaddr_storage *ss, socklen_t *slen) {
    memset(ss, 0, sizeof *ss);
    struct in_addr a4; struct in6_addr a6;
    if (inet_pton(AF_INET, ip, &a4) == 1) {
        struct sockaddr_in *s = (struct sockaddr_in *)ss;
        s->sin_family = AF_INET; s->sin_port = htons((uint16_t)port); s->sin_addr = a4;
        *slen = sizeof *s; return AF_INET;
    }
    if (inet_pton(AF_INET6, ip, &a6) == 1) {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)ss;
        s->sin6_family = AF_INET6; s->sin6_port = htons((uint16_t)port); s->sin6_addr = a6;
        *slen = sizeof *s; return AF_INET6;
    }
    return -1;
}

static void be_addr_str(struct sockaddr *sa, char *ip, size_t iplen, int *port) {
    if (sa->sa_family == AF_INET) {
        struct sockaddr_in *s = (struct sockaddr_in *)sa;
        inet_ntop(AF_INET, &s->sin_addr, ip, iplen);
        if (port) *port = ntohs(s->sin_port);
    } else if (sa->sa_family == AF_INET6) {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)sa;
        inet_ntop(AF_INET6, &s->sin6_addr, ip, iplen);
        if (port) *port = ntohs(s->sin6_port);
    } else { if (iplen) ip[0] = 0; if (port) *port = 0; }
}
/* ===================== end NET BACKEND SEAM ============================= */

/* net.dnsLookup(host, family[, all]) -> {address,family} | [ ... ].
   Synchronous getaddrinfo (no threadpool yet: a brief block during resolve). */
static JSValue js_dns_lookup(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *host = JS_ToCString(ctx, argv[0]);
    if (!host) return JS_EXCEPTION;
    int fam = arg_int32(ctx, argv[1], 0);
    bool all = argc > 2 && JS_ToBool(ctx, argv[2]);
    struct addrinfo hints; memset(&hints, 0, sizeof hints);
    hints.ai_family = fam == 4 ? AF_INET : fam == 6 ? AF_INET6 : AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int rc = getaddrinfo(host, NULL, &hints, &res);
    JS_FreeCString(ctx, host);
    if (rc != 0) {
        JSValue e = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, e, "code", JS_NewString(ctx, "ENOTFOUND"), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, e, "syscall", JS_NewString(ctx, "getaddrinfo"), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, gai_strerror(rc)), JS_PROP_C_W_E);
        return JS_Throw(ctx, e);
    }
    JSValue out;
    if (all) {
        out = JS_NewArray(ctx); uint32_t i = 0;
        for (struct addrinfo *p = res; p; p = p->ai_next) {
            if (p->ai_family != AF_INET && p->ai_family != AF_INET6) continue;
            char ip[64]; be_addr_str(p->ai_addr, ip, sizeof ip, NULL);
            JSValue o = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, o, "address", JS_NewString(ctx, ip));
            JS_SetPropertyStr(ctx, o, "family", JS_NewInt32(ctx, p->ai_family == AF_INET6 ? 6 : 4));
            JS_SetPropertyUint32(ctx, out, i++, o);
        }
    } else {
        out = JS_NULL;
        for (struct addrinfo *p = res; p; p = p->ai_next) {
            if (p->ai_family != AF_INET && p->ai_family != AF_INET6) continue;
            char ip[64]; be_addr_str(p->ai_addr, ip, sizeof ip, NULL);
            out = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, out, "address", JS_NewString(ctx, ip));
            JS_SetPropertyStr(ctx, out, "family", JS_NewInt32(ctx, p->ai_family == AF_INET6 ? 6 : 4));
            break;
        }
    }
    freeaddrinfo(res);
    return out;
}

/* net.netConnect(numericIp, port, cb) -> handle id. cb(err|null) fires once. */
static JSValue js_net_connect(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *ip = JS_ToCString(ctx, argv[0]);
    if (!ip) return JS_EXCEPTION;
    int port = arg_int32(ctx, argv[1], 0);
    struct sockaddr_storage ss; socklen_t slen = 0;
    int fam = be_parse_addr(ip, port, &ss, &slen);
    JS_FreeCString(ctx, ip);
    if (fam < 0) return js_type_error(ctx, "netConnect requires a numeric IP");
    int fd = socket(fam, SOCK_STREAM, 0);
    if (fd < 0) return js_errno_error(ctx, errno, "socket", NULL, NULL);
    sock_set_nonblock(fd);
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    Handle *h = handle_new(H_PIPE);
    h->u.pipe.fd = fd;
    int r = connect(fd, (struct sockaddr *)&ss, slen);
    if (r == 0 || errno == EINPROGRESS || errno == EINTR) {
        h->u.pipe.connecting = true;
        h->u.pipe.connect_cb = JS_DupValue(ctx, argv[2]);
    } else {
        /* immediate failure: report asynchronously, keep handle for close() */
        defer_call(ctx, JS_DupValue(ctx, argv[2]),
                   js_errno_error(ctx, errno, "connect", NULL, NULL), JS_UNDEFINED);
    }
    return JS_NewInt32(ctx, h->id);
}

/* net.netListen(host, port, backlog, onConnection) -> {id,port,address,family} */
static JSValue js_net_listen(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    const char *host = JS_ToCString(ctx, argv[0]);
    int port = arg_int32(ctx, argv[1], 0);
    int backlog = arg_int32(ctx, argv[2], 511);
    struct sockaddr_storage ss; socklen_t slen; int fam;
    if (!host || !host[0]) {
        struct sockaddr_in *s = (struct sockaddr_in *)&ss;
        memset(&ss, 0, sizeof ss);
        s->sin_family = AF_INET; s->sin_addr.s_addr = htonl(INADDR_ANY);
        s->sin_port = htons((uint16_t)port); slen = sizeof *s; fam = AF_INET;
    } else {
        fam = be_parse_addr(host, port, &ss, &slen);
    }
    if (host) JS_FreeCString(ctx, host);
    if (fam < 0) return js_type_error(ctx, "netListen requires a numeric host");
    int fd = socket(fam, SOCK_STREAM, 0);
    if (fd < 0) return js_errno_error(ctx, errno, "socket", NULL, NULL);
    int one = 1; setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sock_set_nonblock(fd);
    if (bind(fd, (struct sockaddr *)&ss, slen) < 0) {
        int e = errno; close(fd); return js_errno_error(ctx, e, "bind", NULL, NULL);
    }
    if (listen(fd, backlog) < 0) {
        int e = errno; close(fd); return js_errno_error(ctx, e, "listen", NULL, NULL);
    }
    struct sockaddr_storage la; socklen_t ll = sizeof la;
    char ip[64] = ""; int aport = port;
    if (getsockname(fd, (struct sockaddr *)&la, &ll) == 0)
        be_addr_str((struct sockaddr *)&la, ip, sizeof ip, &aport);
    Handle *h = handle_new(H_PIPE);
    h->u.pipe.fd = fd;
    h->u.pipe.listening = true;
    h->cb = JS_DupValue(ctx, argv[3]);
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "id", JS_NewInt32(ctx, h->id));
    JS_SetPropertyStr(ctx, o, "port", JS_NewInt32(ctx, aport));
    JS_SetPropertyStr(ctx, o, "address", JS_NewString(ctx, ip[0] ? ip : "0.0.0.0"));
    JS_SetPropertyStr(ctx, o, "family", JS_NewInt32(ctx, fam == AF_INET6 ? 6 : 4));
    return o;
}

/* net.netAccept(serverId) -> {id,remoteAddress,remotePort,family} | null */
static JSValue js_net_accept(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    struct sockaddr_storage ss; socklen_t sl = sizeof ss;
    int cfd = accept(h->u.pipe.fd, (struct sockaddr *)&ss, &sl);
    if (cfd < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return JS_NULL;
        return js_errno_error(ctx, errno, "accept", NULL, NULL);
    }
    sock_set_nonblock(cfd);
    int one = 1; setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    Handle *c = handle_new(H_PIPE);
    c->u.pipe.fd = cfd;
    char ip[64]; int port; be_addr_str((struct sockaddr *)&ss, ip, sizeof ip, &port);
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "id", JS_NewInt32(ctx, c->id));
    JS_SetPropertyStr(ctx, o, "remoteAddress", JS_NewString(ctx, ip));
    JS_SetPropertyStr(ctx, o, "remotePort", JS_NewInt32(ctx, port));
    JS_SetPropertyStr(ctx, o, "family", JS_NewInt32(ctx, ss.ss_family == AF_INET6 ? 6 : 4));
    return o;
}

/* net.netAddr(id, peer) -> {address,port,family} | null  (sock/peer name) */
static JSValue js_net_addr(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    Handle *h = handle_from_int(ctx, argv[0]);
    if (!h) return JS_EXCEPTION;
    bool peer = argc > 1 && JS_ToBool(ctx, argv[1]);
    struct sockaddr_storage ss; socklen_t sl = sizeof ss;
    int r = peer ? getpeername(h->u.pipe.fd, (struct sockaddr *)&ss, &sl)
                 : getsockname(h->u.pipe.fd, (struct sockaddr *)&ss, &sl);
    if (r < 0) return JS_NULL;
    char ip[64]; int port; be_addr_str((struct sockaddr *)&ss, ip, sizeof ip, &port);
    JSValue o = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, o, "address", JS_NewString(ctx, ip));
    JS_SetPropertyStr(ctx, o, "port", JS_NewInt32(ctx, port));
    JS_SetPropertyStr(ctx, o, "family", JS_NewString(ctx, ss.ss_family == AF_INET6 ? "IPv6" : "IPv4"));
    return o;
}

/* ========================================================================
 * TLS BACKEND SEAM  (OpenSSL via memory BIOs)
 * ------------------------------------------------------------------------
 * TLS crypto is fully decoupled from TCP: a TLSSocket (lib/tls.js) owns an
 * SSL object with two memory BIOs. Ciphertext from the underlying net.Socket
 * is fed in via tlsReceive(); plaintext is pulled out via tlsRead(); plaintext
 * to send goes in via tlsWrite(); and the ciphertext OpenSSL produces is
 * drained via tlsOutgoing() and written to the socket. net.js handles all the
 * actual TCP. To port to MorphOS, reimplement this section against AmiSSL
 * (an OpenSSL API port) — the BIO-pair model and all of lib/tls.js are
 * unchanged across platforms.
 * ====================================================================== */

#ifndef MOS_NO_TLS
typedef struct TlsConn {
    int id;
    SSL *ssl;
    BIO *rbio;   /* network -> SSL (we BIO_write ciphertext here) */
    BIO *wbio;   /* SSL -> network (we BIO_read ciphertext here)  */
    bool is_server;
    struct TlsConn *next;
} TlsConn;

static SSL_CTX *tls_client_ctx = NULL;
static TlsConn *tls_conns = NULL;
static int tls_next_id = 0;

static SSL_CTX *tls_get_client_ctx(void) {
    if (tls_client_ctx) return tls_client_ctx;
    SSL_CTX *c = SSL_CTX_new(TLS_client_method());
    if (!c) return NULL;
    SSL_CTX_set_min_proto_version(c, TLS1_2_VERSION);
    SSL_CTX_set_default_verify_paths(c);   /* system CA store */
    SSL_CTX_set_mode(c, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    tls_client_ctx = c;
    return c;
}

static TlsConn *tls_find(int id) {
    for (TlsConn *c = tls_conns; c; c = c->next) if (c->id == id) return c;
    return NULL;
}

static TlsConn *tls_find_arg(JSContext *ctx, JSValueConst v) {
    int32_t id; if (JS_ToInt32(ctx, &id, v) < 0) return NULL;
    TlsConn *c = tls_find(id);
    if (!c) { js_type_error(ctx, "invalid tls handle %d", (int)id); return NULL; }
    return c;
}

/* Encode ALPN protocol list ("h2","http/1.1") into wire format. */
static JSValue js_tls_error_str(JSContext *ctx) {
    unsigned long e = ERR_get_error();
    char buf[256];
    if (e == 0) return JS_NewString(ctx, "unknown TLS error");
    ERR_error_string_n(e, buf, sizeof buf);
    return JS_NewString(ctx, buf);
}

/* tlsConnect(hostname, rejectUnauthorized, alpnCsv) -> id */
static JSValue js_tls_connect(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    SSL_CTX *cc = tls_get_client_ctx();
    if (!cc) return js_type_error(ctx, "TLS context init failed");
    const char *host = JS_IsUndefined(argv[0]) || JS_IsNull(argv[0]) ? NULL : JS_ToCString(ctx, argv[0]);
    bool reject = argc > 1 ? JS_ToBool(ctx, argv[1]) : true;
    const char *alpn = argc > 2 && JS_IsString(argv[2]) ? JS_ToCString(ctx, argv[2]) : NULL;

    SSL *ssl = SSL_new(cc);
    if (!ssl) { if (host) JS_FreeCString(ctx, host); if (alpn) JS_FreeCString(ctx, alpn); return js_type_error(ctx, "SSL_new failed"); }
    BIO *rbio = BIO_new(BIO_s_mem());
    BIO *wbio = BIO_new(BIO_s_mem());
    SSL_set_bio(ssl, rbio, wbio);   /* takes ownership */
    SSL_set_connect_state(ssl);
    if (host && *host) {
        SSL_set_tlsext_host_name(ssl, host);          /* SNI */
        if (reject) {
            SSL_set1_host(ssl, host);                 /* verify hostname */
            SSL_set_verify(ssl, SSL_VERIFY_PEER, NULL);
        }
    }
    if (alpn && *alpn) {
        /* build wire format: each proto prefixed by 1-byte length, from CSV */
        unsigned char wire[256]; int wl = 0;
        const char *p = alpn;
        while (*p && wl < (int)sizeof wire - 1) {
            const char *comma = strchr(p, ',');
            int len = comma ? (int)(comma - p) : (int)strlen(p);
            if (len > 0 && len < 256 && wl + 1 + len < (int)sizeof wire) {
                wire[wl++] = (unsigned char)len;
                memcpy(wire + wl, p, len); wl += len;
            }
            if (!comma) break; p = comma + 1;
        }
        if (wl > 0) SSL_set_alpn_protos(ssl, wire, wl);
    }

    TlsConn *c = calloc(1, sizeof *c);
    c->id = ++tls_next_id;
    c->ssl = ssl; c->rbio = rbio; c->wbio = wbio; c->is_server = false;
    c->next = tls_conns; tls_conns = c;

    if (host) JS_FreeCString(ctx, host);
    if (alpn) JS_FreeCString(ctx, alpn);
    return JS_NewInt32(ctx, c->id);
}

/* tlsReceive(id, ciphertextBytes): feed network data into the TLS engine */
static JSValue js_tls_receive(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    size_t len; uint8_t *b = js_get_bytes(ctx, &len, argv[1], false);
    if (!b && len) return JS_EXCEPTION;
    size_t off = 0;
    while (off < len) {
        int w = BIO_write(c->rbio, b + off, (int)(len - off));
        if (w <= 0) break;
        off += w;
    }
    return JS_UNDEFINED;
}

/* tlsHandshake(id) -> 0 done | 1 want-io | -1 error */
static JSValue js_tls_handshake(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    int r = SSL_do_handshake(c->ssl);
    if (r == 1) return JS_NewInt32(ctx, 0);
    int err = SSL_get_error(c->ssl, r);
    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, 1);
    return JS_NewInt32(ctx, -1);
}

/* tlsRead(id) -> plaintext Buffer | null (want more) | false (closed) */
static JSValue js_tls_read(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    uint8_t buf[16384];
    int n = SSL_read(c->ssl, buf, sizeof buf);
    if (n > 0) return js_new_bytes(ctx, buf, n);
    int err = SSL_get_error(c->ssl, n);
    if (err == SSL_ERROR_ZERO_RETURN) return JS_FALSE;   /* clean close_notify */
    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) return JS_NULL;
    return JS_FALSE;
}

/* tlsWrite(id, plaintextBytes) -> bytes accepted (<0 on error) */
static JSValue js_tls_write(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    size_t len; uint8_t *b = js_get_bytes(ctx, &len, argv[1], true);
    if (!b && len) return JS_EXCEPTION;
    int n = len == 0 ? 0 : SSL_write(c->ssl, b, (int)len);
    if (JS_IsString(argv[1])) free(b);
    if (n >= 0) return JS_NewInt32(ctx, n);
    int err = SSL_get_error(c->ssl, n);
    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, -1);
}

/* tlsOutgoing(id) -> ciphertext Buffer to send on the socket (empty if none) */
static JSValue js_tls_outgoing(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    size_t pending = BIO_ctrl_pending(c->wbio);
    if (pending == 0) return js_new_bytes(ctx, NULL, 0);
    uint8_t *out = malloc(pending);
    int n = BIO_read(c->wbio, out, (int)pending);
    JSValue r = js_new_bytes(ctx, out, n > 0 ? n : 0);
    free(out);
    return r;
}

/* tlsShutdown(id): begin close_notify (output drained via tlsOutgoing) */
static JSValue js_tls_shutdown(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    SSL_shutdown(c->ssl);
    return JS_UNDEFINED;
}

/* tlsInfo(id) -> { protocol, alpn, authorized, authError } */
static JSValue js_tls_info(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    TlsConn *c = tls_find_arg(ctx, argv[0]);
    if (!c) return JS_EXCEPTION;
    JSValue o = JS_NewObject(ctx);
    const char *ver = SSL_get_version(c->ssl);
    JS_SetPropertyStr(ctx, o, "protocol", JS_NewString(ctx, ver ? ver : ""));
    const unsigned char *ap = NULL; unsigned int apl = 0;
    SSL_get0_alpn_selected(c->ssl, &ap, &apl);
    JS_SetPropertyStr(ctx, o, "alpn", apl ? JS_NewStringLen(ctx, (const char *)ap, apl) : JS_NULL);
    long vr = SSL_get_verify_result(c->ssl);
    JS_SetPropertyStr(ctx, o, "authorized", JS_NewBool(ctx, vr == X509_V_OK));
    JS_SetPropertyStr(ctx, o, "authError", vr == X509_V_OK ? JS_NULL : JS_NewString(ctx, X509_verify_cert_error_string(vr)));
    const char *cipher = SSL_get_cipher_name(c->ssl);
    JS_SetPropertyStr(ctx, o, "cipher", JS_NewString(ctx, cipher ? cipher : ""));
    return o;
}

/* tlsFree(id) */
static JSValue js_tls_free(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int32_t id; if (JS_ToInt32(ctx, &id, argv[0]) < 0) return JS_EXCEPTION;
    TlsConn **pp = &tls_conns;
    while (*pp) {
        if ((*pp)->id == id) {
            TlsConn *c = *pp; *pp = c->next;
            if (c->ssl) SSL_free(c->ssl);   /* frees the BIOs too */
            free(c);
            break;
        }
        pp = &(*pp)->next;
    }
    return JS_UNDEFINED;
}

/* tlsLastError(id) -> string */
static JSValue js_tls_last_error(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    (void)argc; (void)argv;
    return js_tls_error_str(ctx);
}
#else /* MOS_NO_TLS: TLS stubs (AmiSSL/native crypto port TBD for MorphOS) */
#define MOS_TLS_STUB(fn) static JSValue fn(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) \
    { (void)tv; (void)argc; (void)argv; return JS_ThrowTypeError(ctx, "TLS not supported in this build (MOS_NO_TLS)"); }
MOS_TLS_STUB(js_tls_connect)
MOS_TLS_STUB(js_tls_receive)
MOS_TLS_STUB(js_tls_handshake)
MOS_TLS_STUB(js_tls_read)
MOS_TLS_STUB(js_tls_write)
MOS_TLS_STUB(js_tls_outgoing)
MOS_TLS_STUB(js_tls_shutdown)
MOS_TLS_STUB(js_tls_info)
MOS_TLS_STUB(js_tls_free)
MOS_TLS_STUB(js_tls_last_error)
#undef MOS_TLS_STUB
#endif /* MOS_NO_TLS */
/* ===================== end TLS BACKEND SEAM ============================= */

/* ================= child processes ================= */

static char **parse_argv(JSContext *ctx, JSValueConst v, uint32_t *plen) {
    JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
    uint32_t len = 0;
    JS_ToUint32(ctx, &len, lenv);
    JS_FreeValue(ctx, lenv);
    char **av = calloc(len + 1, sizeof(char *));
    for (uint32_t i = 0; i < len; i++) {
        JSValue e = JS_GetPropertyUint32(ctx, v, i);
        const char *cs = JS_ToCString(ctx, e);
        av[i] = strdup(cs ? cs : "");
        JS_FreeCString(ctx, cs);
        JS_FreeValue(ctx, e);
    }
    *plen = len;
    return av;
}

static void free_argv(char **av) {
    if (!av) return;
    for (char **p = av; *p; p++) free(*p);
    free(av);
}

static char **parse_env(JSContext *ctx, JSValueConst v) {
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        char **ev = calloc(1, sizeof(char *));
        return ev; /* NULL-terminated empty = inherit: handled by exec default */
    }
    uint32_t count = 0;
    char **out = NULL;
    if (JS_IsArray(v)) {
        out = parse_argv(ctx, v, &count);
    } else {
        JSPropertyEnum *props; uint32_t n;
        if (JS_GetOwnPropertyNames(ctx, &props, &n, v, JS_GPN_STRING_MASK) < 0)
            return NULL;
        out = calloc(n + 1, sizeof(char *));
        for (uint32_t i = 0; i < n; i++) {
            JSValue k = JS_AtomToString(ctx, props[i].atom);
            JSValue val = JS_GetProperty(ctx, v, props[i].atom);
            const char *ks = JS_ToCString(ctx, k);
            const char *vs = JS_ToCString(ctx, val);
            size_t l = strlen(ks) + strlen(vs) + 2;
            out[i] = malloc(l);
            snprintf(out[i], l, "%s=%s", ks, vs);
            JS_FreeCString(ctx, ks); JS_FreeCString(ctx, vs);
            JS_FreeValue(ctx, k); JS_FreeValue(ctx, val);
            JS_FreeAtom(ctx, props[i].atom);
        }
        js_free(ctx, props);
    }
    return out;
}
static void free_env(char **ev) { free_argv(ev); }

static int stdio_opt(JSContext *ctx, JSValueConst v) {
    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        int r = !strcmp(s, "pipe") ? 0 : !strcmp(s, "inherit") ? 1 : !strcmp(s, "ignore") ? 2 : -1;
        JS_FreeCString(ctx, s);
        return r;
    }
    int32_t fd = -1;
    JS_ToInt32(ctx, &fd, v);
    return fd; /* >=3: fd number */
}

#include <spawn.h>
extern char **environ;

static JSValue js_spawn(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JSValueConst opts = argv[0];
    char *file = arg_str(ctx, JS_GetPropertyStr(ctx, opts, "file"), "file");
    if (!file) return JS_EXCEPTION;
    JSValue args_v = JS_GetPropertyStr(ctx, opts, "args");
    uint32_t alen = 0;
    char **cargv = parse_argv(ctx, args_v, &alen);
    JS_FreeValue(ctx, args_v);
    JSValue env_v = JS_GetPropertyStr(ctx, opts, "env");
    char **cenv = parse_env(ctx, env_v);
    JS_FreeValue(ctx, env_v);
    JSValue cwd_v = JS_GetPropertyStr(ctx, opts, "cwd");
    char *cwd = JS_IsUndefined(cwd_v) ? NULL : arg_str(ctx, cwd_v, "cwd");
    JS_FreeValue(ctx, cwd_v);
    JSValue stdio_v = JS_GetPropertyStr(ctx, opts, "stdio");
    if (JS_IsString(stdio_v)) {
        const char *sv = JS_ToCString(ctx, stdio_v);
        JSValue arr = JS_NewArray(ctx);
        for (int i = 0; i < 3; i++)
            JS_DefinePropertyValueUint32(ctx, arr, i, JS_NewString(ctx, sv ? sv : "pipe"), JS_PROP_C_W_E);
        JS_FreeCString(ctx, sv);
        JS_FreeValue(ctx, stdio_v);
        stdio_v = arr;
    }

    int pfd[3][2]; /* parent side fd */
    int cfd[3];    /* child side action: -1 close, -2 pipe, >=0 fd */
    for (int i = 0; i < 3; i++) {
        pfd[i][0] = pfd[i][1] = -1;
        cfd[i] = -2;
        JSValue e = JS_GetPropertyUint32(ctx, stdio_v, i);
        if (JS_IsUndefined(e)) { cfd[i] = i == 0 ? 0 : i; JS_FreeValue(ctx, e); continue; } /* default: inherit */
        int o = stdio_opt(ctx, e);
        JS_FreeValue(ctx, e);
        if (o == 0) { /* pipe */
            if (pipe(pfd[i]) < 0) { js_errno_error(ctx, errno, "pipe", NULL, NULL); goto fail; }
        } else if (o == 1) cfd[i] = i;
        else if (o == 2) cfd[i] = -1;
        else cfd[i] = o;
    }
    JS_FreeValue(ctx, stdio_v);

    /* find executable */
    char exe[PATH_MAX] = "";
    if (strchr(file, '/')) {
        snprintf(exe, sizeof exe, "%s", file);
    } else {
        const char *path = getenv("PATH");
        for (const char *p = path; p && *p; ) {
            const char *e = strchr(p, ':');
            size_t l = e ? (size_t)(e - p) : strlen(p);
            snprintf(exe, sizeof exe, "%.*s/%s", (int)l, p, file);
            if (access(exe, X_OK) == 0) break;
            exe[0] = 0;
            p = e ? e + 1 : NULL;
        }
    }
    if (!exe[0]) {
        for (int i = 0; i < 3; i++) { if (pfd[i][0] >= 0) { close(pfd[i][0]); close(pfd[i][1]); } }
        JSValue _r = js_errno_error(ctx, ENOENT, "spawn", file, NULL);
        free(file); free_argv(cargv); free_env(cenv); free(cwd);
        return _r;
    }

    /* exec-error self-pipe: write end is FD_CLOEXEC so it auto-closes (EOF to
     * parent) on a successful execve; on a failed execve the child writes errno.
     * This lets us surface exec failure as a thrown errno error (-> Node 'error'
     * event with string code) instead of letting the child _exit(127), which
     * cli.js's ripgrep runner cannot distinguish and hangs on. */
    int epf[2];
    if (pipe(epf) < 0) { js_errno_error(ctx, errno, "pipe", NULL, NULL); goto fail; }
    fcntl(epf[1], F_SETFD, fcntl(epf[1], F_GETFD, 0) | FD_CLOEXEC);

    pid_t pid = fork();
    if (pid < 0) {
        close(epf[0]); close(epf[1]);
        /* This MorphOS/ixemul has no working fork() (ENOSYS). Report it like a
           missing executable (ENOENT) so callers that already handle "the
           program isn't there" — e.g. cli.js's ripgrep runner — fall back to
           their JS path instead of hanging on an unhandled ENOSYS rejection,
           which otherwise blocks the interactive REPL from ever rendering. */
        js_errno_error(ctx, errno == ENOSYS ? ENOENT : errno, "spawn", file, NULL);
        goto fail;
    }
    if (pid == 0) {
        close(epf[0]);
        for (int i = 0; i < 3; i++) {
            if (cfd[i] == -2) {
                dup2(pfd[i][0 == i ? 0 : 1], i);
                close(pfd[i][0]); close(pfd[i][1]);
            } else if (cfd[i] == -1) {
                int nul = open("/dev/null", i == 0 ? O_RDONLY : O_WRONLY);
                dup2(nul, i);
            } else if (cfd[i] >= 0) {
                dup2(cfd[i], i);
            }
        }
        if (cwd) chdir(cwd);
        setenv("TERM", getenv("TERM") ? getenv("TERM") : "dumb", 0);
        if (cenv && cenv[0]) execve(exe, cargv, cenv);
        else execv(exe, cargv);
        { int e = errno; ssize_t w = write(epf[1], &e, sizeof e); (void)w; }
        _exit(127);
    }

    /* parent */
    close(epf[1]);
    {
        int cerr = 0;
        ssize_t rn = read(epf[0], &cerr, sizeof cerr);
        close(epf[0]);
        if (rn == (ssize_t)sizeof cerr && cerr) {
            int st; waitpid(pid, &st, 0);
            for (int i = 0; i < 3; i++)
                if (cfd[i] == -2) { close(pfd[i][0]); close(pfd[i][1]); }
            JSValue _r = js_errno_error(ctx, cerr, "spawn", file, NULL);
            free(file); free_argv(cargv); free_env(cenv); free(cwd);
            return _r; /* JS_EXCEPTION: child_process.js catch -> emits 'error' */
        }
    }
    for (int i = 0; i < 3; i++)
        if (cfd[i] == -2) { close(pfd[i][0 == i ? 0 : 1]); }

    Handle *ch = handle_new(H_CHILD);
    ch->u.child.pid = pid;
    ch->u.child.exit_status = -1;
    ch->cb = JS_DupValue(ctx, argv[1]);
    JSValue result = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, result, "handle", JS_NewInt32(ctx, ch->id), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, result, "pid", JS_NewInt32(ctx, pid), JS_PROP_C_W_E);
    JSValue stdio = JS_NewArray(ctx);
    for (int i = 0; i < 3; i++) {
        if (cfd[i] == -2) {
            int fd = pfd[i][i == 0 ? 1 : 0]; /* parent end: write side of stdin, read side of stdout/stderr */
            int fl = fcntl(fd, F_GETFL, 0);
            fcntl(fd, F_SETFL, fl | O_NONBLOCK);
            Handle *ph = handle_new(H_PIPE);
            ph->u.pipe.fd = fd;
            ch->u.child.pipes[i] = ph;
            JS_DefinePropertyValueUint32(ctx, stdio, i, JS_NewInt32(ctx, ph->id), JS_PROP_C_W_E);
        } else {
            ch->u.child.pipes[i] = NULL;
            JS_DefinePropertyValueUint32(ctx, stdio, i, JS_NULL, JS_PROP_C_W_E);
        }
    }
    JS_DefinePropertyValueStr(ctx, result, "stdio", stdio, JS_PROP_C_W_E);
    free(file); free_argv(cargv); free_env(cenv); free(cwd);
    return result;
fail:
    for (int i = 0; i < 3; i++) { if (pfd[i][0] >= 0) { close(pfd[i][0]); close(pfd[i][1]); } }
    free(file); free_argv(cargv); free_env(cenv); free(cwd);
    return JS_EXCEPTION;
}

static void read_pipe_into(JSContext *ctx, int fd, uint8_t **buf, size_t *len, size_t *cap) {
    for (;;) {
        if (*len + 65536 > *cap) { *cap = (*cap ? *cap * 2 : 65536); *buf = realloc(*buf, *cap); }
        ssize_t n = read(fd, *buf + *len, *cap - *len);
        if (n <= 0) break;
        *len += n;
    }
}

static JSValue js_spawn_sync(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JSValueConst opts = argv[0];
    char *file = arg_str(ctx, JS_GetPropertyStr(ctx, opts, "file"), "file");
    if (!file) return JS_EXCEPTION;
    JSValue args_v = JS_GetPropertyStr(ctx, opts, "args");
    uint32_t alen;
    char **cargv = parse_argv(ctx, args_v, &alen);
    JS_FreeValue(ctx, args_v);
    JSValue env_v = JS_GetPropertyStr(ctx, opts, "env");
    char **cenv = parse_env(ctx, env_v);
    JS_FreeValue(ctx, env_v);
    JSValue cwd_v = JS_GetPropertyStr(ctx, opts, "cwd");
    char *cwd = JS_IsUndefined(cwd_v) ? NULL : arg_str(ctx, cwd_v, "cwd");
    JS_FreeValue(ctx, cwd_v);
    JSValue stdio_v = JS_GetPropertyStr(ctx, opts, "stdio");
    JSValue input_v = JS_GetPropertyStr(ctx, opts, "input");
    JSValue timeout_v = JS_GetPropertyStr(ctx, opts, "timeout");
    double timeout_ms = 0;
    JS_ToFloat64(ctx, &timeout_ms, timeout_v);
    JS_FreeValue(ctx, timeout_v);
    JSValue killsig_v = JS_GetPropertyStr(ctx, opts, "killSignal");
    int killsig = SIGTERM;
    if (JS_IsString(killsig_v)) {
        const char *s = JS_ToCString(ctx, killsig_v);
        killsig = sig_num(s);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, killsig_v);
    JSValue maxbuf_v = JS_GetPropertyStr(ctx, opts, "maxBuffer");
    double maxbuf = 64 * 1024 * 1024;
    JS_ToFloat64(ctx, &maxbuf, maxbuf_v);
    JS_FreeValue(ctx, maxbuf_v);

    int outp[2] = {-1, -1}, errp[2] = {-1, -1}, inp[2] = {-1, -1};
    int opt0 = stdio_opt(ctx, JS_GetPropertyUint32(ctx, stdio_v, 0));
    int opt1 = stdio_opt(ctx, JS_GetPropertyUint32(ctx, stdio_v, 1));
    int opt2 = stdio_opt(ctx, JS_GetPropertyUint32(ctx, stdio_v, 2));
    JS_FreeValue(ctx, stdio_v);
    if (opt0 == 0 && pipe(inp) < 0) return js_errno_error(ctx, errno, "pipe", NULL, NULL);
    if (opt1 == 0 && pipe(outp) < 0) return js_errno_error(ctx, errno, "pipe", NULL, NULL);
    if (opt2 == 0 && pipe(errp) < 0) return js_errno_error(ctx, errno, "pipe", NULL, NULL);

    char exe[PATH_MAX] = "";
    if (strchr(file, '/')) snprintf(exe, sizeof exe, "%s", file);
    else {
        const char *path = getenv("PATH");
        for (const char *p = path; p && *p; ) {
            const char *e = strchr(p, ':');
            size_t l = e ? (size_t)(e - p) : strlen(p);
            snprintf(exe, sizeof exe, "%.*s/%s", (int)l, p, file);
            if (access(exe, X_OK) == 0) break;
            exe[0] = 0;
            p = e ? e + 1 : NULL;
        }
    }
    if (!exe[0]) {
        if (inp[0]>=0){close(inp[0]);close(inp[1]);}
        if (outp[0]>=0){close(outp[0]);close(outp[1]);}
        if (errp[0]>=0){close(errp[0]);close(errp[1]);}
        JSValue _err = js_errno_obj(ctx, ENOENT, "spawn", file, NULL);
        free(file); free_argv(cargv); free_env(cenv); free(cwd);
        JSValue r = JS_NewObject(ctx);
        JS_DefinePropertyValueStr(ctx, r, "error", _err, JS_PROP_C_W_E);
        return r;
    }

    pid_t pid = fork();
    if (pid < 0) {
        /* No working fork() (ENOSYS): return a Node-style failed result with an
           ENOENT error instead of waitpid()'ing on a bad pid. Callers see it the
           same as a missing executable and fall back. */
        int e = (errno == ENOSYS) ? ENOENT : errno;
        if (inp[0] >= 0) { close(inp[0]); close(inp[1]); }
        if (outp[0] >= 0) { close(outp[0]); close(outp[1]); }
        if (errp[0] >= 0) { close(errp[0]); close(errp[1]); }
        JSValue r = JS_NewObject(ctx);
        JS_DefinePropertyValueStr(ctx, r, "error", js_errno_obj(ctx, e, "spawnSync", file, NULL), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, r, "status", JS_NULL, JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, r, "signal", JS_NULL, JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, r, "stdout", opt1 == 0 ? js_new_bytes(ctx, NULL, 0) : JS_NULL, JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, r, "stderr", opt2 == 0 ? js_new_bytes(ctx, NULL, 0) : JS_NULL, JS_PROP_C_W_E);
        free(file); free_argv(cargv); free_env(cenv); free(cwd);
        return r;
    }
    if (pid == 0) {
        if (inp[0] >= 0) { dup2(inp[0], 0); close(inp[0]); close(inp[1]); }
        else if (opt0 == 2) { int n = open("/dev/null", O_RDONLY); dup2(n, 0); }
        if (outp[1] >= 0) { dup2(outp[1], 1); close(outp[0]); close(outp[1]); }
        else if (opt1 == 2) { int n = open("/dev/null", O_WRONLY); dup2(n, 1); }
        if (errp[1] >= 0) { dup2(errp[1], 2); close(errp[0]); close(errp[1]); }
        else if (opt2 == 2) { int n = open("/dev/null", O_WRONLY); dup2(n, 2); }
        if (cwd) chdir(cwd);
        if (cenv && cenv[0]) execve(exe, cargv, cenv);
        else execv(exe, cargv);
        _exit(127);
    }
    if (inp[0] >= 0) close(inp[0]);
    if (outp[1] >= 0) close(outp[1]);
    if (errp[1] >= 0) close(errp[1]);

    size_t in_len = 0;
    uint8_t *in_data = NULL;
    if (!JS_IsUndefined(input_v)) in_data = js_get_bytes(ctx, &in_len, input_v, true);
    size_t in_off = 0;

    uint8_t *ob = NULL, *eb = NULL;
    size_t ol = 0, ocap = 0, el = 0, ecap = 0;
    int64_t deadline = timeout_ms > 0 ? now_ms() + (int64_t)timeout_ms : 0;
    int status = 0, wait_errno = 0;
    bool timed_out = false;

    for (;;) {
        struct pollfd pfds[3];
        int n = 0;
        int oi = -1, ei = -1, ii = -1;
        if (inp[1] >= 0 && in_off < in_len) { ii = n; pfds[n].fd = inp[1]; pfds[n].events = POLLOUT; n++; }
        if (outp[0] >= 0) { oi = n; pfds[n].fd = outp[0]; pfds[n].events = POLLIN; n++; }
        if (errp[0] >= 0) { ei = n; pfds[n].fd = errp[0]; pfds[n].events = POLLIN; n++; }
        int timeout = -1;
        if (deadline) {
            int64_t left = deadline - now_ms();
            if (left <= 0) {
                kill(pid, killsig);
                timed_out = true;
                deadline = 0; /* give it a grace period of blocking wait below */
                timeout = 1000;
            } else timeout = (int)left;
        }
        int pr = poll(pfds, n, timeout);
        if (pr < 0 && errno != EINTR) { wait_errno = errno; break; }
        if (pr > 0) {
            if (ii >= 0 && (pfds[ii].revents & POLLOUT)) {
                ssize_t w = write(inp[1], in_data + in_off, in_len - in_off);
                if (w > 0) in_off += w;
                if (in_off >= in_len) { close(inp[1]); inp[1] = -1; }
            }
            if (oi >= 0 && (pfds[oi].revents & (POLLIN|POLLHUP))) {
                if (ol + 65536 > ocap) { ocap = ocap ? ocap * 2 : 65536; ob = realloc(ob, ocap); }
                ssize_t r = read(outp[0], ob + ol, ocap - ol);
                if (r > 0) ol += r;
                else { close(outp[0]); outp[0] = -1; }
            }
            if (ei >= 0 && (pfds[ei].revents & (POLLIN|POLLHUP))) {
                if (el + 65536 > ecap) { ecap = ecap ? ecap * 2 : 65536; eb = realloc(eb, ecap); }
                ssize_t r = read(errp[0], eb + el, ecap - el);
                if (r > 0) el += r;
                else { close(errp[0]); errp[0] = -1; }
            }
        }
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) break;
        if (w < 0 && errno != EINTR) { wait_errno = errno; break; }
        if (inp[1] < 0 && outp[0] < 0 && errp[0] < 0) {
            waitpid(pid, &status, 0);
            break;
        }
    }
    if (inp[1] >= 0) close(inp[1]);
    if (outp[0] >= 0) { read_pipe_into(ctx, outp[0], &ob, &ol, &ocap); close(outp[0]); }
    if (errp[0] >= 0) { read_pipe_into(ctx, errp[0], &eb, &el, &ecap); close(errp[0]); }

    JSValue r = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, r, "pid", JS_NewInt32(ctx, pid), JS_PROP_C_W_E);
    if (timed_out || wait_errno) {
        JSValue err;
        if (timed_out) {
            err = JS_NewError(ctx);
            JS_DefinePropertyValueStr(ctx, err, "code", JS_NewString(ctx, "ETIMEDOUT"), JS_PROP_C_W_E);
            JS_DefinePropertyValueStr(ctx, err, "errno", JS_NewInt32(ctx, -110), JS_PROP_C_W_E);
            JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, "SPAWN_TIMEOUT"), JS_PROP_C_W_E);
            JS_DefinePropertyValueStr(ctx, err, "syscall", JS_NewString(ctx, "spawn"), JS_PROP_C_W_E);
        } else err = js_errno_error(ctx, wait_errno, "waitpid", NULL, NULL);
        JS_DefinePropertyValueStr(ctx, r, "error", err, JS_PROP_C_W_E);
    } else JS_DefinePropertyValueStr(ctx, r, "error", JS_NULL, JS_PROP_C_W_E);
    if (WIFEXITED(status)) {
        JS_DefinePropertyValueStr(ctx, r, "status", JS_NewInt32(ctx, WEXITSTATUS(status)), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, r, "signal", JS_NULL, JS_PROP_C_W_E);
    } else if (WIFSIGNALED(status)) {
        JS_DefinePropertyValueStr(ctx, r, "status", JS_NULL, JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, r, "signal", JS_NewString(ctx, sig_name(WTERMSIG(status)) ? sig_name(WTERMSIG(status)) : "SIG?"), JS_PROP_C_W_E);
    }
    JS_DefinePropertyValueStr(ctx, r, "stdout", ob ? js_new_bytes(ctx, ob, ol) : (opt1 == 0 ? js_new_bytes(ctx, NULL, 0) : JS_NULL), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, r, "stderr", eb ? js_new_bytes(ctx, eb, el) : (opt2 == 0 ? js_new_bytes(ctx, NULL, 0) : JS_NULL), JS_PROP_C_W_E);
    free(ob); free(eb);
    if (in_data && JS_IsString(input_v)) free(in_data);
    free(file); free_argv(cargv); free_env(cenv); free(cwd);
    return r;
}

/* Blocking-drain all pending pipe write queues. Called at shutdown so output
   written just before process.exit() is not lost with the event loop. */
void mos_flush_pending_writes(void) {
    for (Handle *h = rt.handles; h; h = h->next) {
        if (h->closed || h->type != H_PIPE || h->u.pipe.fd < 0) continue;
        WriteReq *w = h->u.pipe.wq;
        while (w) {
            while (w->off < w->len) {
                ssize_t k = write(h->u.pipe.fd, w->data + w->off, w->len - w->off);
                if (k > 0) { w->off += k; continue; }
                if (k < 0 && errno == EINTR) continue;
                if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    struct pollfd pfd = { h->u.pipe.fd, POLLOUT, 0 };
                    if (poll(&pfd, 1, 200) <= 0) break; /* give up after 200ms */
                    continue;
                }
                break; /* fatal */
            }
            w = w->next;
        }
    }
}

/* ========================================================================
 * ASYNC CONTEXT  (AsyncLocalStorage)
 * ------------------------------------------------------------------------
 * `await` bypasses the JS-visible Promise.prototype.then, so the frame can't be
 * propagated from JS. The QuickJS core was extended (JS_Get/SetAsyncContext)
 * to capture the current frame when a .then/await reaction is registered and
 * restore it when that reaction runs — carrying the frame across every await.
 * The frame itself is an opaque JS value (a Map) managed by lib/async_hooks.js.
 * ====================================================================== */
void mos_init_async_hooks(JSRuntime *jrt, JSContext *ctx) { (void)jrt; (void)ctx; }

static JSValue js_async_ctx_get(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    return JS_GetAsyncContext(ctx);
}
static JSValue js_async_ctx_set(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    JS_SetAsyncContext(ctx, JS_DupValue(ctx, argv[0]));
    return JS_UNDEFINED;
}

/* ================= loop driver (called from main.c) ================= */

void mos_poll_once(int timeout_ms);

/* fire due timers, immediates, deferred calls, I/O; returns true if any work ran */
/* The interactive console stdin on MorphOS: ixemul's poll() falsely reports it
   readable every call, so it must NOT be placed in the event-loop poll set (that
   spins at ~100% CPU and starves the network stack). It is read directly, on a
   throttle, by mos_loop_turn instead. */
static bool is_console_stdin(Handle *h) {
    return h->type == H_PIPE && !h->closed && h->u.pipe.reading &&
           h->u.pipe.is_std && h->u.pipe.fd == 0 && isatty(0);
}

/* Read one burst from a readable pipe/stream/socket handle and deliver it to the
   JS read callback. Translates the MorphOS console single-byte CSI (0x9B) into
   the two-byte ESC '[' form on stdin so cursor/function keys are recognised.
   Returns true if it delivered a data chunk or EOF (i.e. the loop did work). */
static bool mos_pipe_deliver_read(JSContext *ctx, Handle *h) {
    uint8_t buf[65536];
    ssize_t r = read(h->u.pipe.fd, buf, sizeof buf);
    if (r > 0 && h->u.pipe.is_std && h->u.pipe.fd == 0) {
        mos_dbglog("STDIN r=%d:", (int)r);
        for (ssize_t k = 0; k < r && k < 32; k++) mos_dbglog(" %d", buf[k]);
        mos_dbglog("\n");
    }
    if (r > 0 && !JS_IsUndefined(h->cb)) {
        JSValue chunk;
        if (h->u.pipe.is_std && h->u.pipe.fd == 0 && memchr(buf, 0x9B, (size_t)r)) {
            uint8_t *tb = malloc((size_t)r * 2);
            if (tb) {
                size_t o = 0;
                for (ssize_t k = 0; k < r; k++) {
                    if (buf[k] == 0x9B) { tb[o++] = 0x1B; tb[o++] = '['; }
                    else tb[o++] = buf[k];
                }
                chunk = js_new_bytes(ctx, tb, o);
                free(tb);
            } else chunk = js_new_bytes(ctx, buf, r);
        } else {
            chunk = js_new_bytes(ctx, buf, r);
        }
        JSValue cb = JS_DupValue(ctx, h->cb);
        JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 2, (JSValueConst[]){JS_NULL, chunk});
        JS_FreeValue(ctx, cb);
        JS_FreeValue(ctx, chunk);
        if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
        else JS_FreeValue(ctx, ret);
        return true;
    } else if (r == 0 || (r < 0 && errno == EPIPE)) {
        h->u.pipe.reading = false;
        if (!JS_IsUndefined(h->cb)) {
            JSValue cb = JS_DupValue(ctx, h->cb);
            JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 2, (JSValueConst[]){JS_NULL, JS_NULL});
            JS_FreeValue(ctx, cb);
            if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
            else JS_FreeValue(ctx, ret);
        }
        return true;
    }
    return false;  /* EAGAIN / spurious wake: no data */
}

bool mos_loop_turn(JSContext *ctx) {
    bool ran = false;
    int64_t now = now_ms();

    /* timers */
    for (Handle *h = rt.handles; h; ) {
        Handle *next = h->next;
        if (!h->closed && h->type == H_TIMER && h->u.timer.at_ms <= now) {
            if (h->u.timer.repeat_ms > 0)
                h->u.timer.at_ms = now + h->u.timer.repeat_ms;
            JSValue cb = JS_DupValue(ctx, h->cb);
            if (h->u.timer.repeat_ms <= 0) handle_free(ctx, h);
            if (!JS_IsUndefined(cb)) {
                JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 0, NULL);
                if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
                else JS_FreeValue(ctx, ret);
            }
            JS_FreeValue(ctx, cb);
            ran = true;
            now = now_ms();
        }
        h = next;
    }

    /* immediates + deferred calls (check phase).
       Copy the batch out first: callbacks may defer new work, which must
       land in the remaining slots rather than clobber this batch. */
    while (rt.deferred_count > 0) {
        JSValue q[64];
        int n = rt.deferred_count > 64 ? 64 : rt.deferred_count;
        memcpy(q, rt.deferred, n * sizeof(JSValue));
        rt.deferred_count -= n;
        memmove(rt.deferred, rt.deferred + n, rt.deferred_count * sizeof(JSValue));
        for (int i = 0; i < n; i++) {
            JSValue item = q[i];
            JSValue fn = JS_GetPropertyUint32(ctx, item, 0);
            JSValue a = JS_GetPropertyUint32(ctx, item, 1);
            JSValue b = JS_GetPropertyUint32(ctx, item, 2);
            JS_FreeValue(ctx, item);
            if (!JS_IsUndefined(fn)) {
                JSValue args[2] = {a, b};
                int na = 2;
                if (JS_IsUndefined(b)) na = JS_IsUndefined(a) ? 0 : 1;
                JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, na, args);
                if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
                else JS_FreeValue(ctx, ret);
            }
            JS_FreeValue(ctx, fn); JS_FreeValue(ctx, a); JS_FreeValue(ctx, b);
            ran = true;
        }
        while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &(JSContext *){ctx}) > 0) ran = true;
    }
    for (Handle *h = rt.handles; h; ) {
        Handle *next = h->next;
        if (!h->closed && h->type == H_IMMEDIATE) {
            JSValue cb = h->cb;
            h->cb = JS_UNDEFINED;
            JSValue g = JS_GetGlobalObject(ctx);
            char prop[48];
            snprintf(prop, sizeof prop, "__mos_imm_%d", h->id);
            JS_SetPropertyStr(ctx, g, prop, JS_UNDEFINED);
            JS_FreeValue(ctx, g);
            handle_free(ctx, h);
            if (!JS_IsUndefined(cb)) {
                JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 0, NULL);
                if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
                else JS_FreeValue(ctx, ret);
            }
            JS_FreeValue(ctx, cb);
            ran = true;
        }
        h = next;
    }
    while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &(JSContext *){ctx}) > 0) ran = true;

    /* signals */
    for (int s = 1; s < 64; s++) {
        if (!rt.pending_signals[s]) continue;
        rt.pending_signals[s] = 0;
        const char *nm = sig_name(s);
        for (Handle *h = rt.handles; h; h = h->next) {
            if (h->closed || h->type != H_SIGNAL || h->u.sig.signum != s) continue;
            if (!JS_IsUndefined(h->cb)) {
                JSValue arg = JS_NewString(ctx, nm ? nm : "?");
                JSValue cb = JS_DupValue(ctx, h->cb);
                JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 1, &arg);
                JS_FreeValue(ctx, cb);
                JS_FreeValue(ctx, arg);
                if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
                else JS_FreeValue(ctx, ret);
            }
            ran = true;
        }
    }

    /* children: reap */
    for (Handle *h = rt.handles; h; h = h->next) {
        if (h->closed || h->type != H_CHILD || h->u.child.reaped) continue;
        int status;
        pid_t w = waitpid(h->u.child.pid, &status, WNOHANG);
        if (w == h->u.child.pid) {
            h->u.child.reaped = true;
            if (WIFEXITED(status)) {
                h->u.child.exit_status = WEXITSTATUS(status);
                h->u.child.signame[0] = 0;
            } else if (WIFSIGNALED(status)) {
                h->u.child.exit_status = -1;
                const char *nm = sig_name(WTERMSIG(status));
                snprintf(h->u.child.signame, sizeof h->u.child.signame, "%s", nm ? nm : "SIG?");
            }
            ran = true;
        }
    }
    /* report child exits only after pipes hit EOF (order matters for consumers) */
    for (Handle *h = rt.handles; h; h = h->next) {
        if (h->closed || h->type != H_CHILD || !h->u.child.reaped || h->u.child.exit_reported) continue;
        bool pipes_open = false;
        /* like Node: 'exit'/'close' wait for stdout/stderr EOF, not stdin */
        for (int i = 1; i < 3; i++) {
            Handle *p = h->u.child.pipes[i];
            if (p && !p->closed && p->u.pipe.fd >= 0 && p->u.pipe.reading) pipes_open = true;
        }
        if (pipes_open) continue;
        h->u.child.exit_reported = true;
        if (!JS_IsUndefined(h->cb)) {
            JSValue args[2];
            args[0] = JS_NewInt32(ctx, h->u.child.exit_status);
            args[1] = h->u.child.signame[0] ? JS_NewString(ctx, h->u.child.signame) : JS_NULL;
            JSValue cb = JS_DupValue(ctx, h->cb);
            JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 2, args);
            JS_FreeValue(ctx, cb);
            JS_FreeValue(ctx, args[0]); JS_FreeValue(ctx, args[1]);
            if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
            else JS_FreeValue(ctx, ret);
        }
        handle_free(ctx, h);
        ran = true;
    }

    /* poll pipes */
    struct pollfd pfds[256];
    Handle *ph[256];
    int n = 0;
    for (Handle *h = rt.handles; h && n < 256; h = h->next) {
        if (h->closed || h->type != H_PIPE) continue;
        if (is_console_stdin(h)) continue;   /* read separately, throttled (poll lies) */
        short ev = 0;
        if (h->u.pipe.connecting) ev |= POLLOUT;
        else if (h->u.pipe.listening) ev |= POLLIN;
        else {
            if (h->u.pipe.reading) ev |= POLLIN;
            if (h->u.pipe.wq) ev |= POLLOUT;
        }
        if (!ev) continue;
        pfds[n].fd = h->u.pipe.fd;
        pfds[n].events = ev;
        pfds[n].revents = 0;
        ph[n] = h;
        n++;
    }
    if (n > 0) {
        int pr = poll(pfds, n, 0);
        if (pr > 0) {
            for (int i = 0; i < n; i++) {
                Handle *h = ph[i];
                if (h->closed) continue;
                /* socket connect completion: writable (or error) resolves it */
                if (h->u.pipe.connecting) {
                    if (pfds[i].revents & (POLLOUT | POLLERR | POLLHUP | POLLIN)) {
                        int serr = be_so_error(h->u.pipe.fd);
                        h->u.pipe.connecting = false;
                        JSValue cb = h->u.pipe.connect_cb;
                        h->u.pipe.connect_cb = JS_UNDEFINED;
                        if (!JS_IsUndefined(cb)) {
                            JSValue earg = serr ? js_errno_error(ctx, serr, "connect", NULL, NULL) : JS_NULL;
                            JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 1, (JSValueConst[]){earg});
                            JS_FreeValue(ctx, earg);
                            JS_FreeValue(ctx, cb);
                            if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
                            else JS_FreeValue(ctx, ret);
                        }
                        ran = true;
                    }
                    continue;
                }
                /* server socket: readable means pending connection(s) to accept */
                if (h->u.pipe.listening) {
                    if ((pfds[i].revents & (POLLIN | POLLERR)) && !JS_IsUndefined(h->cb)) {
                        JSValue cb = JS_DupValue(ctx, h->cb);
                        JSValue ret = JS_Call(ctx, cb, JS_UNDEFINED, 0, NULL);
                        JS_FreeValue(ctx, cb);
                        if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
                        else JS_FreeValue(ctx, ret);
                        ran = true;
                    }
                    continue;
                }
                /* Linux reports a drained pipe with a closed writer as POLLHUP only */
                if ((pfds[i].revents & (POLLIN | POLLHUP | POLLERR)) && h->u.pipe.reading) {
                    if (mos_pipe_deliver_read(ctx, h)) ran = true;
                }
                if ((pfds[i].revents & POLLOUT) && !h->closed && h->u.pipe.fd >= 0) {
                    WriteReq *w = h->u.pipe.wq;
                    while (w) {
                        ssize_t k = write(h->u.pipe.fd, w->data + w->off, w->len - w->off);
                        if (k < 0) {
                            if (errno == EAGAIN || errno == EINTR) break;
                            /* fatal write error: fail all queued */
                            JSValue err = js_errno_error(ctx, errno, "write", NULL, NULL);
                            JSValue exc = JS_GetException(ctx);
                            while (w) {
                                if (!JS_IsUndefined(w->cb))
                                    defer_call(ctx, w->cb, JS_DupValue(ctx, exc), JS_UNDEFINED);
                                else JS_FreeValue(ctx, w->cb), w->cb = JS_UNDEFINED;
                                WriteReq *nx = w->next;
                                free(w->data); free(w);
                                w = h->u.pipe.wq = nx;
                            }
                            JS_FreeValue(ctx, exc);
                            (void)err;
                            break;
                        }
                        w->off += k;
                        if (w->off >= w->len) {
                            WriteReq *nx = w->next;
                            if (!JS_IsUndefined(w->cb))
                                defer_call(ctx, w->cb, JS_NULL, JS_UNDEFINED);
                            else JS_FreeValue(ctx, w->cb);
                            free(w->data); free(w);
                            w = h->u.pipe.wq = nx;
                            ran = true;
                        }
                    }
                    if (!h->u.pipe.wq && h->u.pipe.shutdown)
                        pipe_shutdown_wr(h);
                }
                if (pfds[i].revents & POLLHUP && !h->u.pipe.reading) {
                    /* nothing */
                }
            }
        }
    }
    /* Interactive console stdin is deliberately kept out of poll() (ixemul's
       poll lies, spinning the loop). Read it directly here, throttled to ~15ms
       — far faster than anyone types — so idle stdin costs no CPU. */
    {
        static int64_t last_con_us = 0;
        for (Handle *h = rt.handles; h; h = h->next) {
            if (!is_console_stdin(h)) continue;
            int64_t t = mos_now_us();
            if (t - last_con_us >= 15000) {
                last_con_us = t;
                if (mos_pipe_deliver_read(ctx, h)) ran = true;
            }
            break;  /* only one interactive stdin */
        }
    }
    while (JS_ExecutePendingJob(JS_GetRuntime(ctx), &(JSContext *){ctx}) > 0) ran = true;
    graveyard_reap();
    return ran;
}

bool mos_loop_alive(void) {
    for (Handle *h = rt.handles; h; h = h->next) {
        if (h->closed || !h->ref) continue;
        switch (h->type) {
        case H_TIMER: case H_CHILD: return true;
        case H_PIPE:
            if (h->u.pipe.reading || h->u.pipe.wq ||
                h->u.pipe.connecting || h->u.pipe.listening) return true;
            break;
        default: break;
        }
    }
    return false;
}

int64_t mos_next_timer_ms(void) {
    int64_t best = -1;
    for (Handle *h = rt.handles; h; h = h->next) {
        if (h->closed || h->type != H_TIMER || !h->ref) continue;
        if (best < 0 || h->u.timer.at_ms < best) best = h->u.timer.at_ms;
    }
    if (best < 0) return -1;
    int64_t d = best - now_ms();
    return d < 0 ? 0 : d;
}

void mos_poll_block(int timeout_ms) {
    /* wait on pipe fds; only wake frequently if children need reaping */
    struct pollfd pfds[256];
    int n = 0;
    bool have_children = false;
    bool console_active = false;
    for (Handle *h = rt.handles; h; h = h->next) {
        if (h->closed) continue;
        if (h->type == H_CHILD && !h->u.child.reaped) have_children = true;
        if (h->type != H_PIPE || n >= 256) continue;
        /* The interactive console fd is NOT polled: ixemul's poll() reports it
           readable immediately every call, so including it makes poll() return
           at once and the loop spins at ~100% CPU, starving the network stack
           and VNC server and freezing the box. It is read on a throttle in
           mos_loop_turn instead; here we just cap the sleep so a keypress is
           still picked up promptly. Real sockets below block properly and so
           provide the actual CPU yield. */
        if (is_console_stdin(h)) { console_active = true; continue; }
        short ev = 0;
        if (h->u.pipe.connecting) ev |= POLLOUT;
        else if (h->u.pipe.listening) ev |= POLLIN;
        else {
            if (h->u.pipe.reading) ev |= POLLIN;
            if (h->u.pipe.wq) ev |= POLLOUT;
        }
        if (ev) { pfds[n].fd = h->u.pipe.fd; pfds[n].events = ev; n++; }
    }
    /* No SIGCHLD-driven wakeup, so poll waitpid every ~50ms WHILE a child runs;
       otherwise sleep up to the next timer (ceiling 1s for signal responsiveness).
       This keeps the CPU near-idle between polls instead of spinning at ~20Hz. */
    int cap = have_children ? 50 : 1000;
    if (console_active && cap > 16) cap = 16;  /* re-check console ~60Hz for typing */
    int t = timeout_ms < 0 ? cap : timeout_ms;
    if (t > cap) t = cap;
    if (t < 0) t = 0;
    if (n > 0) poll(pfds, n, t);       /* real fds block properly -> genuine CPU yield */
    else if (t > 0) usleep((unsigned)t * 1000);
}

/* ================= constants & registration ================= */

static bool builtin_exists(const char *name) {
    char path[4200];
    snprintf(path, sizeof path, "%s/%s.js", rt.lib_dir, name);
    struct stat st;
    return stat(path, &st) == 0;
}

static JSValue build_constants(JSContext *ctx) {
    JSValue c = JS_NewObject(ctx);
    JSValue en = JS_NewObject(ctx);
    for (int i = 0; errno_names[i].name; i++)
        JS_DefinePropertyValueStr(ctx, en, errno_names[i].name, JS_NewInt32(ctx, errno_names[i].num), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, c, "errno", en, JS_PROP_C_W_E);
    JSValue sg = JS_NewObject(ctx);
    for (int i = 0; signal_names[i].name; i++)
        JS_DefinePropertyValueStr(ctx, sg, signal_names[i].name, JS_NewInt32(ctx, signal_names[i].num), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, c, "signals", sg, JS_PROP_C_W_E);
    JSValue fs = JS_NewObject(ctx);
#define DEF(name, val) JS_DefinePropertyValueStr(ctx, fs, name, JS_NewInt32(ctx, val), JS_PROP_C_W_E)
    DEF("O_RDONLY", O_RDONLY); DEF("O_WRONLY", O_WRONLY); DEF("O_RDWR", O_RDWR);
    DEF("O_CREAT", O_CREAT); DEF("O_EXCL", O_EXCL); DEF("O_TRUNC", O_TRUNC);
    DEF("O_APPEND", O_APPEND); DEF("O_NOFOLLOW", O_NOFOLLOW); DEF("O_DIRECTORY", O_DIRECTORY);
    DEF("O_SYNC", O_SYNC); DEF("O_NONBLOCK", O_NONBLOCK);
    DEF("S_IFMT", S_IFMT); DEF("S_IFREG", S_IFREG); DEF("S_IFDIR", S_IFDIR);
    DEF("S_IFLNK", S_IFLNK); DEF("S_IFIFO", S_IFIFO); DEF("S_IFSOCK", S_IFSOCK);
    DEF("S_IFCHR", S_IFCHR); DEF("S_IFBLK", S_IFBLK);
    DEF("F_OK", F_OK); DEF("R_OK", R_OK); DEF("W_OK", W_OK); DEF("X_OK", X_OK);
    DEF("COPYFILE_EXCL", 1);
#undef DEF
    JS_DefinePropertyValueStr(ctx, c, "fs", fs, JS_PROP_C_W_E);
    return c;
}

#include "wasm_bridge.inc.c"

static const JSCFunctionListEntry native_funcs[] = {
    JS_CFUNC_DEF("gc", 0, js_gc),
    JS_CFUNC_DEF("exit", 1, js_exit),
    JS_CFUNC_DEF("setBufferPrototype", 1, js_set_buffer_proto),
    JS_CFUNC_DEF("setRejectionHandler", 1, js_set_rejection_handler),
    JS_CFUNC_DEF("setBeforeExitHandler", 1, js_set_before_exit),
    JS_CFUNC_DEF("runMicrotasks", 0, js_run_microtasks),
    JS_CFUNC_DEF("evalScript", 2, js_eval_script),
    JS_CFUNC_DEF("requireModule", 2, js_require_module),
    JS_CFUNC_DEF("resolveModule", 2, js_resolve_module),
    JS_CFUNC_DEF("isBuiltin", 1, js_is_builtin),
    JS_CFUNC_DEF("getenv", 1, js_getenv), JS_CFUNC_DEF("setenv", 2, js_setenv), JS_CFUNC_DEF("unsetenv", 1, js_unsetenv), JS_CFUNC_DEF("environ", 0, js_environ),
    JS_CFUNC_DEF("hrtime", 0, js_hrtime), JS_CFUNC_DEF("now", 0, js_now), JS_CFUNC_DEF("uptime", 0, js_uptime), JS_CFUNC_DEF("memoryUsage", 0, js_memory_usage),
    JS_CFUNC_DEF("umask", 1, js_umask), JS_CFUNC_DEF("kill", 2, js_kill), JS_CFUNC_DEF("onSignal", 2, js_on_signal),
    JS_CFUNC_DEF("totalmem", 0, js_totalmem), JS_CFUNC_DEF("freemem", 0, js_freemem), JS_CFUNC_DEF("cpuCount", 0, js_cpu_count), JS_CFUNC_DEF("cpuModel", 0, js_cpu_model),
    JS_CFUNC_DEF("homedir", 0, js_homedir), JS_CFUNC_DEF("tmpdir", 0, js_tmpdir), JS_CFUNC_DEF("userInfo", 0, js_user_info), JS_CFUNC_DEF("loadavg", 0, js_loadavg),
#ifdef __MORPHOS__
    JS_CFUNC_DEF("amigaRun", 1, js_amiga_run),
#endif
    JS_CFUNC_DEF("timerStart", 3, js_timer_start), JS_CFUNC_DEF("timerRestart", 2, js_timer_restart), JS_CFUNC_DEF("immediate", 1, js_immediate),
    JS_CFUNC_DEF("close", 1, js_close_handle), JS_CFUNC_DEF("ref", 1, js_ref_handle), JS_CFUNC_DEF("unref", 1, js_unref_handle), JS_CFUNC_DEF("hasRef", 1, js_has_ref),
    JS_CFUNC_DEF("fsOpen", 3, js_fs_open), JS_CFUNC_DEF("fsClose", 1, js_fs_close), JS_CFUNC_DEF("fsRead", 5, js_fs_read), JS_CFUNC_DEF("fsWrite", 5, js_fs_write),
    JS_CFUNC_DEF("fsStat", 1, js_fs_stat), JS_CFUNC_DEF("fsLstat", 1, js_fs_lstat), JS_CFUNC_DEF("fsFstat", 1, js_fs_fstat), JS_CFUNC_DEF("fsReaddir", 2, js_fs_readdir),
    JS_CFUNC_DEF("fsMkdir", 3, js_fs_mkdir), JS_CFUNC_DEF("fsRmdir", 1, js_fs_rmdir), JS_CFUNC_DEF("fsRm", 3, js_fs_rm), JS_CFUNC_DEF("fsUnlink", 1, js_fs_unlink),
    JS_CFUNC_DEF("fsRename", 2, js_fs_rename), JS_CFUNC_DEF("fsLink", 2, js_fs_link), JS_CFUNC_DEF("fsSymlink", 2, js_fs_symlink),
    JS_CFUNC_DEF("fsRealpath", 1, js_fs_realpath), JS_CFUNC_DEF("fsReadlink", 1, js_fs_readlink),
    JS_CFUNC_DEF("fsChmod", 2, js_fs_chmod), JS_CFUNC_DEF("fsFchmod", 2, js_fs_fchmod), JS_CFUNC_DEF("fsChown", 3, js_fs_chown), JS_CFUNC_DEF("fsUtimes", 3, js_fs_utimes),
    JS_CFUNC_DEF("fsAccess", 2, js_fs_access), JS_CFUNC_DEF("fsExists", 1, js_fs_exists),
    JS_CFUNC_DEF("fsReadFile", 2, js_fs_readfile), JS_CFUNC_DEF("fsWriteFile", 4, js_fs_writefile), JS_CFUNC_DEF("fsCopyFile", 3, js_fs_copyfile),
    JS_CFUNC_DEF("fsTruncate", 2, js_fs_truncate), JS_CFUNC_DEF("fsFtruncate", 2, js_fs_ftruncate), JS_CFUNC_DEF("fsFsync", 1, js_fs_fsync), JS_CFUNC_DEF("fsMkdtemp", 1, js_fs_mkdtemp),
    JS_CFUNC_DEF("utf8Encode", 1, js_utf8_encode), JS_CFUNC_DEF("utf8Decode", 3, js_utf8_decode), JS_CFUNC_DEF("utf8Length", 1, js_utf8_length),
    JS_CFUNC_DEF("latin1Encode", 1, js_latin1_encode), JS_CFUNC_DEF("latin1Decode", 3, js_latin1_decode),
    JS_CFUNC_DEF("base64Encode", 2, js_base64_encode), JS_CFUNC_DEF("base64Decode", 1, js_base64_decode),
    JS_CFUNC_DEF("hexEncode", 1, js_hex_encode), JS_CFUNC_DEF("hexDecode", 1, js_hex_decode),
    JS_CFUNC_DEF("randomBytes", 1, js_random_bytes), JS_CFUNC_DEF("randomFill", 3, js_random_fill),
    JS_CFUNC_DEF("isatty", 1, js_isatty), JS_CFUNC_DEF("ttySetRawMode", 2, js_tty_raw), JS_CFUNC_DEF("ttyGetWindowSize", 1, js_tty_size),
    JS_CFUNC_DEF("streamReadStart", 2, js_stream_read_start), JS_CFUNC_DEF("streamReadStop", 1, js_stream_read_stop), JS_CFUNC_DEF("streamWrite", 3, js_stream_write),
    JS_CFUNC_DEF("streamShutdown", 2, js_stream_shutdown), JS_CFUNC_DEF("streamQueued", 1, js_stream_queued), JS_CFUNC_DEF("openFdStream", 1, js_open_fd_stream),
    JS_CFUNC_DEF("streamIsTTY", 1, js_stream_is_tty),
    JS_CFUNC_DEF("spawn", 2, js_spawn), JS_CFUNC_DEF("spawnSync", 1, js_spawn_sync),
    JS_CFUNC_DEF("dnsLookup", 3, js_dns_lookup), JS_CFUNC_DEF("netConnect", 3, js_net_connect),
    JS_CFUNC_DEF("netListen", 4, js_net_listen), JS_CFUNC_DEF("netAccept", 1, js_net_accept),
    JS_CFUNC_DEF("netAddr", 2, js_net_addr),
    JS_CFUNC_DEF("tlsConnect", 3, js_tls_connect), JS_CFUNC_DEF("tlsReceive", 2, js_tls_receive),
    JS_CFUNC_DEF("tlsHandshake", 1, js_tls_handshake), JS_CFUNC_DEF("tlsRead", 1, js_tls_read),
    JS_CFUNC_DEF("tlsWrite", 2, js_tls_write), JS_CFUNC_DEF("tlsOutgoing", 1, js_tls_outgoing),
    JS_CFUNC_DEF("tlsShutdown", 1, js_tls_shutdown), JS_CFUNC_DEF("tlsInfo", 1, js_tls_info),
    JS_CFUNC_DEF("tlsFree", 1, js_tls_free), JS_CFUNC_DEF("tlsLastError", 1, js_tls_last_error),
    JS_CFUNC_DEF("asyncCtxGet", 0, js_async_ctx_get), JS_CFUNC_DEF("asyncCtxSet", 1, js_async_ctx_set),
    JS_CFUNC_DEF("wasmCompile", 1, js_wasm_compile), JS_CFUNC_DEF("wasmInstantiate", 2, js_wasm_instantiate),
    JS_CFUNC_DEF("wasmCall", 3, js_wasm_call), JS_CFUNC_DEF("wasmMemory", 1, js_wasm_memory),
    JS_CFUNC_DEF("wasmHasExport", 2, js_wasm_has_export),
};

static void add_export(JSContext *ctx, JSModuleDef *m, const char *name, JSValue v) {
    JS_SetModuleExport(ctx, m, name, v);
}

static const char *const native_value_names[] = {
    "platform", "arch", "endianness", "execPath", "libDir", "mainModule",
    "versions", "argv", "execArgv", "timeOrigin", "constants", "procInfo",
    "hostname",
};

static int native_module_init(JSContext *ctx, JSModuleDef *m);

JSModuleDef *js_init_module_native(JSContext *ctx, const char *name) {
    JSModuleDef *m = JS_NewCModule(ctx, name, native_module_init);
    if (!m) return NULL;
    /* export names must exist before instantiation */
    for (size_t i = 0; i < sizeof native_value_names / sizeof native_value_names[0]; i++)
        JS_AddModuleExport(ctx, m, native_value_names[i]);
    for (size_t i = 0; i < sizeof native_funcs / sizeof native_funcs[0]; i++)
        JS_AddModuleExport(ctx, m, native_funcs[i].name);
    return m;
}

static int native_module_init(JSContext *ctx, JSModuleDef *m) {
    /* export values */
    JSValue v;
    add_export(ctx, m, "platform", JS_NewString(ctx, "linux"));
    add_export(ctx, m, "arch", JS_NewString(ctx, "x64"));
    add_export(ctx, m, "endianness", JS_NewString(ctx, "LE"));
    add_export(ctx, m, "execPath", JS_NewString(ctx, rt.exec_path));
    add_export(ctx, m, "libDir", JS_NewString(ctx, rt.lib_dir));
    add_export(ctx, m, "mainModule", JS_NewString(ctx, rt.main_module));
    v = JS_NewObject(ctx);
    {
        char ver[64];
        snprintf(ver, sizeof ver, "%d.%d.%d", QJS_VERSION_MAJOR, QJS_VERSION_MINOR, QJS_VERSION_PATCH);
        JS_DefinePropertyValueStr(ctx, v, "quickjs", JS_NewString(ctx, ver), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, v, "mosnode", JS_NewString(ctx, "0.1.0"), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, v, "zlib", JS_NewString(ctx, "pako"), JS_PROP_C_W_E);
    }
    add_export(ctx, m, "versions", v);
    v = JS_NewArray(ctx);
    for (int i = 0; i < mos_argc; i++)
        JS_DefinePropertyValueUint32(ctx, v, i, JS_NewString(ctx, mos_argv[i]), JS_PROP_C_W_E);
    add_export(ctx, m, "argv", v);
    v = JS_NewArray(ctx);
    add_export(ctx, m, "execArgv", v);
    add_export(ctx, m, "timeOrigin", JS_NewFloat64(ctx, (double)time(NULL) * 1000));
    add_export(ctx, m, "constants", build_constants(ctx));
    v = JS_NewObject(ctx);
    JS_DefinePropertyValueStr(ctx, v, "pid", JS_NewInt32(ctx, getpid()), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, v, "ppid", JS_NewInt32(ctx, getppid()), JS_PROP_C_W_E);
    char cwd[PATH_MAX];
    if (getcwd(cwd, sizeof cwd)) JS_DefinePropertyValueStr(ctx, v, "cwd", JS_NewString(ctx, cwd), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, v, "osType", JS_NewString(ctx, "Linux"), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, v, "osRelease", os_info_str(ctx, 1), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, v, "osVersion", os_info_str(ctx, 2), JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx, v, "machine", os_info_str(ctx, 3), JS_PROP_C_W_E);
    add_export(ctx, m, "procInfo", v);
    add_export(ctx, m, "hostname", os_info_str(ctx, 0));
    /* functions */
    for (size_t i = 0; i < sizeof native_funcs / sizeof native_funcs[0]; i++)
        add_export(ctx, m, native_funcs[i].name,
                   JS_NewCFunction2(ctx, (JSCFunction *)native_funcs[i].u.func.cfunc.generic,
                                    native_funcs[i].name,
                                    native_funcs[i].u.func.length, native_funcs[i].u.func.cproto, 0));
    return 0;
}

void mos_native_init(void) {
    clock_gettime(CLOCK_MONOTONIC, &start_ts);
    signal(SIGPIPE, SIG_IGN);
}
