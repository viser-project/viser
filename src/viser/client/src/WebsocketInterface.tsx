import WebsocketClientWorker from "./WebsocketClientWorker?worker&inline";
import React, { useContext } from "react";
import { notifications } from "@mantine/notifications";

import { ViewerContext } from "./ViewerContext";
import { syncSearchParamServer } from "./SearchParamsUtils";
import { WsWorkerIncoming, WsWorkerOutgoing } from "./WebsocketClientWorker";

/** Component for handling websocket connections. */
export function WebsocketMessageProducer() {
  const viewer = useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current;
  const server = viewer.useGui((state) => state.server);
  const resetGui = viewer.guiActions.resetGui;
  const resetScene = viewer.sceneTreeActions.resetScene;

  syncSearchParamServer(server);

  React.useEffect(() => {
    const worker = new WebsocketClientWorker();
    let isConnected = false;
    let retryIntervalId: ReturnType<typeof setInterval> | null = null;

    function postToWorker(data: WsWorkerIncoming) {
      worker.postMessage(data);
    }

    // Start or stop the retry interval based on connection state and page focus.
    function updateRetryInterval() {
      const shouldRetry = !isConnected && document.hasFocus();
      if (!isConnected) {
        viewer.useGui.set({
          websocketState: shouldRetry ? "reconnecting" : "inactive",
        });
      }

      if (shouldRetry && retryIntervalId === null) {
        // Retry immediately, then every second.
        postToWorker({ type: "retry" });
        retryIntervalId = setInterval(() => {
          postToWorker({ type: "retry" });
        }, 1000);
      } else if (!shouldRetry && retryIntervalId !== null) {
        clearInterval(retryIntervalId);
        retryIntervalId = null;
      }
    }

    // Listen for focus changes.
    window.addEventListener("focus", updateRetryInterval);
    window.addEventListener("blur", updateRetryInterval);

    worker.onmessage = (event) => {
      const data: WsWorkerOutgoing = event.data;
      if (data.type === "connected") {
        isConnected = true;
        resetGui();
        resetScene();
        // Drop any messages left over from the previous connection and re-arm
        // the first-batch ordering hack, so the server's fresh scene replay
        // applies against clean state. The worker/ref persist across reconnects,
        // so this transient state isn't reset for us.
        viewerMutable.messageQueue.length = 0;
        viewerMutable.firstMessageBatch = true;
        // Skinned-mesh pose buffers are keyed by node name on the mutable ref,
        // which persists across reconnects; drop them so they don't leak (and
        // so stale bone state doesn't apply to the fresh scene).
        for (const key of Object.keys(viewerMutable.skinnedMeshState)) {
          delete viewerMutable.skinnedMeshState[key];
        }
        // Clear any render request left in flight from the previous connection.
        // Message handling is gated on this being "ready", and a stale request
        // would otherwise render once against the fresh scene (its response is
        // dropped via render_uuid mismatch anyway).
        viewerMutable.getRenderRequestState = "ready";
        viewerMutable.getRenderRequest = null;
        viewer.useGui.set({ websocketState: "connected" });
        updateRetryInterval();
        viewerMutable.sendMessage = (message) => {
          postToWorker({ type: "send", message });
        };
      } else if (data.type === "closed") {
        isConnected = false;
        resetGui();
        updateRetryInterval();
        viewerMutable.sendMessage = (message) => {
          console.log(
            `Tried to send ${message.type} but websocket is not connected!`,
          );
        };

        // Show notification for version mismatch.
        if (data.versionMismatch) {
          notifications.show({
            id: "version-mismatch",
            title: "Connection rejected",
            message: `${data.closeReason}.`,
            color: "red",
            autoClose: 5000,
            withCloseButton: true,
          });
        }
      } else if (data.type === "message_batch") {
        viewerMutable.messageQueue.push(...data.messages);
      }
    };
    postToWorker({ type: "set_server", server });
    return () => {
      window.removeEventListener("focus", updateRetryInterval);
      window.removeEventListener("blur", updateRetryInterval);
      if (retryIntervalId !== null) {
        clearInterval(retryIntervalId);
      }
      postToWorker({ type: "close" });
      viewerMutable.sendMessage = (message) =>
        console.log(
          `Tried to send ${message.type} but websocket is not connected!`,
        );
      viewer.useGui.set({ websocketState: "inactive" });
    };
  }, [server, resetGui, resetScene]);

  return null;
}
