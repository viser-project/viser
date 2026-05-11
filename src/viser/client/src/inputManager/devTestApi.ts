/**
 * Window-level test harness for Playwright. The pure InputManager
 * functions (classifier, reducers) have no DOM dependencies, so we
 * expose them on ``window.__viserInputManager__`` so e2e tests can
 * exercise the policy table directly without instantiating the
 * full viewer canvas.
 *
 * Mounted unconditionally in the client bundle (no separate dev
 * build); the surface is small and read-only, and the alternative
 * would be a parallel test framework and bundler config we do not
 * otherwise need. The viewer itself does not use this module. */

import {
  applyPointerMove,
  cancelGesture,
  classifyPointerDown,
  finalizePointerUp,
  nodeMatchesClick,
  eligibleScenePointerEventTypes,
} from "./classify";
import {
  deriveCameraControlEnabled,
  deriveCursor,
  shouldSuppressContextMenu,
} from "./reducers";

/** Read-only pure-function surface tests can call. The shape is the
 * stable test contract; do not break it without updating
 * ``tests/e2e/test_input_manager.py``. */
export const inputManagerTestApi = {
  classifyPointerDown,
  applyPointerMove,
  finalizePointerUp,
  cancelGesture,
  nodeMatchesClick,
  eligibleScenePointerEventTypes,
  deriveCameraControlEnabled,
  deriveCursor,
  shouldSuppressContextMenu,
} as const;

declare global {
  interface Window {
    /** Pure helpers from ``src/viser/client/src/inputManager``, exposed
     * for Playwright e2e tests. Do not call from the viewer itself. */
    __viserInputManager__?: typeof inputManagerTestApi;
  }
}

/** Install the test API on ``window``. Idempotent. Called once at
 * client startup. */
export function installInputManagerTestApi(): void {
  if (typeof window === "undefined") return;
  window.__viserInputManager__ = inputManagerTestApi;
}
