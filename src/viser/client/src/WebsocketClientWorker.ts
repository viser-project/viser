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

// Helper function to collect all ArrayBuffer objects. This is used for postMessage() move semantics.
function collectArrayBuffers(obj: any, buffers: Set<ArrayBufferLike>) {
  if (obj instanceof ArrayBuffer) {
    buffers.add(obj);
  } else if (obj instanceof Uint8Array) {
    buffers.add(obj.buffer);
  } else if (obj && typeof obj === "object") {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        collectArrayBuffers(obj[key], buffers);
      }
    }
  }
  return buffers;
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
    type SerializedStruct = {
      messages: Message[];
      timestampSec: number;
    };

    ws.onmessage = async (event) => {
      const dataPromise = (async () => {
        const buffer = await (event.data.arrayBuffer() as Promise<ArrayBuffer>);
        const bytes = new Uint8Array(buffer);

        // Read decompressed size from 8-byte little-endian header.
        const view = new DataView(buffer);
        const decompressedSize = Number(view.getBigUint64(0, true));
        const compressedData = bytes.slice(8);

        // Decompress and decode.
        await zstdReady;
        const decompressed = zstdDecoder.decode(
          compressedData,
          decompressedSize,
        );
        return msgpack.decode(decompressed) as SerializedStruct;
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
      const arrayBuffers = collectArrayBuffers(messages, new Set());
      const sendFn = () => {
        postOutgoing(
          { type: "message_batch", messages: messages },
          Array.from(arrayBuffers),
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
