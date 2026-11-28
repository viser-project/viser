import React from "react";
import { ViewerContext } from "../ViewerContext";
import {
  BatchEntry,
  InstanceAppearance,
  InstanceBatch,
  InstanceSource,
} from "./AutoInstancer";
import { HoverableContext } from "../HoverContext";
import { useDrawable, useMarkTransformsDirty } from "./sceneNodeHooks";

/** How a scene node can be drawn as part of a batch. */
export type InstancingSpec = {
  /** Describes everything that members of the batch need to have in common. */
  key: string;
  makeBatch: () => InstanceBatch;
  /** Appearance of this instance, which needs to match the kind of batch. Should
   * be memoized. */
  appearance: InstanceAppearance;
};

type JoinedEntry = Pick<BatchEntry, "subscribe" | "isActive">;
const notBatched: JoinedEntry = {
  subscribe: () => () => undefined,
  isActive: () => false,
};

/** Batch a scene node together with similar ones, if there are many of them.
 *
 * The source should be rendered as the root of the scene node. Returns what
 * the node needs to mount itself: a mesh that's drawn, one that's only used for
 * raycasting, or nothing.
 *
 * When a node isn't eligible for batching, the spec should be null. Anything
 * that's always drawn individually should be declared with `useDrawable()`. */
export function useInstanceSource(
  source: InstanceSource,
  spec: InstancingSpec | null,
): "drawn" | "raycast" | null {
  const { autoInstancer } = React.useContext(ViewerContext)!;
  const key = spec?.key ?? null;
  const makeBatch = spec?.makeBatch;
  const appearance = spec?.appearance ?? null;

  // The entry that we've joined. We don't know whether its batch will be active
  // until every node in the same commit has joined, so nothing is drawn on the
  // first pass. State updates in layout effects are flushed before the next
  // frame. When the key changes later, we go by the previous entry until then.
  const [entry, setEntry] = React.useState<JoinedEntry | null>(null);
  React.useLayoutEffect(() => {
    if (key === null) {
      setEntry(notBatched);
      return;
    }
    const entry = autoInstancer.getEntry(key, makeBatch!);
    source.appearance = appearance;
    entry.add(source);
    setEntry(entry);
    return () => entry.remove(source);
    // The key determines makeBatch, and changes to the appearance are handled
    // below.
  }, [autoInstancer, source, key]);

  React.useLayoutEffect(() => {
    if (source.appearance === appearance) return;
    source.appearance = appearance;
    source.batch?.updateAppearance(source);
  }, [source, appearance]);

  const active = React.useSyncExternalStore(
    (entry ?? notBatched).subscribe,
    (entry ?? notBatched).isActive,
  );
  const drawIndividually = key === null || (entry !== null && !active);
  const raycastable = React.useContext(HoverableContext)?.raycastable ?? false;
  const mode = drawIndividually ? "drawn" : raycastable ? "raycast" : null;
  useDrawable(drawIndividually);
  // Components mount or unmount meshes when this changes.
  useMarkTransformsDirty([mode]);
  return mode;
}
