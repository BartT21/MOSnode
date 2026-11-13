// node:path/posix — re-export of the posix path impl (the only one we have).
import path, {
  sep, delimiter, normalize, isAbsolute, join, resolve, relative,
  dirname, basename, extname, parse, format,
} from "../path.js";

export {
  sep, delimiter, normalize, isAbsolute, join, resolve, relative,
  dirname, basename, extname, parse, format,
};
export const toNamespacedPath = (p) => p;
export const posix = path;
export const win32 = path;
export default path;
