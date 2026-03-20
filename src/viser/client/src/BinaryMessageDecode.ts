/**
 * Shared decode logic for the hybrid binary message format.
 *
 * Used by both the WebSocket worker (live messages) and FilePlayback (recordings).
 *
 * Binary arrays in the msgpack payload are replaced with tagged placeholder
 * objects: `{"__binary_index": i, "dtype": "<f4"}`. This module reconstructs
 * them as typed array views into the provided ArrayBuffer.
 */

// Dtype string (numpy convention) to TypedArray constructor mapping.
const DTYPE_CONSTRUCTORS: {
  [key: string]: {
    ctor: new (
      buffer: ArrayBuffer,
      byteOffset: number,
      length: number,
    ) => ArrayBufferView;
    bytes: number;
  };
} = {
  "<f2": { ctor: Uint16Array, bytes: 2 }, // float16: stored as Uint16 (no native Float16Array)
  "<f4": { ctor: Float32Array, bytes: 4 },
  "<f8": { ctor: Float64Array, bytes: 8 },
  "|u1": { ctor: Uint8Array, bytes: 1 },
  "<u2": { ctor: Uint16Array, bytes: 2 },
  "<u4": { ctor: Uint32Array, bytes: 4 },
  "|i1": { ctor: Int8Array, bytes: 1 },
  "<i2": { ctor: Int16Array, bytes: 2 },
  "<i4": { ctor: Int32Array, bytes: 4 },
};

/**
 * Replace tagged placeholder objects in a decoded message with typed array
 * views into the binary section of an ArrayBuffer.
 *
 * @param obj - The decoded msgpack object to walk (mutated in place).
 * @param buffer - The ArrayBuffer containing the binary data.
 * @param binaryOffsets - Byte offset of each binary buffer within `buffer`.
 * @param bufferLengths - Byte length of each binary buffer.
 */
export function replaceBinaryPlaceholders(
  obj: any,
  buffer: ArrayBuffer,
  binaryOffsets: number[],
  bufferLengths: number[],
): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = replaceBinaryPlaceholders(
        obj[i],
        buffer,
        binaryOffsets,
        bufferLengths,
      );
    }
    return obj;
  }
  if (typeof obj === "object" && !ArrayBuffer.isView(obj)) {
    // Check for binary placeholder tag.
    if ("__binary_index" in obj && "dtype" in obj) {
      const idx: number = obj.__binary_index;
      const dtype: string = obj.dtype;
      const offset = binaryOffsets[idx];
      const byteLength = bufferLengths[idx];

      const dtypeInfo = DTYPE_CONSTRUCTORS[dtype];
      if (dtypeInfo) {
        return new dtypeInfo.ctor(buffer, offset, byteLength / dtypeInfo.bytes);
      }
      // Fallback: return raw Uint8Array view.
      return new Uint8Array(buffer, offset, byteLength);
    }

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        obj[key] = replaceBinaryPlaceholders(
          obj[key],
          buffer,
          binaryOffsets,
          bufferLengths,
        );
      }
    }
    return obj;
  }
  return obj;
}

/**
 * Compute binary buffer offsets from their lengths, starting from a base offset,
 * respecting 8-byte alignment.
 */
export function computeBinaryOffsets(
  bufferLengths: number[],
  baseOffset: number,
): number[] {
  const offsets: number[] = [];
  let offset = baseOffset;
  for (const length of bufferLengths) {
    const padding = (8 - (offset % 8)) % 8;
    offset += padding;
    offsets.push(offset);
    offset += length;
  }
  return offsets;
}
