// Shared low-level helpers for pointer-driven gestures (drag, resize). Lifted
// and generalized from ControlPanel/FloatingPanel.tsx so the docking library
// has no dependency back on the control-panel code.

export { motionExceedsThreshold } from "../dragUtils";

/** Bind a pointer gesture's move/end/cancel listeners on `window` and return a
 * detach function. Gestures capture the pointer on an element but listen on
 * `window` so the gesture survives the cursor leaving that element; this shares
 * the move + (up/cancel -> end) wiring.
 *
 * When `pointerId` is given, events from any OTHER pointer are ignored -- so on
 * a multi-touch surface a second finger can't drive or end the first finger's
 * gesture (a second finger's `pointerup` must not commit finger A's drop). This
 * mirrors the scene-pointer subsystem (pointer/gestures.ts). The end callback
 * receives the triggering event so callers can release the right pointer, plus
 * a first-class `cancelled` flag: true for anything that is NOT a real release
 * (pointercancel from a browser-stolen touch, or Escape) -- consumers abort
 * their commit on it (a drag drops nothing, a reorder snaps back) instead of
 * sniffing event types. */
export function bindPointerGesture(
  onMove: (event: PointerEvent) => void,
  onEnd: (event: PointerEvent, cancelled: boolean) => void,
  pointerId?: number,
): () => void {
  const handleMove = (event: PointerEvent) => {
    if (pointerId !== undefined && event.pointerId !== pointerId) return;
    onMove(event);
  };
  const handleEnd = (event: PointerEvent) => {
    if (pointerId !== undefined && event.pointerId !== pointerId) return;
    onEnd(event, event.type === "pointercancel");
  };
  const handleKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    onEnd(
      new PointerEvent("pointercancel", { pointerId: pointerId ?? undefined }),
      true,
    );
  };
  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleEnd);
  window.addEventListener("pointercancel", handleEnd);
  window.addEventListener("keydown", handleKey);
  return () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleEnd);
    window.removeEventListener("pointercancel", handleEnd);
    window.removeEventListener("keydown", handleKey);
  };
}

/** Suppress page-wide text selection for the duration of a gesture; returns a
 * restore function. Called synchronously inside pointerdown -- before the
 * browser's mousedown default can anchor a selection -- so dragging a tab,
 * grip, or divider across text content can't start highlighting it. */
export function suppressTextSelection(): () => void {
  document.body.style.userSelect = "none";
  return () => {
    document.body.style.userSelect = "";
  };
}

/** Show the "grabbing" cursor page-wide while a MOVE drag is in flight (the
 * handles show "grab" at rest; without this the cursor never closes). Returns
 * a restore function. Resize gestures keep their own ew/ns-resize cursors. */
export function grabbingCursor(): () => void {
  const prev = document.body.style.cursor;
  document.body.style.cursor = "grabbing";
  return () => {
    document.body.style.cursor = prev;
  };
}

/** Run a rAF-throttled drag gesture: capture the pointer on `grip`, record the
 * latest pointer state via `update(e)` on every move, and apply it via
 * `flush()` at most once per animation frame (plus one final flush on release
 * if a move is still pending). `onEnd` runs exactly once, on release OR
 * cancellation, before the final flush -- the place to clear shared flags. It
 * receives `cancelled: true` when the gesture did NOT end with a real release
 * (Escape, browser-stolen touch, unmount), so callers can revert what their
 * per-frame flushes applied; no flush runs after a cancel.
 *
 * Returns a cancel function for unmount cleanup: it detaches the window
 * listeners, drops any pending frame WITHOUT flushing, and runs `onEnd`.
 * Idempotent, so calling it after a normal release is a no-op.
 *
 * This wraps the pattern shared by every resize/divider gesture (rAF
 * throttling, pointer capture, multitouch filtering, unmount safety) so the
 * call sites only provide the geometry math. */
export function dragGesture(opts: {
  grip: Element;
  pointerId: number;
  update: (event: PointerEvent) => void;
  flush: () => void;
  onEnd?: (cancelled: boolean) => void;
}): () => void {
  const { grip, pointerId, update, flush, onEnd } = opts;
  tryCapture(grip, pointerId);
  const restoreSelect = suppressTextSelection();
  let raf: number | null = null;
  let done = false;
  const frame = () => {
    raf = null;
    flush();
  };
  const cancel = (cancelled = true) => {
    if (done) return;
    done = true;
    detach();
    if (raf !== null) cancelAnimationFrame(raf);
    restoreSelect();
    onEnd?.(cancelled);
  };
  const detach = bindPointerGesture(
    (e) => {
      update(e);
      if (raf === null) raf = requestAnimationFrame(frame);
    },
    (_endEvent, cancelled) => {
      const pending = raf !== null;
      cancel(cancelled);
      if (pending && !cancelled) flush();
      tryRelease(grip, pointerId);
    },
    pointerId, // ignore other pointers so a second finger can't drive/end this.
  );
  return () => cancel(true);
}

/** Try to capture the pointer on an element; swallow the error if the pointer
 * is already gone (matches the FloatingPanel try/catch pattern). */
export function tryCapture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Pointer may already be released; ignore.
  }
}

/** Release a captured pointer, ignoring "already released" errors. */
export function tryRelease(el: Element, pointerId: number): void {
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // Already released; ignore.
  }
}

/** Activate a role=button element from the keyboard (Enter or Space), matching
 * the native <button> contract for our minimize/expand controls. Structurally
 * typed so it accepts React's synthetic KeyboardEvent without a React import. */
/** Move keyboard focus to a pane's tab element on the next frame -- used
 * after a KEYBOARD-driven expand of a minimized group, whose chip/row
 * unmounts on expand (focus would otherwise fall to <body> and the user
 * would have to Tab back in from the top). Pointer paths don't call this:
 * mouse users don't expect a focus ring to appear. */
export function focusPaneTab(paneId: string) {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-dock-tab="${paneId}"]`)
      ?.focus();
  });
}

export function keyActivate(action: () => void) {
  return (event: {
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}

/** Roving-focus keyboard handler for a tab list (horizontal strip or vertical
 * minimized strip): the `prev`/`next` arrow keys move focus to the adjacent tab
 * (found by its `data-dock-tab` attribute off the shared parent), and Enter/Space
 * activate the focused tab. Both axes share this; the caller picks the key pair,
 * the pane order, and what "activate"/"move" do. `onMove` (optional) runs when
 * focus moves -- the expanded strip activates-on-move; the minimized strip
 * doesn't (activating there would expand the panel). */
export function tabListKeyDown(opts: {
  paneId: string;
  paneIds: readonly string[];
  prevKey: "ArrowLeft" | "ArrowUp";
  nextKey: "ArrowRight" | "ArrowDown";
  onActivate: (paneId: string) => void;
  onMove?: (paneId: string) => void;
}) {
  return (event: {
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
    currentTarget: { parentElement: HTMLElement | null };
  }) => {
    if (event.key === opts.prevKey || event.key === opts.nextKey) {
      event.preventDefault();
      event.stopPropagation();
      const i = opts.paneIds.indexOf(opts.paneId);
      const next = opts.paneIds[event.key === opts.prevKey ? i - 1 : i + 1];
      if (next !== undefined) {
        opts.onMove?.(next);
        event.currentTarget.parentElement
          ?.querySelector<HTMLElement>(`[data-dock-tab="${CSS.escape(next)}"]`)
          ?.focus();
      }
      return;
    }
    keyActivate(() => opts.onActivate(opts.paneId))(event);
  };
}

// Monotonic id counter. Module-scoped so ids are unique across the whole client
// session without needing Math.random()/Date.now().
let idCounter = 0;
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Raise the id counter past every `<prefix>-<n>` id already present in
 * externally-supplied ids (a restored/injected layout). Without this a layout
 * persisted from an earlier session collides with the fresh session's counter
 * (which restarts at 0): a new `node-3` silently shadows a restored `node-3`,
 * tripping the unique-id invariant or clobbering a groups-map entry. */
export function bumpFreshIdFloor(ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /-(\d+)$/.exec(id);
    if (m !== null) idCounter = Math.max(idCounter, Number(m[1]));
  }
}
