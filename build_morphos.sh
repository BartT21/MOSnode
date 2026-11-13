#!/bin/bash
# Cross-compile mosnode for MorphOS/PPC on an x86-64 Linux host (Kali).
# Needs the metaneutrons/morphos-cross toolchain installed at ~/.morphos-cross/current
# (ppc-morphos-gcc on PATH) with the MorphOS SDK installed into it.
#
#   ppc-morphos-gcc = GCC 15 cross-compiler, runs on Linux, targets MorphOS PPC.
#   Output: build-morphos/mosnode  (ELF 32-bit MSB PowerPC, needs ixemul.library)
#
# TLS is enabled: static OpenSSL (libssl.a/libcrypto.a from the SDK) is linked in,
# so the binary is self-contained (no AmiSSL / runtime library needed).
set -e
export PATH="$HOME/.morphos-cross/current/bin:$PATH"
cd "$(dirname "$0")"
OUT=build-morphos
QJS=../quickjs-ng
mkdir -p "$OUT"
GCC=ppc-morphos-gcc
# Static OpenSSL for MorphOS lives in the full SDK tree; copy into toolchain lib if absent.
GGLIB="$HOME/Projects/morphos_sdk/tree/Development/gg/ppc-morphos/lib"
TCLIB="$HOME/.morphos-cross/current/ppc-morphos/lib"
for L in libssl.a libcrypto.a; do [ -f "$TCLIB/$L" ] || cp "$GGLIB/$L" "$TCLIB/"; done

# CRITICAL: gcc-15 at -O2 MISCOMPILES QuickJS on PowerPC (corrupts the GC/atom
# refcounting -> js_get_atom_index crash on the network path, list_empty assert
# at teardown). -O1 + -fno-strict-aliasing + -fwrapv produces correct code:
# the full HTTPS path to api.anthropic.com works (verified: 401 + response body +
# clean exit). native.c uses JS_VALUE_GET_TAG (NaN-boxing-agnostic), so we let
# JS_NAN_BOXING default (=1 on 32-bit, QuickJS's tested 32-bit path).
CF="-O1 -fno-strict-aliasing -fwrapv -fno-delete-null-pointer-checks -DQUICKJS_NG_BUILD -D_GNU_SOURCE -std=gnu11"

echo "[1/4] libqjs.a (quickjs engine)"
for f in quickjs libregexp libunicode dtoa; do
  $GCC $CF -I"$QJS" -c "$QJS/$f.c" -o "$OUT/$f.o"
done
ppc-morphos-ar rcs "$OUT/libqjs.a" "$OUT/quickjs.o" "$OUT/libregexp.o" "$OUT/libunicode.o" "$OUT/dtoa.o"

echo "[1b/4] libwasm3.a (wasm3 interpreter — WebAssembly for Ink/Yoga + llhttp)"
# wasm3 is big-endian-correct (verified on the MorphOS PPC box). Keep -O1 like QuickJS.
W3=vendor-src/wasm3
W3CF="-O1 -fno-strict-aliasing -fwrapv -std=gnu11 -I$W3"
w3objs=""
for f in m3_core m3_env m3_module m3_parse m3_compile m3_exec m3_function m3_code m3_bind m3_info m3_validate m3_xxh64; do
  $GCC $W3CF -c "$W3/$f.c" -o "$OUT/$f.o"
  w3objs="$w3objs $OUT/$f.o"
done
ppc-morphos-ar rcs "$OUT/libwasm3.a" $w3objs

echo "[2/4] main.c"
$GCC $CF -I"$QJS" -Isrc -c src/main.c -o "$OUT/main.o"
echo "[3/4] native.c"
$GCC $CF -I"$QJS" -Isrc -Ivendor-src/wasm3 -c src/native.c -o "$OUT/native.o"
# amiga_run.c: the only file that includes Amiga headers (SystemTags helper).
$GCC $CF -c src/amiga_run.c -o "$OUT/amiga_run.o"

echo "[4/4] link"
$GCC -o "$OUT/mosnode" "$OUT/main.o" "$OUT/native.o" "$OUT/amiga_run.o" "$OUT/libqjs.a" "$OUT/libwasm3.a" -lssl -lcrypto -lpthread -lm
ppc-morphos-strip -o "$OUT/mosnode_s" "$OUT/mosnode"
file "$OUT/mosnode"
ls -la "$OUT/mosnode" "$OUT/mosnode_s"
echo "OK -> $OUT/mosnode (debug) and $OUT/mosnode_s (stripped)"
