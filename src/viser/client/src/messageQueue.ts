import { ViewerMutable } from "./ViewerContext";
import { Message, isGuiComponentMessage } from "./WebsocketMessages";

// Server->client messages that only touch the 2D GUI (never three.js state):
// the generated add-component set plus the update/remove/panel/notification
// messages. Kept explicit rather than prefix-matched: Gui3DMessage, for one,
// is a scene node.
const typeSetGuiOnlyMessage = new Set<Message["type"]>([
  "GuiUpdateMessage",
  "GuiRemoveMessage",
  "GuiModalMessage",
  "GuiCloseModalMessage",
  "GuiPanelMessage",
  "GuiPanelRemoveMessage",
  "GuiSetPanelCollapsedMessage",
  "GuiSetPanelHeightMessage",
  "GuiSetPanelPositionMessage",
  "GuiSetPanelWidthMessage",
  "SetGuiPanelLabelMessage",
  "NotificationShowMessage",
  "NotificationUpdateMessage",
  "RemoveNotificationMessage",
]);
function isGuiOnlyMessage(message: Message): boolean {
  return (
    isGuiComponentMessage(message) || typeSetGuiOnlyMessage.has(message.type)
  );
}

/** Append messages to the queue and make sure they get applied.
 *
 * The queue normally drains inside the render loop (frame-synchronized with
 * the pose appliers and render captures), so the default is to request a
 * frame. Two cases drain right away instead; both need an empty queue (FIFO
 * order) and no capture in flight:
 * - the tab is hidden: rAF is paused, so no frame would come and messages
 *   would pile up into one multi-second batch on return;
 * - the batch is GUI-only: it touches no three.js state, so waking the render
 *   loop would re-render the 3D scene for nothing (streamed slider/progress/
 *   markdown updates). */
export function enqueueMessages(
  viewerMutable: ViewerMutable,
  messages: readonly Message[],
): void {
  const queue = viewerMutable.messageQueue;
  const drain = viewerMutable.drainMessageQueue;
  const drainable =
    drain !== null && viewerMutable.getRenderRequestState === "ready";
  // GUI-only batches may only skip the frame when nothing else is queued
  // ahead of them (the drain processes the whole queue, in order).
  let guiOnly = drainable && queue.length === 0;
  // Append with a loop rather than push(...spread): spreading a large array
  // as call arguments overflows the call stack on big first-scene replays.
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    queue.push(message);
    if (guiOnly && !isGuiOnlyMessage(message)) guiOnly = false;
  }
  if (drainable && document.hidden) {
    drain();
    // Applied poses land in the next frame, which comes on tab return.
    viewerMutable.requestRender();
  } else if (guiOnly) {
    drain!();
  } else {
    viewerMutable.requestRender();
  }
}
