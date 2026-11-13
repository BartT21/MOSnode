#ifndef MOSNODE_H
#define MOSNODE_H

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <signal.h>
#include <termios.h>
#include <sys/stat.h>

#include "quickjs.h"

/* ---- globals shared between main.c and native.c ---- */

typedef struct Handle Handle;

typedef struct {
    JSContext *ctx;
    const char *exec_path;
    char lib_dir[4096];       /* absolute path of lib/ */
    char main_module[4096];   /* absolute path of entry script (or .qbc) */
    JSValue buffer_proto;     /* set by N.setBufferPrototype */

    Handle *handles;          /* intrusive doubly-linked list */
    int next_handle_id;

    /* deferred callbacks: JS arrays [fn, arg1, arg2] run on next check phase */
    JSValue deferred[512];
    int deferred_count;

    JSValue rejection_handler; /* undefined or fn(mode, promise, reason) */
    JSValue before_exit;       /* undefined or fn() */

    volatile sig_atomic_t pending_signals[64];

    int exit_code;
    bool running;
    bool tty_raw_saved;
    struct termios tty_saved;
} Runtime;

extern Runtime rt;

/* module init (native.c) */
JSModuleDef *js_init_module_native(JSContext *ctx, const char *name);

/* module loading (main.c) */
char *mos_normalize(JSContext *ctx, const char *base, const char *spec); /* malloc'd or NULL */
JSModuleDef *mos_load_module(JSContext *ctx, const char *name);
void mos_native_init(void);
void mos_tty_restore(void);

/* helpers (native.c) */
JSValue js_errno_error(JSContext *ctx, int errnum, const char *syscall,
                       const char *path, const char *dest);
JSValue js_type_error(JSContext *ctx, const char *fmt, ...);
uint8_t *js_get_bytes(JSContext *ctx, size_t *plen, JSValueConst val,
                      bool allow_string); /* malloc'd UTF-8 for strings */
JSValue js_new_bytes(JSContext *ctx, const uint8_t *buf, size_t len);
void defer_call(JSContext *ctx, JSValue fn /*steals*/, JSValue a /*steals*/, JSValue b /*steals*/);
void mos_run_loop(void);
void mos_close_all_handles(void);
int64_t mos_now_us(void);
void mos_dbglog(const char *fmt, ...);
void mos_dbg_dump_handles(void);
void mos_flush_pending_writes(void);
void mos_init_async_hooks(JSRuntime *jrt, JSContext *ctx);

/* argv visible to native.c */
extern char **mos_argv;
extern int mos_argc;

#endif
