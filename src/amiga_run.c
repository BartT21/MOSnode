/* amiga_run.c -- MorphOS only: start an AmigaDOS command line asynchronously.
 *
 * mosnode has no fork() on MorphOS, so child_process can't start programs.
 * This is the one thing it needs from the OS for now: hand a URL to the
 * browser (Wayfarer) when a CLI runs `xdg-open <url>` / `$BROWSER <url>`.
 *
 * Kept in its own file so the Amiga headers (BOOL/LONG types, the Open/Close
 * inline macros) never mix with QuickJS or the POSIX code in native.c.
 *
 * ixemul build: the SDK refuses native library calls unless mixing is
 * explicitly allowed. ixemul's crt0.o sets SysBase but leaves DOSBase NULL,
 * so this file opens dos.library itself into a private base (__NOLIBBASE__).
 */
#define __IXEMUL_EXEC_MIXING_ALLOWED
#define __NOLIBBASE__
#include <exec/types.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <dos/dostags.h>
#include <stdlib.h>

extern struct ExecBase *SysBase;          /* set by ixemul crt0.o */
static struct Library *DOSBase;           /* ours; crt0's is never set */

static void close_dos(void)
{
    if (DOSBase) {
        CloseLibrary(DOSBase);
        DOSBase = NULL;
    }
}

int mos_amiga_run(const char *cmd)
{
    BPTR in, out;
    LONG rc;

    if (!cmd || !*cmd || !SysBase) return -1;
    if (!DOSBase) {
        DOSBase = OpenLibrary((CONST_STRPTR)"dos.library", 36);
        if (!DOSBase) return -1;
        atexit(close_dos);
    }
    in = Open((CONST_STRPTR)"NIL:", MODE_OLDFILE);
    out = Open((CONST_STRPTR)"NIL:", MODE_NEWFILE);
    if (!in || !out) {
        if (in) Close(in);
        if (out) Close(out);
        return -1;
    }
    /* Asynch: the new process owns and closes in/out when it ends. Only if it
       never started (rc == -1) are they still ours to close. No NP_Error:
       handing one over and closing it ourselves double-frees (mosctl lesson). */
    {
        /* SystemTagList (not the SystemTags varargs macro): the varargs form
           isn't inlined without USE_INLINE_STDARG and would link to a stub
           that uses the NULL global DOSBase. */
        struct TagItem tags[] = {
            { SYS_Input,       (IPTR)in },
            { SYS_Output,      (IPTR)out },
            { SYS_Asynch,      TRUE },
            { NP_StackSize,    65536 },
            { NP_PPCStackSize, 262144 },
            { TAG_DONE,        0 }
        };
        rc = SystemTagList((CONST_STRPTR)cmd, tags);
    }
    if (rc == -1) {
        Close(in);
        Close(out);
    }
    return (int)rc;
}
