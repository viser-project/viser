import * as msgpack from "@msgpack/msgpack";
import { Message } from "./WebsocketMessages";
import AwaitLock from "await-lock";
import { VISER_VERSION } from "./VersionInfo";
import { ZSTDDecoder } from "zstddec";

// Initialize zstd decoder at module load.
const zstdDecoder = new ZSTDDecoder();
const zstdReady = zstdDecoder.init();

export type WsWorkerIncoming =
  | { type: "send"; message: Message }
  | { type: "set_server"; server: string }
  | { type: "retry" }
  | { type: "close" };

export type WsWorkerOutgoing =
  | { type: "connected" }
  | {
      type: "closed";
      versionMismatch?: boolean;
      clientVersion?: string;
      closeReason?: string;
    }
  | { type: "message_batch"; messages: Message[] };

import {
  replaceBinaryPlaceholders,
  computeBinaryOffsets,
} from "./BinaryMessageDecode";

type SerializedStruct = {
  messages: Message[];
  timestampSec: number;
  binaryBufferLengths?: number[];
};

/**
 * Decode a hybrid wire format message: zstd-compressed msgpack metadata,
 * followed by raw (uncompressed) aligned binary buffers.
 *
 * Wire format:
 *   [8 bytes] decompressed size of msgpack (little-endian uint64)
 *   [8 bytes] compressed size of msgpack (little-endian uint64)
 *   [N bytes] zstd-compressed msgpack payload
 *   [P bytes] padding to 8-byte alignment
 *   [M bytes] concatenated binary buffers (each 8-byte aligned)
 *
 * Binary arrays in the msgpack are replaced with tagged placeholder objects.
 * These are reconstructed as typed array views directly into the WebSocket's
 * ArrayBuffer — zero-copy for the binary array data.
 */
function decodeHybridMessage(
  buffer: ArrayBuffer,
  zstdDecoder: { decode: (data: Uint8Array, size: number) => Uint8Array },
): SerializedStruct & { buffer: ArrayBuffer } {
  const headerView = new DataView(buffer);
  const decompressedSize = Number(headerView.getBigUint64(0, true));
  const compressedSize = Number(headerView.getBigUint64(8, true));

  // Decompress msgpack portion only. Binary data is raw/uncompressed.
  const compressedData = new Uint8Array(buffer, 16, compressedSize);
  const decompressed = zstdDecoder.decode(compressedData, decompressedSize);
  const data = msgpack.decode(decompressed) as SerializedStruct;

  // Attach the raw buffer for postMessage transfer semantics.
  // Mutate instead of spreading ({ ...data, buffer }) to avoid an extra
  // object allocation on every incoming message.
  const result = data as SerializedStruct & { buffer: ArrayBuffer };
  result.buffer = buffer;

  // If no binary buffers, return as-is. Message had no arrays.
  const bufferLengths = data.binaryBufferLengths;
  if (!bufferLengths || bufferLengths.length === 0) {
    return result;
  }

  // Compute binary section offsets and replace placeholders with typed array views.
  const binaryOffsets = computeBinaryOffsets(bufferLengths, 16 + compressedSize);
  for (const message of data.messages) {
    replaceBinaryPlaceholders(message, buffer, binaryOffsets, bufferLengths);
  }

  return result;
}


{
  let server: string | null = null;
  let ws: WebSocket | null = null;
  const orderLock = new AwaitLock();

  const postOutgoing = (
    data: WsWorkerOutgoing,
    transferable?: Transferable[],
  ) => {
    // @ts-ignore
    self.postMessage(data, transferable);
  };

  const tryConnect = () => {
    if (ws !== null) ws.close();

    // Use a single protocol that includes both client identification and version.
    const protocol = `viser-v${VISER_VERSION}`;
    console.log(`Connecting to: ${server!} with protocol: ${protocol}`);
    ws = new WebSocket(server!, [protocol]);
    ws.binaryType = "arraybuffer";

    // Timeout is necessary when we're connecting to an SSH/tunneled port.
    const retryTimeout = setTimeout(() => {
      ws?.close();
    }, 5000);

    ws.onopen = () => {
      clearTimeout(retryTimeout);
      console.log(`Connected! ${server}`);

      // Just indicate that we're connected.
      postOutgoing({
        type: "connected",
      });
    };

    ws.onclose = (event) => {
      // Check for explicit close (code 1002 = protocol error, which we use for version mismatch).
      const versionMismatch = event.code === 1002;

      // Send close notification.
      postOutgoing({
        type: "closed",
        versionMismatch: versionMismatch,
        clientVersion: VISER_VERSION,
        closeReason: event.reason || "Connection closed",
      });

      console.log(
        `Disconnected! ${server} code=${event.code}, reason: ${event.reason}`,
      );

      if (versionMismatch) {
        console.warn(
          `Connection rejected due to version mismatch. Client version: ${VISER_VERSION}`,
        );
      }

      clearTimeout(retryTimeout);
    };

    // State for tracking message timing.
    const state: {
      prevPythonTimestampMs?: number;
      lastIdealJsMs?: number;
      jsTimeMinusPythonTime: number;
    } = { jsTimeMinusPythonTime: Infinity };
    ws.onmessage = async (event) => {
      const dataPromise = (async () => {
        // binaryType="arraybuffer" ensures event.data is an ArrayBuffer directly
        // (skips the default Blob->ArrayBuffer async conversion).
        const buffer = event.data as ArrayBuffer;
        await zstdReady;
        return decodeHybridMessage(buffer, zstdDecoder);
      })();

      // Try our best to handle messages in order. If this takes more than 10 seconds, we give up. :)
      const jsReceivedMs = performance.now();
      await orderLock.acquireAsync({ timeout: 10000 }).catch(() => {
        console.log("Order lock timed out.");
        orderLock.release();
      });
      const data = await dataPromise;

      // Compute offset between JavaScript and Python time.
      state.jsTimeMinusPythonTime = Math.min(
        jsReceivedMs - data.timestampSec * 1000,
        state.jsTimeMinusPythonTime,
      );

      // Function to send the message and release the order lock.
      const messages = data.messages;
      // All typed array views point into the original WebSocket ArrayBuffer.
      // Transfer just that buffer instead of walking the entire message tree.
      const sendFn = () => {
        postOutgoing(
          { type: "message_batch", messages: messages },
          [data.buffer],
        );
        orderLock.release();
      };

      // Calculate timing deltas between Python and JavaScript.
      const jsNowMs = performance.now();
      const currentPythonTimestampMs = data.timestampSec * 1000;
      const pythonTimeDeltaMs =
        currentPythonTimestampMs -
        (state.prevPythonTimestampMs ?? currentPythonTimestampMs);
      state.prevPythonTimestampMs = currentPythonTimestampMs;

      if (
        // Flush immediately for first message.
        state.lastIdealJsMs === undefined ||
        // Flush immediately if the Python delta is large, in this case we're
        // probably not sensitive to exact timing.
        pythonTimeDeltaMs > 100 ||
        // Flush if we're more than 100ms behind real-time.
        jsNowMs - state.jsTimeMinusPythonTime - currentPythonTimestampMs > 100
      ) {
        // First message or no expected delta, send immediately.
        sendFn();
        state.lastIdealJsMs = jsNowMs;
      } else {
        // For messages that are being sent frequently: smooth out the sending rate.
        const idealNextSendTimeMs = state.lastIdealJsMs + pythonTimeDeltaMs;
        const timeUntilIdealJsMs = idealNextSendTimeMs - jsNowMs;

        if (timeUntilIdealJsMs > 3) {
          // We're early! This means the previous message was processed late...
          const dampingFactor = 0.95;
          setTimeout(sendFn, timeUntilIdealJsMs * dampingFactor);
          state.lastIdealJsMs =
            state.lastIdealJsMs + pythonTimeDeltaMs * dampingFactor;
        } else {
          // Message is on-time or late: send immediately.
          sendFn();
          state.lastIdealJsMs = jsNowMs;
        }
      }
    };
  };

  self.onmessage = (e) => {
    const data: WsWorkerIncoming = e.data;

    if (data.type === "send") {
      ws!.send(msgpack.encode(data.message));
    } else if (data.type === "set_server") {
      server = data.server;
      tryConnect();
    } else if (data.type === "retry") {
      if (server !== null) {
        tryConnect();
      }
    } else if (data.type === "close") {
      server = null;
      ws !== null && ws.close();
      self.close();
    } else {
      console.log(
        `WebSocket worker: got ${data}, not sure what to do with it!`,
      );
    }
  };
}
