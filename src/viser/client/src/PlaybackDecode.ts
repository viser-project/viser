/**
 * Decode logic for `.viser` recordings and embedded base64 scene payloads.
 *
 * Kept free of UI imports so it can be unit-tested directly; FilePlayback.tsx
 * owns the playback interface built on top of these.
 */
import * as msgpack from "@msgpack/msgpack";
import { ZSTDDecoder } from "zstddec";
import {
  replaceBinaryPlaceholders,
  computeBinaryOffsets,
} from "./BinaryMessageDecode";
import { Message } from "./WebsocketMessages";

// Initialize zstd decoder at module load.
const zstdDecoder = new ZSTDDecoder();
const zstdReady = zstdDecoder.init();

export interface SerializedMessages {
  durationSeconds: number;
  messages: [number, Message][]; // (time in seconds, message).
  viserVersion: string;
}

/**
 * Decompress and decode a hybrid-format payload.
 *
 * Decompressed layout:
 *   [8 bytes] msgpack length (little-endian uint64)
 *   [N bytes] msgpack payload (with binary placeholders)
 *   [P bytes] padding + aligned binary buffers
 *
 * Binary placeholders are replaced with properly typed array views.
 */
function decodeHybridPayload<T>(decompressed: Uint8Array): T {
  const buf = decompressed.buffer as ArrayBuffer;
  const base = decompressed.byteOffset;

  // Read msgpack length from inner header.
  const msgpackLength = Number(
    new DataView(buf, base, 8).getBigUint64(0, true),
  );

  // Decode msgpack.
  const msgpackData = new Uint8Array(buf, base + 8, msgpackLength);
  const data = msgpack.decode(msgpackData) as T & {
    binaryBufferLengths?: number[];
  };

  // Replace binary placeholders with typed array views.
  const bufferLengths = data.binaryBufferLengths;
  if (bufferLengths && bufferLengths.length > 0) {
    const binaryOffsets = computeBinaryOffsets(
      bufferLengths,
      base + 8 + msgpackLength,
    );
    replaceBinaryPlaceholders(data, buf, binaryOffsets, bufferLengths);
  }

  return data;
}

/** Read the 8-byte decompressed-size header, decompress the remaining zstd
 * payload, and decode it. Shared by the file-download and embedded-base64
 * entry points. */
export async function decompressAndDecodeHybridPayload<T>(
  bytes: Uint8Array,
): Promise<T> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decompressedSize = Number(view.getBigUint64(0, true));
  // subarray (not slice): the decoder copies into WASM memory itself, so a
  // view avoids duplicating the whole compressed payload first.
  const compressedData = bytes.subarray(8);

  await zstdReady;
  const decompressed = zstdDecoder.decode(compressedData, decompressedSize);
  return decodeHybridPayload<T>(decompressed);
}

/** Download, decompress, and deserialize a .viser recording file. */
export async function deserializeZstdMsgpackFile<T>(
  fileUrl: string,
  setStatus: (status: { downloaded: number; total: number }) => void,
): Promise<T> {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch the file: ${response.statusText}`);
  }

  const totalLength = parseInt(response.headers.get("Content-Length")!);
  setStatus({ downloaded: 0, total: totalLength });

  // Stream the download to track progress.
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let downloadedLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloadedLength += value.length;
    setStatus({ downloaded: downloadedLength, total: totalLength });
  }

  // Concatenate chunks into a single buffer.
  const bytes = new Uint8Array(downloadedLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return decompressAndDecodeHybridPayload<T>(bytes);
}

/** Decode base64 into bytes. Prefers the native `Uint8Array.fromBase64`
 * (Chrome/Firefox/Safari 2024+), then a `data:` URL fetch, which also decodes
 * natively; the `atob` + `charCodeAt` loop runs character-by-character in JS
 * and is an order of magnitude slower on multi-megabyte embeds, so it's only
 * a last-resort fallback. */
export async function base64ToBytes(base64Data: string): Promise<Uint8Array> {
  const fromBase64 = (
    Uint8Array as unknown as { fromBase64?: (data: string) => Uint8Array }
  ).fromBase64;
  if (fromBase64 !== undefined) return fromBase64(base64Data);
  try {
    const response = await fetch(
      "data:application/octet-stream;base64," + base64Data,
    );
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }
}

/** Deserialize embedded base64-encoded zstd-compressed data.
 * Used for static embedding in HTML pages (e.g., myst-nb documentation). */
export async function deserializeEmbeddedData<T>(
  base64Data: string,
  setStatus: (status: { downloaded: number; total: number }) => void,
): Promise<T> {
  const bytes = await base64ToBytes(base64Data);

  // Data is already embedded, so mark download as complete.
  setStatus({ downloaded: 1.0, total: 1.0 });

  return decompressAndDecodeHybridPayload<T>(bytes);
}
