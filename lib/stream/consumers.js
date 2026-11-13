// node:stream/consumers — collect a stream (or async iterable) into a value.
import { Buffer } from "../buffer.js";

async function collect(stream) {
  const chunks = [];
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  } else if (stream && typeof stream.on === "function") {
    await new Promise((resolve, reject) => {
      stream.on("data", (c) => chunks.push(typeof c === "string" ? Buffer.from(c) : Buffer.from(c)));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  } else {
    throw new TypeError("Expected a stream or async iterable");
  }
  return Buffer.concat(chunks);
}

export async function buffer(stream) { return collect(stream); }
export async function text(stream) { return (await collect(stream)).toString("utf8"); }
export async function json(stream) { return JSON.parse(await text(stream)); }
export async function arrayBuffer(stream) {
  const b = await collect(stream);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
export async function blob(stream) {
  const b = await collect(stream);
  if (typeof Blob !== "undefined") return new Blob([b]);
  return b; // no Blob global: fall back to Buffer
}

export default { buffer, text, json, arrayBuffer, blob };
