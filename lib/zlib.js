// node:zlib — pako-backed
import * as pako from "./_vendor/pako.js";
import { Transform, PassThrough } from "./stream.js";
import { Buffer } from "./buffer.js";

function run(mode, data, opts) {
  const f = { deflate: pako.deflate, inflate: pako.inflate,
    gzip: pako.gzip, gunzip: pako.ungzip,
    deflateRaw: pako.deflateRaw, inflateRaw: pako.inflateRaw }[mode];
  const out = f(data, opts);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength); // Node returns Buffer
}
export const deflateSync = (d, o) => run("deflate", d, o);
export const inflateSync = (d, o) => run("inflate", d, o);
export const gzipSync = (d, o) => run("gzip", d, o);
export const gunzipSync = (d, o) => run("gunzip", d, o);
export const deflateRawSync = (d, o) => run("deflateRaw", d, o);
export const inflateRawSync = (d, o) => run("inflateRaw", d, o);
export const unzipSync = gunzipSync;

function modeClass(mode) {
  return class extends Transform {
    constructor(opts = {}) {
      super();
      this._mode = mode;
      this._chunks = [];
      this._ended = false;
    }
    _transform(chunk, enc, cb) { this._chunks.push(Buffer.from(chunk)); cb(null); }
    _flush(cb) {
      try {
        const data = Buffer.concat(this._chunks);
        this.push(run(this._mode, data));
        cb();
      } catch (e) { cb(e); }
    }
  };
}
export const Deflate = modeClass("deflate");
export const Inflate = modeClass("inflate");
export const Gzip = modeClass("gzip");
export const Gunzip = modeClass("gunzip");
export const DeflateRaw = modeClass("deflateRaw");
export const InflateRaw = modeClass("inflateRaw");
export const Unzip = Gunzip;
export const createDeflate = () => new Deflate();
export const createInflate = () => new Inflate();
export const createGzip = () => new Gzip();
export const createGunzip = () => new Gunzip();
export const createDeflateRaw = () => new DeflateRaw();
export const createInflateRaw = () => new InflateRaw();
export const createUnzip = () => new Unzip();
export const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
  Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_MEMLEVEL: 8, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_CHUNK: 16384, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity,
  Z_MIN_LEVEL: -1, Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1,
  DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
  BROTLI_DECODE: 8, BROTLI_ENCODE: 9,
  BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0, BROTLI_PARAM_QUALITY: 1, BROTLI_PARAM_LGWIN: 2,
  BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_DEFAULT_WINDOW: 22,
};
// Also expose each constant at the top level (Node does both).
export const Z_NO_FLUSH = 0, Z_SYNC_FLUSH = 2, Z_FINISH = 4, Z_NO_COMPRESSION = 0,
  Z_BEST_SPEED = 1, Z_BEST_COMPRESSION = 9, Z_DEFAULT_COMPRESSION = -1;

export function crc32(b) { return pako.crc32 ? pako.crc32(b) : 0; }
export const brotliCompressSync = () => { throw new Error("brotli not available"); };
export const brotliDecompressSync = brotliCompressSync;
export const createBrotliCompress = () => { throw new Error("brotli not available"); };
export const createBrotliDecompress = () => { throw new Error("brotli not available"); };
export function brotliCompress(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(new Error("brotli not available"))); }
export function brotliDecompress(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(new Error("brotli not available"))); }
export function deflate(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, deflateSync(d))).catch(e => cb(e)); }
export function inflate(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, inflateSync(d))).catch(e => cb(e)); }
export function deflateRaw(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, deflateRawSync(d))).catch(e => cb(e)); }
export function inflateRaw(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, inflateRawSync(d))).catch(e => cb(e)); }
export function gzip(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, gzipSync(d))).catch(e => cb(e)); }
export function gunzip(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, gunzipSync(d))).catch(e => cb(e)); }
export function unzip(d, o, cb) { cb ||= o; Promise.resolve().then(() => cb(null, unzipSync(d))).catch(e => cb(e)); }

export default {
  constants,
  deflateSync, inflateSync, gzipSync, gunzipSync, deflateRawSync, inflateRawSync, unzipSync,
  deflate, inflate, deflateRaw, inflateRaw, gzip, gunzip, unzip,
  createGzip, createGunzip, createDeflate, createInflate, createDeflateRaw, createInflateRaw, createUnzip,
  createBrotliCompress, createBrotliDecompress,
  brotliCompressSync, brotliDecompressSync, brotliCompress, brotliDecompress,
  Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip, crc32,
  Z_SYNC_FLUSH, Z_NO_FLUSH, Z_FINISH,
};
