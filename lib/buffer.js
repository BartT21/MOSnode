import b from "./_vendor/buffer.js";
const B = b.Buffer ?? b;
export default B;
export const Buffer = B;
export const SlowBuffer = b.SlowBuffer;
export const INSPECT_MAX_BYTES = b.INSPECT_MAX_BYTES;
export const kMaxLength = b.kMaxLength;
