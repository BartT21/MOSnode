// node:events — vendored Node events.js
import events from "./_vendor/events.js";

export default events;
export const EventEmitter = events;
export const captureRejectionSymbol = Symbol.for("node.captureRejectionSymbol");
export const errorMonitor = Symbol("events.errorMonitor");
export const usingDomains = false;
export { events };

// Static helpers (node:events named exports).
export const once = events.once || function once(emitter, name, options) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      emitter.removeListener(name, onEvent);
      if (name !== "error") emitter.removeListener("error", onError);
    };
    const onEvent = (...args) => { cleanup(); resolve(args); };
    const onError = (err) => { cleanup(); reject(err); };
    emitter.on(name, onEvent);
    if (name !== "error") emitter.on("error", onError);
  });
};

export function setMaxListeners(n = 10, ...emitters) {
  for (const e of emitters) if (e && typeof e.setMaxListeners === "function") e.setMaxListeners(n);
}

export function getEventListeners(emitter, name) {
  return typeof emitter.listeners === "function" ? emitter.listeners(name) : [];
}

export function getMaxListeners(emitter) {
  return typeof emitter.getMaxListeners === "function" ? emitter.getMaxListeners() : 10;
}

export function on(emitter, event, options) {
  const queue = [];
  let waiting = null, done = false, error = null;
  const push = (...args) => { if (waiting) { const w = waiting; waiting = null; w({ value: args, done: false }); } else queue.push(args); };
  const onErr = (e) => { error = e; if (waiting) { const w = waiting; waiting = null; w(Promise.reject(e)); } };
  emitter.on(event, push);
  emitter.on("error", onErr);
  return {
    next() {
      if (error) return Promise.reject(error);
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { waiting = resolve; });
    },
    return() { done = true; emitter.removeListener(event, push); emitter.removeListener("error", onErr); return Promise.resolve({ value: undefined, done: true }); },
    [Symbol.asyncIterator]() { return this; },
  };
}

export const addAbortListener = (signal, listener) => {
  if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", listener, { once: true });
  return { [Symbol.dispose]() {} };
};
