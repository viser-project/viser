/** Event-driven application of per-node state (pose, visibility, ...) to
 * three.js objects.
 *
 * Scene node components register a handler that syncs their three.js object
 * with the latest state. Anything that changes that state marks the node dirty,
 * and the render loop runs the handlers of dirty nodes once per frame.
 *
 * This replaces a useFrame() per node. Those cost a callback per node per
 * frame even when nothing changes. R3F also re-sorts its full subscriber list
 * on every subscribe and filters it on every unsubscribe, which made
 * mounting or unmounting a scene quadratic in its size. */
export class SceneNodeUpdates {
  private dirty = new Set<string>();
  private readonly handlers = new Map<string, () => void>();

  /** Run a node's handler on the next frame. Note that this does not request
   * a frame. */
  markDirty(name: string): void {
    this.dirty.add(name);
  }

  /** Register the handler for a mounted node, which is marked dirty. Returns a
   * cleanup function. */
  register(name: string, handler: () => void): () => void {
    this.handlers.set(name, handler);
    this.markDirty(name);
    return () => {
      // When a node is remounted, the successor may already be registered.
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  /** Run the handlers of all dirty nodes. Handlers that mark nodes dirty will
   * run again on the next flush. Nodes without a handler are skipped: they're
   * marked dirty again when they mount. */
  flush(): void {
    if (this.dirty.size === 0) return;
    const dirty = this.dirty;
    this.dirty = new Set();
    dirty.forEach((name) => {
      // One failure shouldn't prevent other nodes from being updated.
      try {
        this.handlers.get(name)?.();
      } catch (e) {
        console.error(`Failed to update scene node ${name}:`, e);
      }
    });
  }
}
