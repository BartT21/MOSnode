// node:perf_hooks — performance timing. Backed by the runtime clock.
import * as N from "native";

const timeOrigin = (typeof N.timeOrigin === "number" ? N.timeOrigin : Date.now());

function now() {
  if (typeof globalThis.performance?.now === "function") return globalThis.performance.now();
  if (typeof N.now === "function") return N.now();
  return Date.now() - timeOrigin;
}

const _marks = new Map();
const _entries = [];

export const performance = globalThis.performance && typeof globalThis.performance.now === "function"
  ? globalThis.performance
  : {
      now,
      timeOrigin,
      mark(name) { const e = { name, entryType: "mark", startTime: now(), duration: 0 }; _marks.set(name, e); _entries.push(e); return e; },
      measure(name, startMark, endMark) {
        const s = typeof startMark === "string" ? (_marks.get(startMark)?.startTime ?? 0) : (startMark ?? 0);
        const en = typeof endMark === "string" ? (_marks.get(endMark)?.startTime ?? now()) : (endMark ?? now());
        const e = { name, entryType: "measure", startTime: s, duration: en - s }; _entries.push(e); return e;
      },
      clearMarks(name) { if (name) _marks.delete(name); else _marks.clear(); },
      clearMeasures() {},
      getEntries() { return _entries.slice(); },
      getEntriesByName(name) { return _entries.filter((e) => e.name === name); },
      getEntriesByType(type) { return _entries.filter((e) => e.entryType === type); },
      eventLoopUtilization() { return { idle: 0, active: 0, utilization: 0 }; },
      nodeTiming: { name: "node", startTime: 0, duration: 0 },
    };

export class PerformanceObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}
PerformanceObserver.supportedEntryTypes = ["mark", "measure"];

export class PerformanceEntry {
  constructor(name, entryType, startTime, duration) { this.name = name; this.entryType = entryType; this.startTime = startTime; this.duration = duration; }
}

export function monitorEventLoopDelay() {
  return {
    enable() {}, disable() {}, reset() {},
    min: 0, max: 0, mean: 0, stddev: 0, percentile() { return 0; }, percentiles: new Map(),
    exceeds: 0,
  };
}

export function createHistogram() {
  return { min: 0, max: 0, mean: 0, stddev: 0, count: 0, record() {}, recordDelta() {}, reset() {}, percentile() { return 0; }, percentiles: new Map() };
}

export const constants = {
  NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16,
};

export default { performance, PerformanceObserver, PerformanceEntry, monitorEventLoopDelay, createHistogram, constants };
