import React from "react";

/** Hover state of a scene node. Mutable, to avoid re-rendering on hover.
 * Includes an instance ID, for instanced meshes. */
export class HoverState {
  isHovered = false;
  instanceId: number | null = null;
  // Most nodes are never hovered, and many have nobody listening.
  private listeners: Set<() => void> | null = null;

  set(isHovered: boolean, instanceId: number | null): void {
    if (this.isHovered === isHovered && this.instanceId === instanceId) return;
    this.isHovered = isHovered;
    this.instanceId = instanceId;
    this.listeners?.forEach((listener) => listener());
  }

  /** Listen for changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    const listeners = (this.listeners ??= new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
}

export const HoverableContext = React.createContext<{
  nodeName: string;
  state: HoverState;
  clickable: boolean;
  /** Whether this node needs to be raycast against: either it or one of its
   * ancestors is interactive. */
  raycastable: boolean;
} | null>(null);

const subscribeToNothing = () => () => undefined;

/** Reactively read whether the enclosing scene node is hovered. */
export function useIsHovered(): boolean {
  const state = React.useContext(HoverableContext)?.state;
  return React.useSyncExternalStore(
    React.useMemo(
      () =>
        state === undefined
          ? subscribeToNothing
          : (listener: () => void) => state.subscribe(listener),
      [state],
    ),
    () => state?.isHovered ?? false,
  );
}
