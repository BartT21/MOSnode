/* ============================================================================
 *  WebAssembly bridge over wasm3  (#included into native.c)
 *
 *  Gives mosnode a real `WebAssembly` so cli.js's WASM consumers run:
 *  llhttp (HTTP parsing) and Yoga (Ink's flexbox layout — the full-mode TUI).
 *  Public JS API (N.wasm*) is shaped into the standard WebAssembly object by
 *  lib/webassembly.js. cli.js itself is never modified.
 *
 *  wasm3 is a portable C interpreter, big-endian-correct (verified on the
 *  MorphOS PPC box: i32/i64/f64/byte load-store all pass).
 * ==========================================================================*/
#include "wasm3.h"
#include "m3_env.h"          /* internal M3Module/M3Function/M3FuncType structs */

static IM3Environment g_wenv = NULL;

typedef struct { uint8_t *bytes; size_t len; int used; } WMod;
typedef struct { IM3Runtime rt; IM3Module mod; int used; JSValue keep; } WInst;

typedef struct {
    JSContext *ctx;
    JSValue    fn;            /* JS import function (owned via keep array) */
    uint32_t   nargs, nrets;
    uint8_t    argt[16];
    uint8_t    rett;
} WImport;

static WMod  *g_wmods = NULL;  static int g_wmods_n = 0;
static WInst *g_winsts = NULL; static int g_winsts_n = 0;

static int wmod_new(void) {
    for (int i = 0; i < g_wmods_n; i++) if (!g_wmods[i].used) return i;
    int n = g_wmods_n ? g_wmods_n * 2 : 8;
    WMod *p = realloc(g_wmods, n * sizeof(WMod));
    if (!p) return -1;
    g_wmods = p;
    memset(g_wmods + g_wmods_n, 0, (n - g_wmods_n) * sizeof(WMod));
    int i = g_wmods_n; g_wmods_n = n; return i;
}
static int winst_new(void) {
    for (int i = 0; i < g_winsts_n; i++) if (!g_winsts[i].used) return i;
    int n = g_winsts_n ? g_winsts_n * 2 : 8;
    WInst *p = realloc(g_winsts, n * sizeof(WInst));
    if (!p) return -1;
    g_winsts = p;
    memset(g_winsts + g_winsts_n, 0, (n - g_winsts_n) * sizeof(WInst));
    int i = g_winsts_n; g_winsts_n = n; return i;
}

static char wtype_char(uint8_t t) {
    switch (t) {
        case c_m3Type_i32: return 'i';
        case c_m3Type_i64: return 'I';
        case c_m3Type_f32: return 'f';
        case c_m3Type_f64: return 'F';
        default:           return 'v';
    }
}

/* wasm3 raw-call trampoline: invoked when the guest calls an imported function.
   Slot layout on _sp: return slots first (nrets), then argument slots. */
static const void *wasm_tramp(IM3Runtime runtime, IM3ImportContext _ctx,
                              uint64_t *_sp, void *_mem) {
    (void)runtime; (void)_mem;
    WImport *imp = (WImport *)_ctx->userdata;
    JSContext *ctx = imp->ctx;
    uint64_t *args = _sp + imp->nrets;
    JSValue jsargs[16];
    for (uint32_t i = 0; i < imp->nargs; i++) {
        switch (imp->argt[i]) {
            case c_m3Type_i32: jsargs[i] = JS_NewInt32(ctx, *(int32_t *)&args[i]); break;
            case c_m3Type_i64: jsargs[i] = JS_NewInt64(ctx, *(int64_t *)&args[i]); break;
            case c_m3Type_f32: jsargs[i] = JS_NewFloat64(ctx, (double)(*(float *)&args[i])); break;
            case c_m3Type_f64: jsargs[i] = JS_NewFloat64(ctx, *(double *)&args[i]); break;
            default:           jsargs[i] = JS_UNDEFINED; break;
        }
    }
    JSValue r = JS_Call(ctx, imp->fn, JS_UNDEFINED, (int)imp->nargs, jsargs);
    for (uint32_t i = 0; i < imp->nargs; i++) JS_FreeValue(ctx, jsargs[i]);
    if (JS_IsException(r)) {
        JSValue e = JS_GetException(ctx); JS_FreeValue(ctx, e);
        if (imp->nrets) _sp[0] = 0;
        JS_FreeValue(ctx, r);
        return m3Err_none;      /* swallow: a thrown import would otherwise trap */
    }
    if (imp->nrets) {
        switch (imp->rett) {
            case c_m3Type_i32: { int32_t v = 0; JS_ToInt32(ctx, &v, r);  *(int32_t *)&_sp[0] = v; break; }
            case c_m3Type_i64: { int64_t v = 0; JS_ToInt64(ctx, &v, r);  *(int64_t *)&_sp[0] = v; break; }
            case c_m3Type_f32: { double d = 0;  JS_ToFloat64(ctx, &d, r); *(float *)&_sp[0] = (float)d; break; }
            case c_m3Type_f64: { double d = 0;  JS_ToFloat64(ctx, &d, r); *(double *)&_sp[0] = d; break; }
            default:           _sp[0] = 0; break;
        }
    }
    JS_FreeValue(ctx, r);
    return m3Err_none;
}

/* N.wasmCompile(bytes) -> moduleId  (keeps a copy; validates by parsing) */
static JSValue js_wasm_compile(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    size_t len = 0;
    uint8_t *b = js_get_bytes(ctx, &len, argv[0], false);
    if (!b) return JS_EXCEPTION;
    if (!g_wenv) { g_wenv = m3_NewEnvironment(); if (!g_wenv) return js_type_error(ctx, "wasm: env alloc failed"); }
    uint8_t *copy = malloc(len ? len : 1);
    if (!copy) return js_type_error(ctx, "wasm: oom");
    memcpy(copy, b, len);
    IM3Module m;
    M3Result r = m3_ParseModule(g_wenv, &m, copy, len);
    if (r) { free(copy); return js_type_error(ctx, "WebAssembly.compile: %s", r); }
    m3_FreeModule(m);           /* re-parsed per instance; this only validated */
    int id = wmod_new();
    if (id < 0) { free(copy); return js_type_error(ctx, "wasm: oom"); }
    g_wmods[id].bytes = copy; g_wmods[id].len = len; g_wmods[id].used = 1;
    return JS_NewInt32(ctx, id);
}

/* N.wasmInstantiate(moduleId, flatImports) -> instanceId
   flatImports: { "module.field": jsfn, ... } (flattened by webassembly.js) */
static JSValue js_wasm_instantiate(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int mid = -1; JS_ToInt32(ctx, &mid, argv[0]);
    if (mid < 0 || mid >= g_wmods_n || !g_wmods[mid].used)
        return js_type_error(ctx, "wasm: bad module handle");
    IM3Runtime run = m3_NewRuntime(g_wenv, 256 * 1024, NULL);
    if (!run) return js_type_error(ctx, "wasm: runtime alloc failed");
    IM3Module m;
    M3Result r = m3_ParseModule(g_wenv, &m, g_wmods[mid].bytes, g_wmods[mid].len);
    if (r) { m3_FreeRuntime(run); return js_type_error(ctx, "wasm: parse: %s", r); }

    JSValue keep = JS_NewArray(ctx);
    uint32_t keepN = 0;
    for (uint32_t i = 0; i < m->numFuncImports; i++) {
        M3Function *fn = &m->functions[i];
        const char *mod = fn->import.moduleUtf8 ? fn->import.moduleUtf8 : "";
        const char *fld = fn->import.fieldUtf8  ? fn->import.fieldUtf8  : "";
        char key[256];
        snprintf(key, sizeof key, "%s.%s", mod, fld);
        JSValue jsfn = JS_GetPropertyStr(ctx, argv[1], key);
        if (!JS_IsFunction(ctx, jsfn)) { JS_FreeValue(ctx, jsfn); continue; }
        IM3FuncType ft = fn->funcType;
        WImport *imp = calloc(1, sizeof(WImport));
        if (!imp) { JS_FreeValue(ctx, jsfn); continue; }
        imp->ctx = ctx;
        imp->fn = jsfn;                         /* kept alive via `keep` array */
        imp->nrets = ft->numRets;
        imp->nargs = ft->numArgs;
        for (uint32_t a = 0; a < ft->numArgs && a < 16; a++)
            imp->argt[a] = ft->types[ft->numRets + a];
        imp->rett = ft->numRets ? ft->types[0] : c_m3Type_none;
        char sig[40]; int si = 0;
        sig[si++] = imp->nrets ? wtype_char(imp->rett) : 'v';
        sig[si++] = '(';
        for (uint32_t a = 0; a < imp->nargs && si < 36; a++) sig[si++] = wtype_char(imp->argt[a]);
        sig[si++] = ')'; sig[si] = 0;
        M3Result lr = m3_LinkRawFunctionEx(m, mod, fld, sig, wasm_tramp, imp);
        if (lr) { JS_FreeValue(ctx, jsfn); free(imp); }
        else    { JS_SetPropertyUint32(ctx, keep, keepN++, JS_DupValue(ctx, jsfn)); JS_FreeValue(ctx, jsfn); }
    }

    r = m3_LoadModule(run, m);
    if (r) { m3_FreeModule(m); m3_FreeRuntime(run); JS_FreeValue(ctx, keep);
             return js_type_error(ctx, "WebAssembly instantiate (load): %s", r); }
    m3_RunStart(m);             /* emscripten modules have a start thunk; ignore errors */

    int id = winst_new();
    if (id < 0) { m3_FreeRuntime(run); JS_FreeValue(ctx, keep); return js_type_error(ctx, "wasm: oom"); }
    g_winsts[id].rt = run; g_winsts[id].mod = m; g_winsts[id].used = 1; g_winsts[id].keep = keep;
    return JS_NewInt32(ctx, id);
}

/* N.wasmCall(instanceId, name, argsArray) -> result (number|undefined) */
static JSValue js_wasm_call(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int iid = -1; JS_ToInt32(ctx, &iid, argv[0]);
    if (iid < 0 || iid >= g_winsts_n || !g_winsts[iid].used)
        return js_type_error(ctx, "wasm: bad instance handle");
    const char *name = JS_ToCString(ctx, argv[1]);
    if (!name) return JS_EXCEPTION;
    IM3Function f = NULL;
    M3Result r = m3_FindFunctionIn(&f, g_winsts[iid].mod, name);
    if (r || !f) { JSValue e = js_type_error(ctx, "wasm: export '%s' not found", name); JS_FreeCString(ctx, name); return e; }
    JS_FreeCString(ctx, name);
    uint32_t na = m3_GetArgCount(f);
    if (na > 32) na = 32;
    uint64_t store[32]; const void *ptrs[32];
    for (uint32_t i = 0; i < na; i++) {
        JSValue a = JS_GetPropertyUint32(ctx, argv[2], i);
        switch (m3_GetArgType(f, i)) {
            case c_m3Type_i32: { int32_t v = 0; JS_ToInt32(ctx, &v, a);  *(int32_t *)&store[i] = v; break; }
            case c_m3Type_i64: { int64_t v = 0; JS_ToInt64(ctx, &v, a);  *(int64_t *)&store[i] = v; break; }
            case c_m3Type_f32: { double d = 0;  JS_ToFloat64(ctx, &d, a); *(float *)&store[i] = (float)d; break; }
            case c_m3Type_f64: { double d = 0;  JS_ToFloat64(ctx, &d, a); *(double *)&store[i] = d; break; }
            default:           store[i] = 0; break;
        }
        ptrs[i] = &store[i];
        JS_FreeValue(ctx, a);
    }
    r = m3_Call(f, na, ptrs);
    if (r) return js_type_error(ctx, "WebAssembly call trap: %s", r);
    uint32_t nr = m3_GetRetCount(f);
    if (nr == 0) return JS_UNDEFINED;
    if (nr > 8) nr = 8;
    uint64_t rstore[8]; const void *rptrs[8];
    for (uint32_t i = 0; i < nr; i++) rptrs[i] = &rstore[i];
    r = m3_GetResults(f, nr, rptrs);
    if (r) return js_type_error(ctx, "wasm: results: %s", r);
    switch (m3_GetRetType(f, 0)) {
        case c_m3Type_i32: return JS_NewInt32(ctx, *(int32_t *)&rstore[0]);
        case c_m3Type_i64: return JS_NewInt64(ctx, *(int64_t *)&rstore[0]);
        case c_m3Type_f32: return JS_NewFloat64(ctx, (double)(*(float *)&rstore[0]));
        case c_m3Type_f64: return JS_NewFloat64(ctx, *(double *)&rstore[0]);
        default:           return JS_UNDEFINED;
    }
}

/* N.wasmMemory(instanceId) -> ArrayBuffer over the guest linear memory (0) */
static JSValue js_wasm_memory(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int iid = -1; JS_ToInt32(ctx, &iid, argv[0]);
    if (iid < 0 || iid >= g_winsts_n || !g_winsts[iid].used)
        return js_type_error(ctx, "wasm: bad instance handle");
    size_t sz = 0;
    uint8_t *mem = m3_GetMemory(g_winsts[iid].mod, &sz, 0);
    if (!mem || sz == 0) return JS_NULL;
    return JS_NewArrayBuffer(ctx, mem, sz, sz, NULL, NULL, false);   /* external; wasm3 owns it */
}

/* N.wasmHasExport(instanceId, name) -> bool */
static JSValue js_wasm_has_export(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
    int iid = -1; JS_ToInt32(ctx, &iid, argv[0]);
    if (iid < 0 || iid >= g_winsts_n || !g_winsts[iid].used) return JS_FALSE;
    const char *name = JS_ToCString(ctx, argv[1]);
    if (!name) return JS_EXCEPTION;
    IM3Function f = NULL;
    M3Result r = m3_FindFunctionIn(&f, g_winsts[iid].mod, name);
    JS_FreeCString(ctx, name);
    return (!r && f) ? JS_TRUE : JS_FALSE;
}
