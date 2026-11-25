import React from "react";
import { ViewerContext } from "../ViewerContext";
import { BatchEntry, InstanceBatch, InstanceSource } from "./AutoInstancer";
import { useDrawable } from "./SceneNodeContext";

/** How a scene node can be drawn as part of a batch. */
export type InstancingSpec = {
  /** Describes everything that members of the batch need to have in common. */
  key: string;
  makeBatch: () => InstanceBatch;
  /** Appearance of this instance, which needs to match the kind of batch. Should
   * be memoized. */
  appearance: unknown;
};

const subscribeToNothing = () => () => undefined;
const alwaysFalse = () => false;

/** Batch a scene node together with similar ones, if there are many of them.
 *
 * The source should be rendered as the root of the scene node. Returns whether
 * the node needs to draw itself.
 *
 * When a node isn't eligible for batching, the spec should be null. Anything
 * that's always drawn individually should be declared with `useDrawable()`. */
export function useInstanceSource(
  source: InstanceSource,
  spec: InstancingSpec | null,
): boolean {
  const { autoInstancer } = React.useContext(ViewerContext)!;
  const key = spec?.key ?? null;
  const makeBatch = spec?.makeBatch;
  const appearance = spec?.appearance ?? null;

  // The entry that we've joined. We don't know whether its batch will be active
  // until every node in the same commit has joined, so nothing is drawn on the
  // first pass. State updates in layout effects are flushed before the next
  // frame.
  const [joined, setJoined] = React.useState<{
    key: string;
    entry: BatchEntry;
  } | null>(null);
  React.useLayoutEffect(() => {
    if (key === null) return;
    const entry = autoInstancer.getEntry(key, makeBatch!);
    source.appearance = appearance;
    entry.add(source);
    setJoined({ key, entry });
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
    joined?.entry.subscribe ?? subscribeToNothing,
    joined?.entry.isActive ?? alwaysFalse,
  );
  const drawIndividually = key === null || (joined?.key === key && !active);
  useDrawable(drawIndividually);
  return drawIndividually;
}
