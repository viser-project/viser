// Pins the sort worker's buffer-staleness fix: an updateBuffer that arrives
// while a sort is running used to be dropped by the throttle, and the
// deferred retry only re-sorted on a VIEW change -- so with a stationary
// camera (the main thread only posts setTz_camera_groups when groups move
// w.r.t. the camera) the stale order persisted until the camera moved.
//
// The worker module is importable directly: it only touches `self`, `fetch`,
// and the WASM sorter module, all of which we stub before import.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sorters: [] as FakeSorter[],
}));

class FakeSorter {
  buffer: Uint32Array;
  // Buffer identity at the time of each sort() call.
  sortedBuffers: Uint32Array[] = [];
  constructor(buffer: Uint32Array) {
    this.buffer = buffer;
    hoisted.sorters.push(this);
  }
  setBuffer(buffer: Uint32Array) {
    this.buffer = buffer;
  }
  sort(): Uint32Array {
    this.sortedBuffers.push(this.buffer);
    return new Uint32Array(1);
  }
}

vi.mock("./WasmSorter/Sorter.mjs", () => ({
  default: async () => ({ Sorter: FakeSorter }),
}));
vi.mock("./WasmSorter/Sorter.wasm?url", () => ({ default: "sorter.wasm" }));

async function importWorker() {
  const posted: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
  const fakeSelf = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (msg: unknown) => posted.push(msg),
    close: () => {},
  };
  vi.stubGlobal("self", fakeSelf);
  await import("./SplatSortWorker");
  const send = (data: unknown) => fakeSelf.onmessage!({ data });
  return { posted, send };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SplatSortWorker buffer staleness", () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.sorters.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sorts on setTz_camera_groups", async () => {
    const { posted, send } = await importWorker();
    send({
      setBuffer: new Uint32Array(8),
      setGroupIndices: new Uint32Array(1),
    });
    send({ setTz_camera_groups: new Float32Array(4) });
    await flush();
    expect(posted).toHaveLength(1);
  });

  it("re-sorts a buffer swapped in while a sort was running, without a view change", async () => {
    const { posted, send } = await importWorker();
    const bufferV1 = new Uint32Array(8);
    const bufferV2 = new Uint32Array(8);

    send({ setBuffer: bufferV1, setGroupIndices: new Uint32Array(1) });
    // setTz starts a sort of V1; sortRunning stays true until its deferred
    // setTimeout(0) fires. The updateBuffer below is handled on the promise
    // chain (a microtask), so it lands INSIDE that window and its
    // throttledSort() call is dropped -- the dirty flag alone must trigger
    // the retry, since the view never changes.
    send({ setTz_camera_groups: new Float32Array(4) });
    send({
      updateBuffer: bufferV2,
      updateGroupIndices: new Uint32Array(1),
      updateNumGroups: 1,
    });
    await flush();

    expect(posted).toHaveLength(2);
    expect(hoisted.sorters).toHaveLength(1);
    // Identity, not toEqual: both buffers hold the same (zero) content, so
    // only reference checks prove the retry sorted the SWAPPED-IN buffer.
    expect(hoisted.sorters[0].sortedBuffers.map((b) => b === bufferV1)).toEqual(
      [true, false],
    );
    expect(hoisted.sorters[0].sortedBuffers[1]).toBe(bufferV2);
  });

  it("does not re-sort after an idle sort with unchanged view and buffer", async () => {
    const { posted, send } = await importWorker();
    send({
      setBuffer: new Uint32Array(8),
      setGroupIndices: new Uint32Array(1),
    });
    send({ setTz_camera_groups: new Float32Array(4) });
    await flush();
    // Buffer update while idle: exactly one additional sort (the immediate
    // one), no spurious dirty-flag retry afterwards.
    send({
      updateBuffer: new Uint32Array(8),
      updateGroupIndices: new Uint32Array(1),
      updateNumGroups: 1,
    });
    await flush();
    expect(posted).toHaveLength(2);
  });
});
