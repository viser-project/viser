import { PivotControls } from "@react-three/drei";
import { Grid } from "./Grid";
import { useContextBridge } from "its-fine";
import { useFrame, useStore } from "@react-three/fiber";
import React, { useEffect } from "react";
import * as THREE from "three";

import { ViewerContext, ViewerContextContents } from "./ViewerContext";
import { makeThrottledMessageSender } from "./WebsocketUtils";
import { Html } from "@react-three/drei";
import { ownerOf, SceneNode, useSceneTreeState } from "./SceneTreeState";
import { HoverableContext } from "./HoverContext";
import { shallowArrayEqual } from "./utils/shallowArrayEqual";
import { DragBinding } from "./dragUtils";
import { useDragLayer } from "./dragLayerContext";
import {
  CoordinateFrame,
  InstancedAxes,
  PointCloud,
  ViserImage,
  ViserLabel,
} from "./ThreeAssets";
import { CameraFrustumComponent } from "./CameraFrustumVariants";
import {
  CatmullRomSplineMessage,
  CubicBezierSplineMessage,
  SceneNodeMessage,
  SpotLightMessage,
} from "./WebsocketMessages";
import { SplatObject } from "./Splatting/GaussianSplats";
import { Paper } from "@mantine/core";
import GeneratedGuiContainer from "./ControlPanel/Generated";
import { Line, LineSegments } from "./Line";
import { Arrows } from "./Arrows";
import { shadowArgs } from "./ShadowArgs";
import { CascadedDirectionalLight } from "./CascadedDirectionalLight";
import { BasicMesh } from "./mesh/BasicMesh";
import { BoxMesh } from "./mesh/BoxMesh";
import { IcosphereMesh } from "./mesh/IcosphereMesh";
import { CylinderMesh } from "./mesh/CylinderMesh";
import { SkinnedMesh } from "./mesh/SkinnedMesh";
import { BatchedMesh } from "./mesh/BatchedMesh";
import { SingleGlbAsset } from "./mesh/SingleGlbAsset";
import { BatchedGlbAsset } from "./mesh/BatchedGlbAsset";
import {
  noSceneNodeHandlers,
  SceneNodeController,
} from "./scene/SceneNodeController";
import { normalizeScale } from "./utils/normalizeScale";

/** Shared empty array so the `dragBindings` selector returns a stable
 * reference when no bindings are set -- otherwise `?? []` would allocate a
 * fresh array per render and force downstream memoization to recompute. */
const EMPTY_DRAG_BINDINGS: DragBinding[] = [];

function rgbToInt(rgb: [number, number, number]): number {
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

/** Type corresponding to useSceneTree hook. */
export type UseSceneTree = ReturnType<typeof useSceneTreeState>;

/** Name label, which is shown when hovering over a node in the scene tree
 * table. */
function SceneNodeLabel(props: { name: string }) {
  return (
    <Html>
      <span
        style={{
          backgroundColor: "rgba(240, 240, 240, 0.9)",
          color: "#333",
          borderRadius: "0.2rem",
          userSelect: "none",
          padding: "0.1em 0.2em",
        }}
      >
        {props.name}
      </span>
    </Html>
  );
}

function tripletListFromFloat32Array(data: Float32Array) {
  const triplets: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 3) {
    triplets.push([data[i], data[i + 1], data[i + 2]]);
  }
  return triplets;
}

function flatFromVector3List(points: THREE.Vector3[]): Float32Array {
  const flat = new Float32Array(points.length * 3);
  points.forEach((p, i) => p.toArray(flat, i * 3));
  return flat;
}

/** Catmull-Rom spline sampled with three's curve classes (the same ones
 * drei's CatmullRomLine uses) and rendered through viser's <Line>, which
 * handles the world-unit antialiasing passes. */
function CatmullRomSpline({ message }: { message: CatmullRomSplineMessage }) {
  const p = message.props;
  const sampledPoints = React.useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(
      tripletListFromFloat32Array(p.points).map(
        (xyz) => new THREE.Vector3(...xyz),
      ),
      p.closed,
      p.curve_type,
      p.tension,
    );
    return flatFromVector3List(curve.getPoints(p.segments ?? 20));
  }, [p.points, p.closed, p.curve_type, p.tension, p.segments]);
  return (
    <Line
      points={sampledPoints}
      lineWidth={p.thickness}
      worldUnits={p.thickness_units === "world"}
      color={rgbToInt(p.color)}
    />
  );
}

/** Cubic Bezier spline, one curve per consecutive point pair (matching
 * drei's CubicBezierLine), rendered through viser's <Line>. */
function CubicBezierSpline({ message }: { message: CubicBezierSplineMessage }) {
  const p = message.props;
  const sampledCurves = React.useMemo(() => {
    const pts = tripletListFromFloat32Array(p.points);
    const controls = tripletListFromFloat32Array(p.control_points);
    const curves: Float32Array[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const curve = new THREE.CubicBezierCurve3(
        new THREE.Vector3(...pts[i]),
        new THREE.Vector3(...controls[2 * i]),
        new THREE.Vector3(...controls[2 * i + 1]),
        new THREE.Vector3(...pts[i + 1]),
      );
      curves.push(flatFromVector3List(curve.getPoints(p.segments ?? 20)));
    }
    return curves;
  }, [p.points, p.control_points, p.segments]);
  return (
    <>
      {sampledCurves.map((sampledPoints, i) => (
        <Line
          key={i}
          points={sampledPoints}
          lineWidth={p.thickness}
          worldUnits={p.thickness_units === "world"}
          color={rgbToInt(p.color)}
        />
      ))}
    </>
  );
}

export type MakeObject = (
  ref: React.Ref<any>,
  children: React.ReactNode,
) => React.ReactNode;

/** SpotLight wrapper that sets up a target object so the light points in the
 *  correct direction rather than always toward the world origin. */
const ViserSpotLight = React.forwardRef<
  THREE.Group,
  {
    message: SpotLightMessage;
    shadowArgs: Record<string, any>;
    children?: React.ReactNode;
  }
>(function ViserSpotLight({ message, shadowArgs: sa, children }, ref) {
  const spotlightRef = React.useRef<THREE.SpotLight>(null);
  const targetRef = React.useRef<THREE.Object3D>(null);
  const p = message.props;

  useEffect(() => {
    const light = spotlightRef.current;
    const target = targetRef.current;
    if (light && target) {
      light.target = target;
    }
  }, []);

  return (
    <group ref={ref}>
      <spotLight
        ref={spotlightRef}
        position={[0, 0, 0]}
        intensity={p.intensity}
        color={rgbToInt(p.color)}
        distance={p.distance}
        angle={p.angle}
        penumbra={p.penumbra}
        decay={p.decay}
        castShadow={p.cast_shadow}
        {...sa}
      />
      <object3D
        ref={targetRef}
        position={[p.direction[0], p.direction[1], p.direction[2]]}
      />
      {children}
    </group>
  );
});

/** Body of a 3D GUI container: a Paper panel bridged into drei's <Html />
 * (which mounts a separate ReactDOM root, so React context doesn't flow into
 * it). The bridge lives HERE rather than in SceneNodeThreeObject on purpose:
 * its-fine's useContextBridge → useFiber does a depth-first search of the
 * whole R3F fiber tree to find the calling component, so calling it once per
 * scene node made scene construction O(N²). Only the (few) Gui3D nodes pay
 * for it now. */
function Gui3DHtmlPanel(props: { containerUuid: string }) {
  const ContextBridge = useContextBridge();
  return (
    <ContextBridge>
      <Paper
        style={{
          width: "18em",
          fontSize: "0.875em",
          marginLeft: "0.5em",
          marginTop: "0.5em",
        }}
        shadow="0 0 0.8em 0 rgba(0,0,0,0.1)"
        pb="0.25em"
        onPointerDown={(evt) => {
          evt.stopPropagation();
        }}
      >
        <GeneratedGuiContainer containerUuid={props.containerUuid} />
      </Paper>
    </ContextBridge>
  );
}

function createObjectFactory(
  message: SceneNodeMessage | undefined,
  viewer: ViewerContextContents,
): {
  makeObject: MakeObject;
  unmountWhenInvisible?: boolean;
  /** Set if everything that's drawn by this object is either part of a batch, or
   * declared with useDrawable(). See SceneNodeGraph. */
  tracksDrawables?: boolean;
  /** Set if nothing in this object moves, except for when the message changes or
   * when useMarkTransformsDirty() is used. See SceneNodeGraph. */
  staticTransforms?: boolean;
  computeClickInstanceIndexFromInstanceId?: (
    instanceId: number | undefined,
  ) => number | null;
} {
  if (message === undefined) return { makeObject: () => null };

  switch (message.type) {
    // Add a coordinate frame.
    case "FrameMessage": {
      return {
        tracksDrawables: true,
        staticTransforms: true,
        makeObject: (ref, children) => (
          <CoordinateFrame
            ref={ref}
            showAxes={message.props.show_axes}
            axesLength={message.props.axes_length}
            axesRadius={message.props.axes_radius}
            originRadius={message.props.origin_radius}
            originColor={rgbToInt(message.props.origin_color)}
            scale={message.props.scale}
          >
            {children}
          </CoordinateFrame>
        ),
      };
    }

    // Add axes to visualize.
    case "BatchedAxesMessage": {
      return {
        staticTransforms: true,
        makeObject: (ref, children) => (
          <InstancedAxes
            ref={ref}
            batched_wxyzs={message.props.batched_wxyzs}
            batched_positions={message.props.batched_positions}
            batched_scales={message.props.batched_scales}
            axes_length={message.props.axes_length}
            axes_radius={message.props.axes_radius}
            scale={message.props.scale}
          >
            {children}
          </InstancedAxes>
        ),
        // Compute click instance index from instance ID. Each visualized
        // frame has 1 instance for each of 3 line segments.
        computeClickInstanceIndexFromInstanceId: (instanceId) =>
          Math.floor(instanceId! / 3),
      };
    }

    case "GridMessage": {
      // There's redundancy here when we set the side to
      // THREE.DoubleSide, where xy and yx should be the same.
      //
      // But it makes sense to keep this parameterization because
      // specifying planes by xy seems more natural than the normal
      // direction (z, +z, or -z), and it opens the possibility of
      // rendering only FrontSide or BackSide grids in the future.
      //
      // If we add support for FrontSide or BackSide, we should
      // double-check that the normal directions from each of these
      // rotations match the right-hand rule!
      const planeEulers: Record<string, [number, number, number]> = {
        xz: [0.0, 0.0, 0.0],
        xy: [Math.PI / 2.0, 0.0, 0.0],
        yx: [0.0, Math.PI / 2.0, Math.PI / 2.0],
        yz: [0.0, 0.0, Math.PI / 2.0],
        zx: [0.0, Math.PI / 2.0, 0.0],
        zy: [-Math.PI / 2.0, 0.0, -Math.PI / 2.0],
      };
      const gridQuaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          ...(planeEulers[message.props.plane] ?? planeEulers.zy),
        ),
      );

      return {
        makeObject: (ref, children) => (
          <group ref={ref}>
            <group scale={normalizeScale(message.props.scale)}>
              <Grid
                args={[message.props.width, message.props.height]}
                side={THREE.DoubleSide}
                cellColor={rgbToInt(message.props.cell_color)}
                cellThickness={message.props.cell_thickness}
                cellSize={message.props.cell_size}
                sectionColor={rgbToInt(message.props.section_color)}
                sectionThickness={message.props.section_thickness}
                sectionSize={message.props.section_size}
                infiniteGrid={message.props.infinite_grid}
                // Slide the grid geometry to track the camera so an infinite
                // grid never reveals its edge. Only valid when the fade is also
                // camera-relative; with fade_from="origin" the grid would fade
                // to nothing once the camera moves past fade_distance.
                followCamera={
                  message.props.infinite_grid &&
                  message.props.fade_from === "camera"
                }
                fadeDistance={message.props.fade_distance}
                fadeStrength={message.props.fade_strength}
                fadeFrom={message.props.fade_from === "camera" ? 1 : 0}
                planeColor={rgbToInt(message.props.plane_color)}
                planeOpacity={message.props.plane_opacity}
                shadowOpacity={message.props.shadow_opacity}
                quaternion={gridQuaternion}
              />
            </group>
            {children}
          </group>
        ),
      };
    }

    // Add a point cloud.
    case "PointCloudMessage": {
      return {
        staticTransforms: true,
        makeObject: (ref, children) => (
          <PointCloud ref={ref} {...message}>
            {children}
          </PointCloud>
        ),
      };
    }

    // Add mesh.
    case "SkinnedMeshMessage": {
      return {
        makeObject: (ref, children) => (
          <SkinnedMesh ref={ref} {...message}>
            {children}
          </SkinnedMesh>
        ),
      };
    }
    case "MeshMessage": {
      return {
        tracksDrawables: true,
        staticTransforms: true,
        makeObject: (ref, children) => (
          <BasicMesh ref={ref} {...message}>
            {children}
          </BasicMesh>
        ),
      };
    }
    case "BoxMessage": {
      return {
        tracksDrawables: true,
        staticTransforms: true,
        makeObject: (ref, children) => (
          <BoxMesh ref={ref} {...message}>
            {children}
          </BoxMesh>
        ),
      };
    }
    case "IcosphereMessage": {
      return {
        tracksDrawables: true,
        staticTransforms: true,
        makeObject: (ref, children) => (
          <IcosphereMesh ref={ref} {...message}>
            {children}
          </IcosphereMesh>
        ),
      };
    }
    case "CylinderMessage": {
      return {
        tracksDrawables: true,
        staticTransforms: true,
        makeObject: (ref, children) => (
          <CylinderMesh ref={ref} {...message}>
            {children}
          </CylinderMesh>
        ),
      };
    }
    case "BatchedMeshesMessage": {
      return {
        makeObject: (ref, children) => (
          <BatchedMesh ref={ref} {...message}>
            {children}
          </BatchedMesh>
        ),
        computeClickInstanceIndexFromInstanceId:
          message.type === "BatchedMeshesMessage"
            ? (instanceId) => instanceId!
            : undefined,
      };
    }
    // Add a camera frustum.
    case "CameraFrustumMessage": {
      return {
        tracksDrawables: true,
        // The image is loaded asynchronously, but declares when it's added.
        staticTransforms: true,
        makeObject: (ref, children) => (
          <CameraFrustumComponent ref={ref} {...message}>
            {children}
          </CameraFrustumComponent>
        ),
      };
    }

    // Add a transform control, centered at current object.
    case "TransformControlsMessage": {
      const { send: sendDragMessage, flush: flushDragMessage } =
        makeThrottledMessageSender(viewer, 50);
      // We track drag state to prevent duplicate drag end events.
      // This variable persists in the closure created by makeObject,
      // so we don't need useRef here.
      let isDragging = false;
      return {
        makeObject: (ref, children) => (
          <group onClick={(e) => e.stopPropagation()}>
            <PivotControls
              ref={ref}
              scale={message.props.scale}
              lineWidth={message.props.line_width}
              fixed={message.props.fixed}
              activeAxes={message.props.active_axes}
              disableAxes={message.props.disable_axes}
              disableSliders={message.props.disable_sliders}
              disableRotations={message.props.disable_rotations}
              disableScaling={true}
              translationLimits={message.props.translation_limits}
              rotationLimits={message.props.rotation_limits}
              depthTest={message.props.depth_test}
              opacity={message.props.opacity}
              onDragStart={() => {
                isDragging = true;
                viewer.mutable.current.sendMessage({
                  type: "TransformControlsDragStartMessage",
                  name: message.name,
                  owner: ownerOf(message),
                });
              }}
              onDrag={(l) => {
                const wxyz = new THREE.Quaternion();
                wxyz.setFromRotationMatrix(l);
                const position = new THREE.Vector3().setFromMatrixPosition(l);

                // Update node attributes in scene tree state.
                const wxyzArray = [wxyz.w, wxyz.x, wxyz.y, wxyz.z] as [
                  number,
                  number,
                  number,
                  number,
                ];
                const positionArray = position.toArray() as [
                  number,
                  number,
                  number,
                ];
                viewer.sceneTreeActions.updateNodeAttributes(message.name, {
                  wxyz: wxyzArray,
                  position: positionArray,
                });
                // Also mirror the pose into nodePoseData, which is what a
                // remount applies (PivotControls unmounts when invisible).
                // The server can't do this for us: its pose re-broadcasts
                // exclude the dragging client, so without this write a
                // visibility toggle after a drag restored the pre-drag pose.
                // poseUpdateState is left alone -- the pivot's object already
                // shows this pose; only a remount needs to re-apply it.
                const pose = viewer.mutable.current.nodePoseData[message.name];
                if (pose !== undefined) {
                  pose.wxyz = wxyzArray;
                  pose.position = positionArray;
                }
                sendDragMessage({
                  type: "TransformControlsUpdateMessage",
                  name: message.name,
                  wxyz: wxyzArray,
                  position: positionArray,
                  owner: ownerOf(message),
                });
              }}
              onDragEnd={() => {
                if (isDragging) {
                  isDragging = false;
                  flushDragMessage();
                  viewer.mutable.current.sendMessage({
                    type: "TransformControlsDragEndMessage",
                    name: message.name,
                    owner: ownerOf(message),
                  });
                }
              }}
            >
              {children}
            </PivotControls>
          </group>
        ),
        unmountWhenInvisible: true,
      };
    }
    // Add a 2D label.
    case "LabelMessage": {
      return {
        tracksDrawables: true,
        staticTransforms: true,
        makeObject: (ref, children) => (
          <ViserLabel ref={ref} {...message}>
            {children}
          </ViserLabel>
        ),
        unmountWhenInvisible: false,
      };
    }
    case "Gui3DMessage": {
      return {
        makeObject: (ref, children) => {
          // We wrap with <group /> because Html doesn't implement
          // THREE.Object3D.
          return (
            <group ref={ref}>
              <Html>
                <Gui3DHtmlPanel containerUuid={message.props.container_uuid} />
              </Html>
              {children}
            </group>
          );
        },
        unmountWhenInvisible: true,
      };
    }
    // Add an image.
    case "ImageMessage": {
      return {
        staticTransforms: true,
        makeObject: (ref, children) => (
          <ViserImage ref={ref} {...message}>
            {children}
          </ViserImage>
        ),
      };
    }
    // Add a glTF/GLB asset.
    case "GlbMessage": {
      return {
        makeObject: (ref, children) => (
          <SingleGlbAsset ref={ref} {...message}>
            {children}
          </SingleGlbAsset>
        ),
      };
    }
    case "BatchedGlbMessage": {
      return {
        makeObject: (ref, children) => (
          <BatchedGlbAsset ref={ref} {...message}>
            {children}
          </BatchedGlbAsset>
        ),
        computeClickInstanceIndexFromInstanceId: (instanceId) => instanceId!,
      };
    }
    case "LineSegmentsMessage": {
      return {
        staticTransforms: true,
        makeObject: (ref, children) => (
          <LineSegments ref={ref} {...message}>
            {children}
          </LineSegments>
        ),
      };
    }
    case "ArrowMessage": {
      return {
        makeObject: (ref, children) => (
          <Arrows ref={ref} {...message}>
            {children}
          </Arrows>
        ),
      };
    }
    case "CatmullRomSplineMessage": {
      return {
        staticTransforms: true,
        makeObject: (ref, children) => {
          return (
            <group ref={ref}>
              <group scale={normalizeScale(message.props.scale)}>
                <CatmullRomSpline message={message} />
              </group>
              {children}
            </group>
          );
        },
      };
    }
    case "CubicBezierSplineMessage": {
      return {
        staticTransforms: true,
        makeObject: (ref, children) => {
          return (
            <group ref={ref}>
              <group scale={normalizeScale(message.props.scale)}>
                <CubicBezierSpline message={message} />
              </group>
              {children}
            </group>
          );
        },
      };
    }
    case "GaussianSplatsMessage": {
      return {
        makeObject: (ref, children) => (
          <group ref={ref}>
            <group scale={normalizeScale(message.props.scale)}>
              <SplatObject
                buffer={message.props.buffer}
                sceneNodeName={message.name}
              />
            </group>
            {children}
          </group>
        ),
      };
    }

    // Add a directional light.
    case "DirectionalLightMessage": {
      return {
        makeObject: (ref, children) => (
          <group ref={ref}>
            <CascadedDirectionalLight
              lightIntensity={message.props.intensity}
              color={rgbToInt(message.props.color)}
              castShadow={message.props.cast_shadow}
            />
            {children}
          </group>
        ),
        // CascadedDirectionalLight is not influenced by visibility, since the
        // lights it adds are portaled to the scene root.
        unmountWhenInvisible: true,
      };
    }

    // Add an ambient light.
    // Cannot cast shadows.
    case "AmbientLightMessage": {
      return {
        makeObject: (ref, children) => (
          <ambientLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
          >
            {children}
          </ambientLight>
        ),
      };
    }

    // Add a hemisphere light.
    // Cannot cast shadows.
    case "HemisphereLightMessage": {
      return {
        makeObject: (ref, children) => (
          <hemisphereLight
            ref={ref}
            position={[0, 0, 0]}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.sky_color)}
            groundColor={rgbToInt(message.props.ground_color)}
          >
            {children}
          </hemisphereLight>
        ),
      };
    }

    // Add a point light.
    case "PointLightMessage": {
      return {
        makeObject: (ref, children) => (
          <pointLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
            distance={message.props.distance}
            decay={message.props.decay}
            castShadow={message.props.cast_shadow}
            {...shadowArgs}
          >
            {children}
          </pointLight>
        ),
      };
    }
    // Add a rectangular area light.
    // Cannot cast shadows.
    case "RectAreaLightMessage": {
      return {
        makeObject: (ref, children) => (
          <rectAreaLight
            ref={ref}
            intensity={message.props.intensity}
            color={rgbToInt(message.props.color)}
            width={message.props.width}
            height={message.props.height}
          >
            {children}
          </rectAreaLight>
        ),
      };
    }

    // Add a spot light.
    case "SpotLightMessage": {
      return {
        makeObject: (ref, children) => (
          <ViserSpotLight ref={ref} message={message} shadowArgs={shadowArgs}>
            {children}
          </ViserSpotLight>
        ),
      };
    }
    default: {
      console.log("Received message did not match any known types:", message);
      return { makeObject: () => null };
    }
  }
}

function identity<T>(x: T): T {
  return x;
}

/** Equality for everything that a scene node's component depends on.
 *
 * shallowArrayEqual: the server echoes a fresh `bindings` array on every binding
 * update even if the content is unchanged; this prevents spurious re-renders
 * when the binding set is identical. */
function sceneNodeRenderEqual(
  a: SceneNode | undefined,
  b: SceneNode | undefined,
): boolean {
  return (
    a === b ||
    (a?.message === b?.message &&
      shallowArrayEqual(a?.clickBindings, b?.clickBindings) &&
      shallowArrayEqual(a?.dragBindings, b?.dragBindings))
  );
}

/** Applies pending updates (pose, visibility, ...) to the three.js objects of
 * scene nodes. */
export function SceneNodeUpdater() {
  const viewer = React.useContext(ViewerContext)!;
  useFrame(
    () => viewer.sceneNodeUpdates.flush(),
    // Other useFrame hooks may depend on transforms + visibility. So it's best
    // to call this hook early.
    //
    // However, it's also important that this is *higher* than the priority for
    // the MessageHandler's useFrame. This is to make sure that transforms are
    // updated in the same frame that they are set.
    -1000,
  );
  return null;
}

/** Three.js objects for a scene node and its descendants.
 *
 * Scenes can have tens of thousands of these, so the number of hooks should be
 * kept to a minimum. Anything that doesn't need to be a hook belongs in
 * SceneNodeController. Memoized to prevent a parent from re-rendering all of its
 * children when one is added or removed. */
export const SceneNodeThreeObject = React.memo(
  function SceneNodeThreeObject(props: { name: string }) {
    const viewer = React.useContext(ViewerContext)!;
    const threeStore = useStore();
    // Drag state lives in the viewer-level DragLayer -- nodes only dispatch
    // pointer events into it and read bindings for matching.
    const dragLayer = useDragLayer();
    const renderState = viewer.useSceneTree(
      props.name,
      identity,
      sceneNodeRenderEqual,
    );
    const clickBindings = renderState?.clickBindings ?? EMPTY_DRAG_BINDINGS;
    const dragBindings = renderState?.dragBindings ?? EMPTY_DRAG_BINDINGS;
    const clickable = clickBindings.length > 0;
    const draggable = dragBindings.length > 0;
    const interactive = clickable || draggable;

    const [unmount, setUnmount] = React.useState(false);
    const [controller] = React.useState(
      () => new SceneNodeController(props.name, viewer, threeStore, setUnmount),
    );
    const { hoverState } = controller;

    // Create object + children.
    //
    // For not-fully-understood reasons, wrapping makeObject with useMemo() fixes
    // stability issues (eg breaking runtime errors) associated with
    // PivotControls.
    const message = renderState?.message;
    const [factory, objNode] = React.useMemo(() => {
      const factory = createObjectFactory(message, viewer);
      return [
        factory,
        factory.makeObject(
          (ref: THREE.Object3D | null) => controller.setObject(ref),
          <SceneNodeChildren name={props.name} />,
        ),
      ];
    }, [message, viewer, controller, props.name]);
    const {
      unmountWhenInvisible = false,
      computeClickInstanceIndexFromInstanceId,
      tracksDrawables = false,
      staticTransforms = false,
    } = factory;

    React.useLayoutEffect(() => {
      controller.latest = {
        isLabel: message?.type === "LabelMessage",
        unmount,
        unmountWhenInvisible,
        clickBindings,
        dragBindings,
        dragLayer,
        computeClickInstanceIndexFromInstanceId,
      };
      // Visibility may have changed again while a change to `unmount` was
      // pending.
      viewer.sceneNodeUpdates.markDirty(props.name);
    });
    React.useLayoutEffect(() => controller.mount(), [controller]);
    React.useLayoutEffect(() => {
      const { sceneNodeGraph } = viewer;
      // Anything about the object may have changed.
      sceneNodeGraph.markTransformsDirty(props.name);
      const removeDrawable = tracksDrawables
        ? null
        : sceneNodeGraph.addDrawable(props.name);
      const removeDynamic = staticTransforms
        ? null
        : sceneNodeGraph.addDynamic(props.name);
      return () => {
        removeDrawable?.();
        removeDynamic?.();
      };
    }, [objNode]);
    React.useEffect(() => controller.onObjectChanged(), [objNode]);
    React.useEffect(
      () => controller.onInteractivityChanged(interactive, draggable),
      [controller, interactive, draggable, dragLayer],
    );
    React.useEffect(() => () => controller.onRemoved(), [controller]);

    // Pointer events on descendants bubble up to us, so they need to be
    // raycast against too.
    const raycastable =
      (React.useContext(HoverableContext)?.raycastable ?? false) || interactive;
    const hoverContextValue = React.useMemo(
      () => ({
        nodeName: props.name,
        state: hoverState,
        clickable,
        raycastable,
      }),
      [props.name, hoverState, clickable, raycastable],
    );

    if (unmount) return null;
    return (
      <sceneNodeGroup
        ref={controller.setGroup}
        {...(interactive ? controller.getHandlers() : noSceneNodeHandlers)}
      >
        <HoverableContext.Provider value={hoverContextValue}>
          {objNode}
        </HoverableContext.Provider>
      </sceneNodeGroup>
    );
  },
);

function sceneNodeChildrenEqual(
  a: SceneNode | undefined,
  b: SceneNode | undefined,
): boolean {
  return (
    a === b ||
    (a?.labelVisible === b?.labelVisible &&
      shallowArrayEqual(a?.children, b?.children))
  );
}

const SceneNodeChildren = React.memo(function SceneNodeChildren(props: {
  name: string;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const node = viewer.useSceneTree(
    props.name,
    identity,
    sceneNodeChildrenEqual,
  );
  return (
    <>
      {node?.children.map((child_id) => (
        <SceneNodeThreeObject key={child_id} name={child_id} />
      ))}
      {node?.labelVisible ? <SceneNodeLabel name={props.name} /> : null}
    </>
  );
});
