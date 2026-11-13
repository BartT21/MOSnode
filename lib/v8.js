// node:v8 — heap statistics and (de)serialization. QuickJS is not V8, so heap
// numbers come from the runtime's own memory accounting and are approximate.
import * as N from "native";
import { Readable } from "./stream.js";
import { Buffer } from "./buffer.js";

function mem() {
  try { return N.memoryUsage(); } catch { return {}; }
}

export function getHeapStatistics() {
  const m = mem();
  const used = m.heapUsed || 0;
  const total = m.heapTotal || used;
  return {
    total_heap_size: total,
    total_heap_size_executable: 0,
    total_physical_size: m.rss || total,
    total_available_size: 0,
    used_heap_size: used,
    heap_size_limit: 2 * 1024 * 1024 * 1024,
    malloced_memory: m.external || 0,
    peak_malloced_memory: m.external || 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: m.external || 0,
  };
}

export function getHeapSpaceStatistics() {
  const s = getHeapStatistics();
  return [{
    space_name: "new_space",
    space_size: s.total_heap_size,
    space_used_size: s.used_heap_size,
    space_available_size: 0,
    physical_space_size: s.total_physical_size,
  }];
}

export function getHeapSnapshot() {
  // A real heap snapshot isn't available; return an empty-but-valid stream.
  const r = new Readable({ read() {} });
  process.nextTick(() => { r.push("{}"); r.push(null); });
  return r;
}

export function getHeapCodeStatistics() {
  return { code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 };
}

export function setFlagsFromString() {}
export function cachedDataVersionTag() { return 0; }

// Structured (de)serialization — JSON-based, sufficient for plain data.
export function serialize(value) {
  return Buffer.from(JSON.stringify(value) ?? "null", "utf8");
}
export function deserialize(buf) {
  return JSON.parse(Buffer.from(buf).toString("utf8"));
}

export class Serializer {
  constructor() { this._v = undefined; }
  writeHeader() {}
  writeValue(v) { this._v = v; }
  releaseBuffer() { return serialize(this._v); }
  writeUint32() {} writeUint64() {} writeDouble() {} writeRawBytes() {}
  _setTreatArrayBufferViewsAsHostObjects() {}
}
export class Deserializer {
  constructor(buf) { this._buf = buf; }
  readHeader() { return true; }
  readValue() { return deserialize(this._buf); }
  readUint32() { return 0; } readUint64() { return 0; } readDouble() { return 0; } readRawBytes() { return Buffer.alloc(0); }
}
export class DefaultSerializer extends Serializer {}
export class DefaultDeserializer extends Deserializer {}

export const promiseHooks = {
  createHook() { return () => {}; },
  onInit() { return () => {}; }, onSettled() { return () => {}; },
  onBefore() { return () => {}; }, onAfter() { return () => {}; },
};

export default {
  getHeapStatistics, getHeapSpaceStatistics, getHeapSnapshot, getHeapCodeStatistics,
  setFlagsFromString, cachedDataVersionTag, serialize, deserialize,
  Serializer, Deserializer, DefaultSerializer, DefaultDeserializer, promiseHooks,
};
