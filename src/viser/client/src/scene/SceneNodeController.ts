import * as THREE from "three";
import { RootStore, ThreeEvent } from "@react-three/fiber";
import { DragLayerApi } from "../dragLayerContext";
import {
  DragBinding,
  DragInput,
  anyBindingMatches,
  keyModifierFromEvent,
  pointerButtonFromNative,
} from "../dragUtils";
import { HoverState } from "../HoverContext";
import { ownerOf } from "../SceneTreeState";
import { ViewerContextContents } from "../ViewerContext";
import { makeThrottledMessageSender } from "../WebsocketUtils";
import { rayToViserCoords } from "../WorldTransformUtils";
import { opencvXyFromPointerXy } from "../utils/pointerCoords";
import { InstanceSource } from "./AutoInstancer";
import { SceneNodeGroup } from "./SceneNodeGroup";

/** The parts of a scene node component's state that change between renders. */
export type SceneNodeRenderState = {
  isLabel: boolean;
  unmount: boolean;
  unmountWhenInvisible: boolean;
  clickBindings: DragBinding[];
  dragBindings: DragBinding[];
  dragLayer: DragLayerApi | null;
  computeClickInstanceIndexFromInstanceId:
    ((instanceId: number | undefined) => number | null) | undefined;
};

type SceneNodeHandlers = {
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onContextMenu: (e: ThreeEvent<MouseEvent>) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
  onPointerCancel: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOver: (e: ThreeEvent<PointerEvent>) => void;
  onPointerOut: (e: ThreeEvent<PointerEvent>) => void;
};

/** Explicit undefined values: this makes sure that R3F clears handlers. */
export const noSceneNodeHandlers: {
  [key in keyof SceneNodeHandlers]: undefined;
} = {
  onPointerDown: undefined,
  onContextMenu: undefined,
  onPointerMove: undefined,
  onPointerUp: undefined,
  onPointerCancel: undefined,
  onPointerOver: undefined,
  onPointerOut: undefined,
};

/** Non-React half of a scene node component. Scenes can have tens of thousands
 * of nodes, and most of them are never interacted with. One object per node uses
 * a lot less memory than a ref or a callback for everything in here would. */
export class SceneNodeController {
  object: THREE.Object3D | null = null;
  group: SceneNodeGroup | null = null;
  readonly hoverState = new HoverState();
  /** Values from the last committed render. */
  latest: SceneNodeRenderState | null = null;

  /** Last pointer position, for re-raycasting when an object changes. */
  private lastPointerPos: { clientX: number; clientY: number } | null = null;
  /** Frame counter for a delayed hover recheck after an object changes. We wait
   * a few frames to ensure that the new geometry is fully rendered. */
  private hoverRecheckCountdown = 0;
  private isFirstObject = true;
  /** Created on the first click. */
  private clickSender: ReturnType<typeof makeThrottledMessageSender> | null =
    null;
  private handlers: SceneNodeHandlers | null = null;

  constructor(
    private readonly name: string,
    private readonly viewer: ViewerContextContents,
    private readonly threeStore: RootStore,
    private readonly setUnmount: (unmount: boolean) => void,
  ) {}

  /** Register with the viewer. Returns a cleanup function. */
  mount(): () => void {
    return this.viewer.sceneNodeUpdates.register(this.name, () =>
      this.applyUpdates(),
    );
  }

  /** Cleanup for when the node is removed. */
  onRemoved(): void {
    this.clearHover();
    this.clickSender?.cancel();
    this.latest?.dragLayer?.stopIfNodeIs(this.name);
    this.viewer.interaction.nodeGestures.cancelNode(this.name);
  }

  /** Ref for the group that contains the node's object and its descendants. */
  setGroup = (group: SceneNodeGroup): (() => void) => {
    const { sceneNodeGraph } = this.viewer;
    this.group = group;
    sceneNodeGraph.attachGroup(this.name, group);
    return () => {
      this.group = null;
      sceneNodeGraph.detachGroup(this.name, group);
    };
  };

  /** Ref for the node's object. */
  setObject(object: THREE.Object3D | null): void {
    const { nodeRefFromName } = this.viewer.mutable.current;
    if (object === null) {
      // React detaches a ref with null: on unmount, or when an
      // unmountWhenInvisible node hides. nodeRefFromName is typed as
      // Object3D | undefined, so drop the entry rather than store the null
      // (readers that only check `!== undefined` would crash on it, see
      // #788). Only drop it if it is still ours: a successor mounted under
      // the same name has already registered by the time we detach.
      if (nodeRefFromName[this.name] === this.object) {
        delete nodeRefFromName[this.name];
      }
      this.object = null;
      return;
    }
    this.object = object;
    nodeRefFromName[this.name] = object;
    // Poses are the only thing that modifies a node's local transform, and
    // they're applied below. Don't recompute it every frame.
    if (object.matrixAutoUpdate) {
      object.matrixAutoUpdate = false;
      object.updateMatrix();
    }
    this.viewer.sceneNodeGraph.markTransformsDirty(this.name);
    this.viewer.sceneNodeUpdates.markDirty(this.name);
  }

  /** Should be called when the node's object may have been created, or changed
   * in any way other than its pose. */
  onObjectChanged(): void {
    const { sceneNodeUpdates } = this.viewer;
    // The pose needs to be updated whenever a component is remounted or an
    // object is re-created.
    const pose = this.viewer.mutable.current.nodePoseData[this.name];
    if (pose) {
      pose.poseUpdateState = "needsUpdate";
      sceneNodeUpdates.markDirty(this.name);
      // We're called from a passive effect, which may have run after the frame
      // that was triggered by the commit.
      this.viewer.mutable.current.requestRender();
    }
    if (this.isFirstObject) {
      this.isFirstObject = false;
      return;
    }
    if (this.hoverState.isHovered) {
      // Wait 2 frames for the new mesh to be fully rendered.
      this.hoverRecheckCountdown = 2;
      sceneNodeUpdates.markDirty(this.name);
    }
  }

  /** Should be called when the interactivity of a node has changed. */
  onInteractivityChanged(interactive: boolean, draggable: boolean): void {
    const { nodeGestures } = this.viewer.interaction;
    // Handle case where interactivity is toggled off while still hovered.
    if (!interactive && this.hoverState.isHovered) {
      this.clearHover();
      nodeGestures.cancelNode(this.name);
    }
    // End the active drag if this node's draggability is revoked (bindings
    // cleared). DragLayer no-ops if the active drag targets a different node, so
    // this is safe to call unconditionally.
    const dragLayer = this.latest?.dragLayer ?? null;
    if (!draggable && dragLayer !== null) {
      dragLayer.stopIfNodeIs(this.name);
      nodeGestures.cancelNode(this.name);
    }
  }

  /** Sync attributes to the three.js object. Runs at the start of a frame if any
   * of the state that it depends on has been marked dirty. */
  private applyUpdates(): void {
    const { name, viewer, latest } = this;
    const viewerMutable = viewer.mutable.current;
    if (latest === null) return;

    // Re-check hover state after the object changes (mesh geometry update).
    if (this.hoverRecheckCountdown > 0) {
      this.hoverRecheckCountdown--;
      if (this.hoverRecheckCountdown > 0) {
        // The countdown needs consecutive frames (on-demand loop).
        viewer.sceneNodeUpdates.markDirty(name);
        viewerMutable.requestRender();
      } else {
        this.recheckHover();
      }
    }

    // Use .get() for performance in render loops (no re-renders).
    const node = viewer.useSceneTree.get(name);

    // Unmount when invisible.
    // Examples: <Html /> components, PivotControls.
    //
    // This is a workaround for situations where just setting `visible` doesn't
    // work (like <Html />), or to prevent invisible elements from being
    // interacted with (<PivotControls />).
    //
    // https://github.com/pmndrs/drei/issues/1323
    if (latest.unmountWhenInvisible) {
      const displayed = node?.effectiveVisibility ?? false;
      if (displayed && latest.unmount) {
        if (this.object !== null) this.object.visible = false;
        const pose = viewerMutable.nodePoseData[name];
        if (pose) pose.poseUpdateState = "needsUpdate";
        this.setUnmount(false);
      }
      if (!displayed && !latest.unmount) {
        this.setUnmount(true);
      }
    }

    const { object } = this;
    if (object === null || node === undefined) return;

    // Set node-local visibility. Three.js automatically handles parent chain
    // propagation (children of invisible parents are not rendered).
    object.visible = node.overrideVisibility ?? node.visibility ?? true;
    if (object instanceof InstanceSource) {
      object.setDisplayed(node.effectiveVisibility ?? true);
    }

    if (!node.effectiveVisibility) {
      // If an interactive node becomes invisible while hovered, clean up hover
      // state so the cursor doesn't stay stuck as "pointer".
      this.clearHover();
      // If a node disappears mid-drag, end the drag cleanly.
      latest.dragLayer?.stopIfNodeIs(name);
    }

    // Read pose from mutable ref (non-reactive, no re-renders).
    const pose = viewerMutable.nodePoseData[name];
    if (pose && pose.poseUpdateState === "needsUpdate") {
      pose.poseUpdateState = "updated";

      if (!latest.isLabel) {
        const wxyz = pose.wxyz;
        object.quaternion.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]);
      }
      const position = pose.position;
      object.position.set(position[0], position[1], position[2]);

      // Update matrices if necessary. This is necessary for PivotControls.
      if (!object.matrixAutoUpdate) object.updateMatrix();
      if (!object.matrixWorldAutoUpdate) object.updateMatrixWorld();
      viewer.sceneNodeGraph.markTransformsDirty(name);
    }
  }

  private clearHover(): void {
    if (!this.hoverState.isHovered) return;
    this.hoverState.set(false, null);
    this.viewer.interaction.hover.setHovered(this.name, false);
  }

  private recheckHover(): void {
    const canvas = this.viewer.mutable.current.canvas;
    if (
      !this.hoverState.isHovered ||
      this.group === null ||
      this.lastPointerPos === null ||
      canvas === null
    )
      return;
    // Compute NDC from stored pointer position.
    const rect = canvas.getBoundingClientRect();
    const { clientX, clientY } = this.lastPointerPos;
    const { raycaster, camera } = this.threeStore.getState();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    if (raycaster.intersectObject(this.group, true).length === 0) {
      // Pointer is no longer over this mesh, reset hover state.
      this.clearHover();
    }
  }

  /** Transient visibility check. Uses the cached effectiveVisibility, which
   * includes both this node and all ancestors in the scene tree. */
  private isDisplayed(): boolean {
    return (
      this.viewer.useSceneTree.get(this.name)?.effectiveVisibility ?? false
    );
  }

  private getPointerXy(clientX: number, clientY: number): [number, number] {
    const canvasBbox =
      this.viewer.mutable.current.canvas!.getBoundingClientRect();
    return [clientX - canvasBbox.left, clientY - canvasBbox.top];
  }

  private computeInstanceIndex(instanceId: number | undefined): number | null {
    // Batched handles (meshes/GLBs/axes) set
    // computeClickInstanceIndexFromInstanceId; plain handles leave it undefined
    // and instance_index is null on the wire.
    return (
      this.latest!.computeClickInstanceIndexFromInstanceId?.(instanceId) ?? null
    );
  }

  /** Pointer event handlers, which should only be attached to interactive
   * nodes.
   *
   * Instead of using onClick, we use onPointerDown/Move/Up to check mouse drag,
   * and only send a click if the mouse hasn't moved between the down and up
   * events.
   *  - onPointerDown resets the click state (dragged = false)
   *  - onPointerMove, if triggered, sets dragged = true
   *  - onPointerUp, if triggered, sends a click if dragged = false.
   * Note: It would be cool to have dragged actions too... */
  getHandlers(): SceneNodeHandlers {
    const { name, viewer } = this;
    const { interaction } = viewer;
    return (this.handlers ??= {
      onPointerDown: (e) => {
        if (!this.isDisplayed()) return;
        e.stopPropagation();
        const { clickBindings, dragBindings, dragLayer } = this.latest!;
        const buttonName = pointerButtonFromNative(e.nativeEvent.button);
        const input: DragInput | null =
          buttonName === null
            ? null
            : {
                button: buttonName,
                modifier: keyModifierFromEvent(e),
              };
        interaction.nodeGestures.recordPointerDown(input);

        const clickMatches =
          input !== null && anyBindingMatches(clickBindings, input);
        const targetObj = this.object;
        const beginDragArgs =
          input !== null &&
          dragLayer !== null &&
          targetObj !== null &&
          anyBindingMatches(dragBindings, input)
            ? {
                nodeName: name,
                instanceIndex: this.computeInstanceIndex(e.instanceId),
                targetObj,
                eventPoint: e.point,
                pointerXy: this.getPointerXy(e.clientX, e.clientY),
                pointerId: e.nativeEvent.pointerId,
                input,
                bindings: dragBindings,
              }
            : null;
        const dragMatches = beginDragArgs !== null;
        if (!clickMatches && !dragMatches) return;

        // Every interactive node runs through the motion-threshold
        // candidate: a stationary press on a clickable node fires the click
        // without a spurious drag start/end pair, and a stationary press on a
        // drag-only node fires nothing at all (vs. the prior behavior, where
        // dragstart fired immediately and dragend followed on release with no
        // motion between -- a degenerate gesture user code had to
        // special-case).
        interaction.nodeGestures.beginCandidate({
          pointerId: e.nativeEvent.pointerId,
          nodeKey: name,
          startClientXy: [e.clientX, e.clientY],
          lockCamera: dragMatches,
          onPromote: !dragMatches
            ? null
            : (promotionModifier) =>
                dragLayer!.beginDrag({ ...beginDragArgs, promotionModifier }),
        });
        if (dragMatches) e.nativeEvent.preventDefault();
      },
      onContextMenu: (e) => {
        if (!this.isDisplayed()) return;
        const { clickBindings, dragBindings } = this.latest!;
        // Suppress the browser context menu only when the gesture that fired
        // this contextmenu would actually be consumed by this node. The native
        // contextmenu event's button code is not reliable across browsers, so
        // we consult the input recorded by the most recent pointerdown -- which
        // on macOS includes the pointerdown that ctrl+left-click raises
        // alongside the contextmenu event.
        // Fallback: if no pointerdown was recorded (e.g. the menu was triggered
        // by the keyboard menu key), use a plain right-button input --
        // preserves the original "right-click on a right-bound node" behavior.
        const input: DragInput =
          interaction.nodeGestures.getLastPointerDownInput() ?? {
            button: "right",
            modifier: keyModifierFromEvent(e),
          };
        if (
          !anyBindingMatches(dragBindings, input) &&
          !anyBindingMatches(clickBindings, input)
        )
          return;
        e.nativeEvent.preventDefault();
        e.stopPropagation();
      },
      onPointerMove: (e) => {
        if (!this.isDisplayed()) return;
        e.stopPropagation();
        // Track pointer position for the hover recheck (mesh geometry update /
        // visibility loss).
        this.lastPointerPos = { clientX: e.clientX, clientY: e.clientY };
      },
      onPointerUp: (e) => {
        if (!this.isDisplayed()) return;
        e.stopPropagation();

        // Drop the recorded pointerdown input now that the gesture is over.
        // Prevents stale state from confusing a later keyboard-triggered
        // contextmenu (Shift+F10 / Menu key). macOS ctrl+click fires
        // contextmenu BEFORE pointerup, so the suppression path has already
        // consumed the value by the time we clear it.
        interaction.nodeGestures.clearLastPointerDownInput();
        // Settle any node-click-candidate. "click" means the press stayed
        // stationary; "none" means it promoted to drag, was cancelled, or no
        // candidate was ever started (for example, a drag-only node).
        const outcome = interaction.nodeGestures.settlePointerUp({
          pointerId: e.nativeEvent.pointerId,
        });
        if (this.latest!.clickBindings.length === 0 || outcome !== "click")
          return;
        // Convert ray to viser coordinates.
        const ray = rayToViserCoords(viewer, e.ray);

        // Send OpenCV image coordinates to the server (normalized).
        const mouseVectorOpenCV = opencvXyFromPointerXy(
          viewer,
          this.getPointerXy(e.clientX, e.clientY),
        );

        this.clickSender ??= makeThrottledMessageSender(viewer, 50);
        this.clickSender.send({
          type: "SceneNodeClickMessage",
          name: name,
          instance_index: this.computeInstanceIndex(e.instanceId),
          // Note that the threejs up is +Y, but we expose a +Z up.
          ray_origin: [ray.origin.x, ray.origin.y, ray.origin.z],
          ray_direction: [ray.direction.x, ray.direction.y, ray.direction.z],
          screen_pos: [mouseVectorOpenCV.x, mouseVectorOpenCV.y],
          modifier: keyModifierFromEvent(e),
          // Echo the EFFECTIVE variant's owner: only the mounted variant is
          // interactive, and the server routes the event to that scope's
          // registry alone.
          owner: ownerOf(viewer.useSceneTree.get(name)?.message),
        });
      },
      onPointerCancel: (e) => {
        interaction.cancelPointer(e.nativeEvent.pointerId);
      },
      onPointerOver: (e) => {
        if (!this.isDisplayed()) return;
        e.stopPropagation();

        // Store pointer position for re-raycasting when mesh changes.
        this.lastPointerPos = { clientX: e.clientX, clientY: e.clientY };

        // Guard against double-increment if already hovered.
        if (this.hoverState.isHovered) return;
        this.hoverState.set(true, e.instanceId ?? null);
        interaction.hover.setHovered(name, true);
      },
      onPointerOut: () => {
        if (!this.isDisplayed()) return;
        this.clearHover();
      },
    });
  }
}
