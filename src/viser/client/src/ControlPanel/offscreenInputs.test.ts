import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let intersect: (element: Element, isIntersecting: boolean) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: any[]) => void) {
        intersect = (target, isIntersecting) =>
          callback([{ target, isIntersecting }]);
      }
      observe() {}
      unobserve() {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  const { offscreenInputs } = await import("./offscreenInputs");
  const element = {} as Element;
  const unobserve = offscreenInputs.observe("a", element);
  const listener = vi.fn();
  let fromServer = true;
  const [throttled, cleanup] = offscreenInputs.throttle(
    "a",
    listener,
    () => fromServer,
  );
  return {
    element,
    unobserve,
    listener,
    throttled,
    cleanup,
    setFromServer: (value: boolean) => (fromServer = value),
  };
}

describe("offscreenInputs", () => {
  it("doesn't delay updates to visible inputs", async () => {
    const { listener, throttled, element } = await setup();
    throttled(); // Not observed yet.
    intersect(element, true);
    throttled();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("coalesces updates to offscreen inputs", async () => {
    const { listener, throttled, element } = await setup();
    intersect(element, false);
    for (let i = 0; i < 10; i++) throttled();
    expect(listener).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("flushes when an input becomes visible", async () => {
    const { listener, throttled, element } = await setup();
    intersect(element, false);
    throttled();
    intersect(element, true);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
    // Nothing pending.
    intersect(element, false);
    intersect(element, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("never delays local edits", async () => {
    const { listener, throttled, element, setFromServer } = await setup();
    intersect(element, false);
    throttled();
    setFromServer(false);
    throttled();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("handles inputs that are rendered more than once", async () => {
    const { listener, throttled, element } = await setup();
    const { offscreenInputs } = await import("./offscreenInputs");
    const unobserve = offscreenInputs.observe("a", {} as Element);
    intersect(element, false);
    throttled();
    expect(listener).toHaveBeenCalledTimes(1);
    unobserve();
    throttled();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("cleans up", async () => {
    const { listener, throttled, element, cleanup, unobserve } = await setup();
    intersect(element, false);
    throttled();
    cleanup();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(0);
    unobserve();
    throttled();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
