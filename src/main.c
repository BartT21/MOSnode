/* mosnode main: QuickJS runtime, module system, event loop */
#include "mosnode.h"
#include <libgen.h>
#include <limits.h>

char **mos_argv;
int mos_argc;
Runtime rt;

bool mos_loop_turn(JSContext *ctx);
bool mos_loop_alive(void);
int64_t mos_next_timer_ms(void);
void mos_poll_block(int timeout_ms);
void mos_tty_restore(void);

/* ================= path helpers ================= */

static bool path_is_abs(const char *p) { return p[0] == '/'; }

static char *normalize_path(const char *base_dir, const char *p) {
    char tmp[PATH_MAX * 2];
    if (path_is_abs(p)) snprintf(tmp, sizeof tmp, "%s", p);
    else snprintf(tmp, sizeof tmp, "%s/%s", base_dir, p);
    char *out = malloc(PATH_MAX);
    out[0] = 0;
    char *save = NULL;
    char *comp = strtok_r(tmp, "/", &save);
    char *parts[1024];
    int n = 0;
    while (comp) {
        if (!strcmp(comp, ".") || !*comp) { }
        else if (!strcmp(comp, "..")) { if (n > 0) n--; }
        else if (n < 1024) parts[n++] = comp;
        comp = strtok_r(NULL, "/", &save);
    }
    size_t o = 0;
    for (int i = 0; i < n; i++)
        o += snprintf(out + o, PATH_MAX - o, "/%s", parts[i]);
    if (o == 0) strcpy(out, "/");
    return out;
}

static char *dir_of(const char *path) {
    char *d = strdup(path);
    char *slash = strrchr(d, '/');
    if (!slash) { free(d); return strdup("."); }
    if (slash == d) slash[1] = 0; else *slash = 0;
    return d;
}

static bool file_exists(const char *p) {
    struct stat st;
    return stat(p, &st) == 0;
}

static char *find_in_node_modules(const char *start_dir, const char *spec) {
    char dir[PATH_MAX];
    snprintf(dir, sizeof dir, "%s", start_dir);
    for (;;) {
        char pkgdir[PATH_MAX];
        snprintf(pkgdir, sizeof pkgdir, "%s/node_modules/%s", dir, spec);
        if (file_exists(pkgdir)) {
            char pj[PATH_MAX + 16];
            snprintf(pj, sizeof pj, "%s/package.json", pkgdir);
            if (file_exists(pj)) {
                FILE *f = fopen(pj, "r");
                if (f) {
                    char buf[8192];
                    size_t n = fread(buf, 1, sizeof buf - 1, f);
                    fclose(f);
                    buf[n] = 0;
                    const char *keys[] = {"\"main\"", "\"module\"", NULL};
                    for (int k = 0; keys[k]; k++) {
                        char *c = strstr(buf, keys[k]);
                        if (!c) continue;
                        c = strchr(c + strlen(keys[k]), ':');
                        if (!c) continue;
                        c++;
                        while (*c == ' ' || *c == '\t') c++;
                        if (*c != '"') continue;
                        c++;
                        char *e = strchr(c, '"');
                        if (!e) continue;
                        char rel[512];
                        snprintf(rel, sizeof rel, "%.*s", (int)(e - c), c);
                        char cand[PATH_MAX * 2];
                        snprintf(cand, sizeof cand, "%s/%s", pkgdir, rel);
                        if (file_exists(cand)) return strdup(cand);
                        snprintf(cand, sizeof cand, "%s/%s.js", pkgdir, rel);
                        if (file_exists(cand)) return strdup(cand);
                    }
                }
            }
            char idx[PATH_MAX + 32];
            snprintf(idx, sizeof idx, "%s/index.js", pkgdir);
            if (file_exists(idx)) return strdup(idx);
            snprintf(idx, sizeof idx, "%s/index.mjs", pkgdir);
            if (file_exists(idx)) return strdup(idx);
            return NULL;
        }
        char *slash = strrchr(dir, '/');
        if (!slash || (slash == dir && !dir[1])) break;
        if (slash == dir) dir[1] = 0; else *slash = 0;
    }
    return NULL;
}

static bool builtin_exists(const char *name) {
    char path[PATH_MAX];
    snprintf(path, sizeof path, "%s/%s.js", rt.lib_dir, name);
    return file_exists(path);
}

/* Normalize an import specifier. Returns malloc'd module name (an absolute
   file path or "native"); on failure throws ERR_MODULE_NOT_FOUND and
   returns NULL. */
char *mos_normalize(JSContext *ctx, const char *base, const char *spec0) {
    const char *spec = spec0;
    if (!strncmp(spec, "node:", 5)) spec += 5;

    if (!strcmp(spec, "native")) return strdup("native");

    char bp[PATH_MAX];
    if (!strcmp(base, "native") || !path_is_abs(base))
        snprintf(bp, sizeof bp, "%s", rt.lib_dir);
    else {
        char *d = dir_of(base);
        snprintf(bp, sizeof bp, "%s", d);
        free(d);
    }

    if (spec[0] != '.' && !path_is_abs(spec)) {
        /* bare specifier, possibly with a subpath (fs/promises) */
        char libp[PATH_MAX];
        snprintf(libp, sizeof libp, "%s/%s.js", rt.lib_dir, spec);
        if (file_exists(libp)) {
            char rp[PATH_MAX];
            if (realpath(libp, rp)) return strdup(rp);
            return strdup(libp);
        }
        if (!strchr(spec, '/')) {
            char *nm = find_in_node_modules(bp, spec);
            if (nm) return nm;
        }
        char msg[512];
        snprintf(msg, sizeof msg, "Cannot find package '%s' imported from %s", spec0, base);
        JSValue e = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, e, "code", JS_NewString(ctx, "ERR_MODULE_NOT_FOUND"), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg), JS_PROP_C_W_E);
        JS_Throw(ctx, e);
        return NULL;
    }

    char *r = normalize_path(bp, spec);
    char cand[PATH_MAX + 16];
    if (file_exists(r)) return r;
    snprintf(cand, sizeof cand, "%s.js", r);
    if (file_exists(cand)) { free(r); return strdup(cand); }
    snprintf(cand, sizeof cand, "%s/index.js", r);
    if (file_exists(cand)) { free(r); return strdup(cand); }
    snprintf(cand, sizeof cand, "%s.json", r);
    if (file_exists(cand)) { free(r); return strdup(cand); }
    return r;
}

/* ================= module loader ================= */

static char *read_whole(const char *path, size_t *plen) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(sz + 1);
    size_t n = fread(buf, 1, sz, f);
    fclose(f);
    buf[n] = 0;
    if (plen) *plen = n;
    return buf;
}

static int set_import_meta(JSContext *ctx, JSValueConst func_val, const char *name, bool main) {
    JSModuleDef *m = JS_VALUE_GET_PTR(func_val);
    JSValue meta = JS_GetImportMeta(ctx, m);
    if (JS_IsException(meta)) return -1;
    char url[PATH_MAX + 16];
    if (!strcmp(name, "native")) snprintf(url, sizeof url, "native:");
    else snprintf(url, sizeof url, "file://%s", name);
    JS_DefinePropertyValueStr(ctx, meta, "url", JS_NewString(ctx, url), JS_PROP_C_W_E);
    if (strcmp(name, "native")) {
        JS_DefinePropertyValueStr(ctx, meta, "filename", JS_NewString(ctx, name), JS_PROP_C_W_E);
        char *d = dir_of(name);
        JS_DefinePropertyValueStr(ctx, meta, "dirname", JS_NewString(ctx, d), JS_PROP_C_W_E);
        free(d);
    }
    JS_DefinePropertyValueStr(ctx, meta, "main", JS_NewBool(ctx, main), JS_PROP_C_W_E);
    JS_FreeValue(ctx, meta);
    return 0;
}

JSModuleDef *mos_load_module(JSContext *ctx, const char *name) {
    if (!strcmp(name, "native"))
        return js_init_module_native(ctx, "native");

    size_t len;
    char *src = read_whole(name, &len);
    if (!src) {
        char msg[PATH_MAX + 128];
        snprintf(msg, sizeof msg, "Cannot find module '%s'", name);
        JSValue e = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, e, "code", JS_NewString(ctx, "ERR_MODULE_NOT_FOUND"), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, e, "message", JS_NewString(ctx, msg), JS_PROP_C_W_E);
        JS_Throw(ctx, e);
        return NULL;
    }
    size_t nl = strlen(name);
    char *src_to_eval = src;
    bool json = nl > 5 && !strcmp(name + nl - 5, ".json");
    if (json) {
        src_to_eval = malloc(len + 32);
        sprintf(src_to_eval, "export default (%s)", src);
    }
    JSValue func_val = JS_Eval(ctx, src_to_eval, strlen(src_to_eval), name,
                               JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (src_to_eval != src) free(src_to_eval);
    free(src);
    if (JS_IsException(func_val)) return NULL;
    set_import_meta(ctx, func_val, name, false);
    return (JSModuleDef *)JS_VALUE_GET_PTR(func_val);
}

static char *module_normalize(JSContext *ctx, const char *base_name, const char *name, void *opaque) {
    char *r = mos_normalize(ctx, base_name, name);
    if (!r) return NULL;
    /* quickjs frees the returned name with js_free */
    char *out = js_strdup(ctx, r);
    free(r);
    return out;
}
static JSModuleDef *module_loader(JSContext *ctx, const char *name, void *opaque) {
    return mos_load_module(ctx, name);
}

/* ================= rejection tracking ================= */

static void promise_rejection_tracker(JSContext *ctx, JSValueConst promise,
                                      JSValueConst reason, bool is_handled, void *opaque) {
    if (JS_IsUninitialized(rt.rejection_handler) || JS_IsUndefined(rt.rejection_handler))
        return;
    JSValue mode = JS_NewString(ctx, is_handled ? "handled" : "unhandled");
    JSValue args[3] = { mode, JS_DupValue(ctx, promise), JS_DupValue(ctx, reason) };
    JSValue ret = JS_Call(ctx, rt.rejection_handler, JS_UNDEFINED, 3, (JSValueConst *)args);
    if (JS_IsException(ret)) { JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e); }
    else JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, mode);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, args[2]);
}

/* Wait for a module-eval promise to settle (TLA), progressing the loop. */
static int settle_promise(JSContext *ctx, JSRuntime *jrt, JSValue r) {
    while (JS_IsPromise(r) && JS_PromiseState(ctx, r) == JS_PROMISE_PENDING) {
        JSContext *jctx; /* out-param: set to NULL when queue is empty */
        if (JS_ExecutePendingJob(jrt, &jctx) <= 0) {
            bool ran = mos_loop_turn(ctx);
            if (JS_PromiseState(ctx, r) != JS_PROMISE_PENDING) break;
            if (!ran && !JS_IsJobPending(jrt)) mos_poll_block(50);
        }
    }
    if (JS_IsPromise(r) && JS_PromiseState(ctx, r) == JS_PROMISE_REJECTED)
        return -1;
    return 0;
}

/* ================= event loop ================= */

/* Cap the non-blocking fast path of the event loop. A busy guest render/
   microtask loop keeps mos_loop_turn returning "ran" (or leaves jobs pending)
   every iteration, so control never reaches mos_poll_block where the other
   spin-guard lives — the loop would then spin at 100% CPU and starve the rest
   of the system (network stack, VNC), freezing the whole box. Flooring each
   fast iteration to ~3ms (≈333 Hz) forces a usleep() yield while keeping
   input/render latency imperceptible. */
static void mos_loop_rate_cap(int64_t t0_us) {
    int64_t dt = mos_now_us() - t0_us;
    if (dt < 3000) usleep((useconds_t)(3000 - dt));
}

void mos_run_loop(void) {
    rt.running = true;
    bool before_exit_ran = false;
    while (rt.running) {
        int64_t t0 = mos_now_us();
        bool ran = mos_loop_turn(rt.ctx);
        if (!rt.running) break;
        if (ran) { mos_loop_rate_cap(t0); continue; }
        if (JS_IsJobPending(JS_GetRuntime(rt.ctx))) {
            JSContext *jctx; /* never pass &rt.ctx: it gets NULLed */
            while (JS_ExecutePendingJob(JS_GetRuntime(rt.ctx), &jctx) > 0) {}
            mos_loop_rate_cap(t0);
            continue;
        }
        if (mos_loop_alive()) {
            int64_t t = mos_next_timer_ms();
            mos_poll_block((int)t);
            continue;
        }
        if (!before_exit_ran) {
            before_exit_ran = true;
            if (!JS_IsUninitialized(rt.before_exit) && !JS_IsUndefined(rt.before_exit)) {
                JSValue ret = JS_Call(rt.ctx, rt.before_exit, JS_UNDEFINED, 0, NULL);
                if (JS_IsException(ret)) { JSValue e = JS_GetException(rt.ctx); JS_FreeValue(rt.ctx, e); }
                else JS_FreeValue(rt.ctx, ret);
                /* new work may have been created */
                if (mos_loop_alive() || JS_IsJobPending(JS_GetRuntime(rt.ctx))) {
                    before_exit_ran = false;
                    continue;
                }
            }
        }
        mos_dbglog("*** loop drained (no live handles) — exiting ***\n");
        break;
    }
}

/* ================= error report ================= */

static void report_exception(JSContext *ctx, JSValueConst exc) {
    JSValue msg = JS_ToString(ctx, exc);
    const char *s = JS_ToCString(ctx, msg);
    fprintf(stderr, "\nmosnode: %s\n", s ? s : "(exception)");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, msg);
    JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
    if (JS_IsString(stack)) {
        const char *st = JS_ToCString(ctx, stack);
        if (st) { fprintf(stderr, "%s\n", st); JS_FreeCString(ctx, st); }
    }
    JS_FreeValue(ctx, stack);
}

/* ================= main ================= */

int main(int argc, char **argv) {
    mos_argv = argv;
    mos_argc = argc;

    char exe[PATH_MAX];
    ssize_t el = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (el < 0) el = 0;
    exe[el] = 0;

    memset(&rt, 0, sizeof rt);
    rt.exec_path = strdup(exe);
    rt.buffer_proto = JS_UNDEFINED;
    rt.rejection_handler = JS_UNDEFINED;
    rt.before_exit = JS_UNDEFINED;
    mos_native_init();

    {
        /* MOSNODE_LIB overrides lib location (so a `claude` wrapper works from any
           CWD even when argv[0] has no dir under ixemul). Else <exe-dir>/../lib. */
        const char *libenv = getenv("MOSNODE_LIB");
        if (libenv && libenv[0]) {
            snprintf(rt.lib_dir, sizeof rt.lib_dir, "%s", libenv);
        } else {
            char *d = dir_of(exe);
            snprintf(rt.lib_dir, sizeof rt.lib_dir, "%s/../lib", d);
            char rp[PATH_MAX];
            if (realpath(rt.lib_dir, rp)) snprintf(rt.lib_dir, sizeof rt.lib_dir, "%s", rp);
            free(d);
        }
    }

    int argi = 1;
    const char *emit_bc = NULL;  /* --emit-bc <out>: compile entry to bytecode, don't run */
    while (argi < argc && argv[argi][0] == '-') {
        if (!strcmp(argv[argi], "--version") || !strcmp(argv[argi], "-v")) {
            printf("mosnode 1.0.0 (quickjs-ng %d.%d.%d)\n",
                   QJS_VERSION_MAJOR, QJS_VERSION_MINOR, QJS_VERSION_PATCH);
            return 0;
        } else if (!strcmp(argv[argi], "--emit-bc")) {
            if (argi + 1 >= argc) { fprintf(stderr, "mosnode: --emit-bc needs <outfile>\n"); return 1; }
            emit_bc = argv[argi + 1]; argi += 2; continue;
        } else if (!strcmp(argv[argi], "--")) { argi++; break; }
        else { fprintf(stderr, "mosnode: unknown flag %s\n", argv[argi]); return 1; }
    }
    if (argi >= argc) {
        fprintf(stderr, "usage: mosnode [flags] <script.js> [args...]\n");
        return 1;
    }

    char script[PATH_MAX];
    if (!realpath(argv[argi], script)) snprintf(script, sizeof script, "%s", argv[argi]);
    snprintf(rt.main_module, sizeof rt.main_module, "%s", script);

    /* process.argv must be [execPath, script, ...args]: exactly mos_argv */
    JSRuntime *jrt = JS_NewRuntime();
    JS_SetMaxStackSize(jrt, 4 * 1024 * 1024);
    if (getenv("MOSNOGC")) JS_SetGCThreshold(jrt, (size_t)-1);
    JS_SetModuleLoaderFunc(jrt, module_normalize, module_loader, NULL);
    JS_SetHostPromiseRejectionTracker(jrt, promise_rejection_tracker, NULL);
    JSContext *ctx = JS_NewContext(jrt);
    rt.ctx = ctx;
    mos_init_async_hooks(jrt, ctx);

    /* 1. bootstrap */
    char bsfile[PATH_MAX];
    snprintf(bsfile, sizeof bsfile, "%s/_bootstrap.js", rt.lib_dir);
    size_t blen;
    char *bs = read_whole(bsfile, &blen);
    if (!bs) { fprintf(stderr, "mosnode: missing %s\n", bsfile); return 1; }
    JSValue bsval = JS_Eval(ctx, bs, blen, bsfile, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(bs);
    if (JS_IsException(bsval)) {
        JSValue exc = JS_GetException(ctx);
        report_exception(ctx, exc);
        JS_FreeValue(ctx, exc);
        return 1;
    }
    set_import_meta(ctx, bsval, bsfile, false);

    /* 2. entry module: load precompiled bytecode (.qbc) or compile from source.
       QuickJS bytecode is native-endian + build-specific, so it must be produced
       by this same binary (mosnode --emit-bc) on the target; loading it skips the
       slow parse (a 13MB bundle: ~minutes to parse, ~instant from bytecode). */
    size_t len;
    char *src = read_whole(script, &len);
    if (!src) { fprintf(stderr, "mosnode: cannot read %s\n", script); return 1; }
    size_t slen2 = strlen(script);
    int is_bc = (slen2 >= 4 && !strcmp(script + slen2 - 4, ".qbc"));
    JSValue func_val = is_bc
        ? JS_ReadObject(ctx, (const uint8_t *)src, len, JS_READ_OBJ_BYTECODE)
        : JS_Eval(ctx, src, len, script, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(src);
    if (JS_IsException(func_val)) {
        JSValue exc = JS_GetException(ctx);
        report_exception(ctx, exc);
        JS_FreeValue(ctx, exc);
        return 1;
    }
    set_import_meta(ctx, func_val, script, true);
    if (emit_bc) {
        /* compile-only: write the module bytecode and exit without running */
        size_t olen; uint8_t *obc = JS_WriteObject(ctx, &olen, func_val, JS_WRITE_OBJ_BYTECODE);
        if (!obc) { fprintf(stderr, "mosnode: JS_WriteObject failed\n"); return 1; }
        FILE *of = fopen(emit_bc, "wb");
        if (!of) { fprintf(stderr, "mosnode: cannot write %s\n", emit_bc); js_free(ctx, obc); return 1; }
        fwrite(obc, 1, olen, of); fclose(of); js_free(ctx, obc); JS_FreeValue(ctx, func_val);
        fprintf(stderr, "mosnode: wrote %s (%zu bytes)\n", emit_bc, olen);
        return 0;
    }
    if (is_bc && JS_ResolveModule(ctx, func_val) < 0) {
        JSValue exc = JS_GetException(ctx);
        report_exception(ctx, exc);
        JS_FreeValue(ctx, exc);
        return 1;
    }
    JSValue r = JS_EvalFunction(ctx, bsval);
    if (JS_IsException(r)) goto entry_error;
    if (settle_promise(ctx, jrt, r) < 0) {
        JSValue exc = JS_PromiseResult(ctx, r);
        report_exception(ctx, exc);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, r);
        return 1;
    }
    JS_FreeValue(ctx, r);
    r = JS_EvalFunction(ctx, func_val);
entry_error:
    if (JS_IsException(r)) {
        JSValue exc = JS_GetException(ctx);
        report_exception(ctx, exc);
        JS_FreeValue(ctx, exc);
        mos_tty_restore();
        return 1;
    }
    if (settle_promise(ctx, jrt, r) < 0) {
        JSValue exc = JS_PromiseResult(ctx, r);
        report_exception(ctx, exc);
        JS_FreeValue(ctx, exc);
        JS_FreeValue(ctx, r);
        mos_tty_restore();
        return 1;
    }
    JS_FreeValue(ctx, r);

    mos_run_loop();

    /* process.exitCode */
    if (rt.exit_code == 0) {
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue proc = JS_GetPropertyStr(ctx, g, "process");
        if (!JS_IsException(proc) && !JS_IsUndefined(proc)) {
            JSValue code = JS_GetPropertyStr(ctx, proc, "exitCode");
            if (!JS_IsUndefined(code) && !JS_IsNull(code))
                JS_ToInt32(ctx, &rt.exit_code, code);
            JS_FreeValue(ctx, code);
        }
        JS_FreeValue(ctx, proc);
        JS_FreeValue(ctx, g);
    }

    mos_flush_pending_writes();
    mos_tty_restore();
    mos_close_all_handles();   /* close sockets/pipes so ixemul doesn't leak them across runs */
    int code = rt.exit_code;
    fflush(stdout);
    fflush(stderr);
    /* Deliberately skip JS_FreeContext()/JS_FreeRuntime() here. The process is
       exiting and the OS reclaims all memory; quickjs-ng's JS_FreeRuntime()
       asserts list_empty(&rt->gc_obj_list) and abort-traps on MorphOS whenever
       any native-held JSValue is still live at teardown (handle callbacks,
       before_exit, buffer_proto, ...). Freeing them perfectly at exit is not
       worth the abort risk; a per-session leak (objects growing *during* a run)
       is a separate problem to profile on-box. */
    (void)jrt; (void)ctx;
    return code;
}
