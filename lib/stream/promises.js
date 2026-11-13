import { pipeline as _p, finished as _f } from "../stream.js";
export function pipeline(...args) {
  return new Promise((resolve, reject) => {
    const cb = (err, v) => err ? reject(err) : resolve(v);
    _p(...args, cb);
  });
}
export const finished = (stream, opts) => new Promise((resolve, reject) =>
  _f(stream, opts, (err) => err ? reject(err) : resolve()));
export default { pipeline, finished };
