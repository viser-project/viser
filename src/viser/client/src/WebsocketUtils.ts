import React from "react";
import * as THREE from "three";
import { Message } from "./WebsocketMessages";
import { ViewerContext, ViewerContextContents } from "./ViewerContext";

/** Easier, hook version of makeThrottledMessageSender.
 *
 * Memoized so the returned ``{send, flush}`` keeps a stable identity
 * across renders: callers wire ``send`` into ``useCallback`` dep arrays
 * and into context provider values, where a fresh object every render
 * would defeat memoization downstream and cause unrelated re-renders.
 * The pending throttle timer is also cleared on unmount so a teardown
 * doesn't leave a dangling closure pinning the viewer. */
export function useThrottledMessageSender(throttleMilliseconds: number) {
  const viewer = React.useContext(ViewerContext)!;
  const sender = React.useMemo(
    () => makeThrottledMessageSender(viewer, throttleMilliseconds),
    [viewer, throttleMilliseconds],
  );
  React.useEffect(() => sender.cancel, [sender]);
  return sender;
}

/** Returns a function for sending messages, with automatic throttling.
 * Returns ``cancel`` to clear any pending throttle timer (e.g. on
 * unmount); after ``cancel`` the sender is still usable and will fire
 * the next message immediately. */
export function makeThrottledMessageSender(
  viewer: ViewerContextContents,
  throttleMilliseconds: number,
) {
  let readyToSend = true;
  let stale = false;
  let latestMessage: Message | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function send(message: Message) {
    const viewerMutable = viewer.mutable.current;
    if (viewerMutable.sendMessage === null) return;
    latestMessage = message;
    if (readyToSend) {
      viewerMutable.sendMessage(message);
      stale = false;
      readyToSend = false;

      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        readyToSend = true;
        if (!stale) return;
        latestMessage && send(latestMessage);
      }, throttleMilliseconds);
    } else {
      stale = true;
    }
  }
  function flush() {
    const viewerMutable = viewer.mutable.current;
    if (viewerMutable.sendMessage === null) return;
    if (latestMessage !== null) {
      viewer.mutable.current.sendMessage(latestMessage);
      latestMessage = null;
      stale = false;
    }
  }
  function cancel() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    readyToSend = true;
    stale = false;
    latestMessage = null;
  }
  return { send, flush, cancel };
}

/** Type guard for threejs textures. Meant to be used with `scene.background`. */
export function isTexture(
  background:
    | THREE.Color
    | THREE.Texture
    | THREE.CubeTexture
    | null
    | undefined,
): background is THREE.Texture {
  return (
    background !== null &&
    background !== undefined &&
    (background as THREE.Texture).isTexture !== undefined
  );
}
