import React from "react";

/** How often inputs that can't be seen are updated. */
const OFFSCREEN_UPDATE_INTERVAL_MS = 500;

/** Tracks which GUI inputs are scrolled out of view, inside a collapsed folder,
 * in an inactive tab, etc. */
class OffscreenInputs {
  private readonly uuidFromElement = new WeakMap<Element, string>();
  /** Whether each of an input's elements can be seen. Inputs may be rendered in
   * more than one place. */
  private readonly visibility = new Map<string, Map<Element, boolean>>();
  private readonly onVisible = new Map<string, Set<() => void>>();
  private readonly observer: IntersectionObserver | null =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => this.handleEntries(entries), {
          // Start updating inputs shortly before they scroll into view.
          rootMargin: "200px",
        });

  private handleEntries(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const uuid = this.uuidFromElement.get(entry.target);
      if (uuid === undefined) continue;
      this.visibility.get(uuid)?.set(entry.target, entry.isIntersecting);
      if (entry.isIntersecting)
        this.onVisible.get(uuid)?.forEach((callback) => callback());
    }
  }

  observe(uuid: string, element: Element): () => void {
    let visibility = this.visibility.get(uuid);
    if (visibility === undefined) {
      visibility = new Map();
      this.visibility.set(uuid, visibility);
    }
    // Assume that elements are visible until we hear otherwise.
    visibility.set(element, true);
    this.uuidFromElement.set(element, uuid);
    this.observer?.observe(element);
    return () => {
      this.observer?.unobserve(element);
      const visibility = this.visibility.get(uuid);
      visibility?.delete(element);
      if (visibility?.size === 0) this.visibility.delete(uuid);
    };
  }

  isOffscreen(uuid: string): boolean {
    const visibility = this.visibility.get(uuid);
    if (visibility === undefined) return false;
    for (const visible of visibility.values()) if (visible) return false;
    return true;
  }

  /** Wrap a listener to be called at a lower rate while an input is offscreen.
   * Returns the wrapped listener and a cleanup function. */
  throttle(
    uuid: string,
    listener: () => void,
    shouldThrottle: () => boolean,
  ): [() => void, () => void] {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      listener();
    };
    let callbacks = this.onVisible.get(uuid);
    if (callbacks === undefined) {
      callbacks = new Set();
      this.onVisible.set(uuid, callbacks);
    }
    callbacks.add(flush);

    const throttled = () => {
      if (this.isOffscreen(uuid) && shouldThrottle()) {
        timer ??= setTimeout(flush, OFFSCREEN_UPDATE_INTERVAL_MS);
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      listener();
    };
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const callbacks = this.onVisible.get(uuid);
      callbacks?.delete(flush);
      if (callbacks?.size === 0) this.onVisible.delete(uuid);
    };
    return [throttled, cleanup];
  }
}

export const offscreenInputs = new OffscreenInputs();

/** Ref for the root element of an input. Updates to the input are throttled while
 * it isn't visible. */
export function useOffscreenRef(uuid: string): React.RefCallback<HTMLElement> {
  return React.useCallback(
    (element: HTMLElement | null) => {
      if (element === null) return;
      return offscreenInputs.observe(uuid, element);
    },
    [uuid],
  );
}
