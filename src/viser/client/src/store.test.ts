import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

describe("createStore.batch", () => {
  it("notifies once, after the outermost batch", () => {
    const store = createStore({ a: 0, b: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.batch(() => {
      store.set({ a: 1 });
      store.batch(() => store.set({ b: 2 }));
      expect(store.get()).toEqual({ a: 1, b: 2 });
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);
    store.batch(() => {});
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ a: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("notifies when an exception is thrown", () => {
    const store = createStore({ a: 0 });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() =>
      store.batch(() => {
        store.set({ a: 1 });
        throw new Error("test");
      }),
    ).toThrow("test");
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ a: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
