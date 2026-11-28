import { beforeAll, describe, expect, it, vi } from "vitest";
import { GuiComponentMessage } from "../WebsocketMessages";

let createGuiState: (typeof import("./GuiState"))["createGuiState"];
beforeAll(async () => {
  // Read when the module is loaded.
  vi.stubGlobal("window", { location: { search: "" } });
  ({ createGuiState } = await import("./GuiState"));
  vi.unstubAllGlobals();
});

function slider(uuid: string, container = "root", order = 0) {
  return {
    type: "GuiSliderMessage",
    uuid,
    container_uuid: container,
    value: 0,
    props: { order },
  } as unknown as GuiComponentMessage;
}

describe("guiActions.batch", () => {
  it("applies many changes with one notification per store", () => {
    const { store, configStore, actions } = createGuiState("");
    const listener = vi.fn();
    const onA = vi.fn();
    store.subscribe(listener);
    configStore.subscribe("a", onA);
    actions.batch(() => {
      actions.addGui(slider("a", "root", 1));
      actions.addGui(slider("b", "root", 2));
      actions.addGui(slider("c", "folder", 3));
      actions.removeGui("b");
      expect(listener).not.toHaveBeenCalled();
      expect(onA).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(store.get().guiUuidSetFromContainerUuid).toEqual({
      root: { a: true },
      folder: { c: true },
    });
    expect(store.get().guiOrderFromUuid).toEqual({ a: 1, c: 3 });
  });

  it("drops containers when they become empty", () => {
    const { store, actions } = createGuiState("");
    actions.batch(() => {
      actions.addGui(slider("a", "folder"));
      actions.removeGui("a");
    });
    expect(store.get().guiUuidSetFromContainerUuid).not.toHaveProperty(
      "folder",
    );
    expect(store.get().guiOrderFromUuid).toEqual({});
  });

  it("never modifies what subscribers have already seen", () => {
    const { store, actions } = createGuiState("");
    const seen: [object, string][] = [];
    store.subscribe(() => {
      const { guiOrderFromUuid, guiUuidSetFromContainerUuid } = store.get();
      for (const obj of [
        guiOrderFromUuid,
        guiUuidSetFromContainerUuid,
        guiUuidSetFromContainerUuid["root"],
      ])
        if (obj !== undefined) seen.push([obj, JSON.stringify(obj)]);
    });
    actions.batch(() => actions.addGui(slider("a")));
    actions.batch(() => {
      actions.addGui(slider("b"));
      actions.batch(() => actions.addGui(slider("c")));
      actions.addGui(slider("d"));
    });
    actions.addGui(slider("e"));
    actions.removeGui("a");
    for (const [obj, json] of seen) expect(JSON.stringify(obj)).toBe(json);
  });

  it("allows subscribers to start batches", () => {
    const { store, actions } = createGuiState("");
    let reentered = false;
    store.subscribe(() => {
      if (reentered) return;
      reentered = true;
      actions.batch(() => actions.addGui(slider("nested")));
    });
    actions.batch(() => actions.addGui(slider("a")));
    expect(reentered).toBe(true);

    // Batch state should have been reset.
    const listener = vi.fn();
    store.subscribe(listener);
    for (const uuid of ["b", "c", "d"]) {
      const before = store.get().guiOrderFromUuid;
      actions.addGui(slider(uuid));
      expect(store.get().guiOrderFromUuid).not.toBe(before);
    }
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("resets after exceptions", () => {
    const { store, actions } = createGuiState("");
    expect(() =>
      actions.batch(() => {
        actions.addGui(slider("a"));
        throw new Error("test");
      }),
    ).toThrow("test");
    const before = store.get().guiOrderFromUuid;
    actions.addGui(slider("b"));
    expect(store.get().guiOrderFromUuid).not.toBe(before);
  });
});
