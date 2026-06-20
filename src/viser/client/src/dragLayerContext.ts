/** Context + hook for the viewer-level drag coordinator.
 *
 * Split from ``DragLayer.tsx`` so the Fast Refresh (HMR) module boundary
 * only contains components -- React warns when a component file also
 * exports non-components. */

import React from "react";
import * as THREE from "three";
import { DragBinding, DragInput } from "./dragUtils";

export type BeginDragArgs = {
  nodeName: string;
  /** Instance index for batched meshes/GLBs/axes. ``null`` for non-batched
   * nodes. Frozen at drag-start and sent on every drag message. */
  instanceIndex: number | null;
  targetObj: THREE.Object3D;
  eventPoint: THREE.Vector3;
  pointerXy: [number, number];
  /** PointerId of the pointerdown that's starting this drag. Used to
   * filter unrelated pointer events on multi-touch surfaces. */
  pointerId: number;
  input: DragInput;
  bindings: DragBinding[];
};

export interface DragLayerApi {
  /** Attempt to start a drag on the given scene node. No-op if any drag
   * is already active, or if no binding matches the current input. */
  beginDrag(args: BeginDragArgs): boolean;
  /** End the active drag if (and only if) it targets the given node. */
  stopIfNodeIs(nodeName: string): void;
}

export const DragLayerContext = React.createContext<DragLayerApi | null>(null);

export function useDragLayer(): DragLayerApi | null {
  return React.useContext(DragLayerContext);
}
