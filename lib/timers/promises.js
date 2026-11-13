export const setTimeout = (ms, value) => new Promise((r) => globalThis.setTimeout(() => r(value), ms));
export const setImmediate = (value) => new Promise((r) => globalThis.setImmediate(() => r(value)));
export const setInterval = () => { throw new Error("timers.promises.setInterval not supported"); };
export default { setTimeout, setImmediate, setInterval };
