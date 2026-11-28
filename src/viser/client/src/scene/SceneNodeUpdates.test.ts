import { describe, expect, it, vi } from "vitest";
import { SceneNodeUpdates } from "./SceneNodeUpdates";

describe("SceneNodeUpdates", () => {
  it("runs handlers of dirty nodes once", () => {
    const updates = new SceneNodeUpdates();
    const handler = vi.fn();
    updates.register("/a", handler);
    updates.markDirty("/a");
    updates.markDirty("/not-mounted");
    updates.flush();
    updates.flush();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("defers nodes that are marked dirty by handlers", () => {
    const updates = new SceneNodeUpdates();
    let count = 0;
    updates.register("/a", () => {
      if (++count < 3) updates.markDirty("/a");
    });
    updates.flush();
    expect(count).toBe(1);
    updates.flush();
    updates.flush();
    updates.flush();
    expect(count).toBe(3);
  });

  it("doesn't unregister successors", () => {
    const updates = new SceneNodeUpdates();
    const successor = vi.fn();
    const unregister = updates.register("/a", () => {});
    updates.register("/a", successor);
    unregister();
    updates.flush();
    expect(successor).toHaveBeenCalledTimes(1);
  });

  it("continues after a handler throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const updates = new SceneNodeUpdates();
    const handler = vi.fn();
    updates.register("/a", () => {
      throw new Error("test");
    });
    updates.register("/b", handler);
    updates.flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
