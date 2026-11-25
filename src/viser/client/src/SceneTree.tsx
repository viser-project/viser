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
import { rayToViserCoords } from "./WorldTransformUtils";
import { HoverableContext, HoverState } from "./HoverContext";
import { shallowArrayEqual } from "./utils/shallowArrayEqual";
import { DragBinding } from "./dragUtils";
import { useDragLayer } from "./dragLayerContext";
import {
  DragInput,
  anyBindingMatches,
  keyModifierFromEvent,
  pointerButtonFromNative,
} from "./dragUtils";
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
import { InstanceSource } from "./scene/AutoInstancer";
import { SceneNodeGroup } from "./scene/SceneNodeGroup";
import { normalizeScale } from "./utils/normalizeScale";
import { opencvXyFromPointerXy } from "./utils/pointerCoords";

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
 * Scenes can have tens of thousands of these, so hooks here should be kept to a
 * minimum. Memoized to prevent a parent from re-rendering all of its children
 * when one is added or removed. */
export const SceneNodeThreeObject = React.memo(
  function SceneNodeThreeObject(props: { name: string }) {
    const viewer = React.useContext(ViewerContext)!;
    const renderState = viewer.useSceneTree(
      props.name,
      identity,
      sceneNodeRenderEqual,
    );
    const message = renderState?.message;
    const {
      makeObject,
      unmountWhenInvisible,
      computeClickInstanceIndexFromInstanceId,
      tracksDrawables = false,
      staticTransforms = false,
    } = React.useMemo(
      () => createObjectFactory(message, viewer),
      [message, viewer],
    );

    const [unmount, setUnmount] = React.useState(false);
    const clickBindings = renderState?.clickBindings ?? EMPTY_DRAG_BINDINGS;
    const dragBindings = renderState?.dragBindings ?? EMPTY_DRAG_BINDINGS;
    const clickable = clickBindings.length > 0;
    const draggable = dragBindings.length > 0;
    const interactive = clickable || draggable;
    const objRef = React.useRef<THREE.Object3D | null>(null);
    const groupRef = React.useRef<THREE.Group | null>(null);
    const { sceneNodeGraph } = viewer;
    const setGroupRef = React.useCallback(
      (group: SceneNodeGroup) => {
        groupRef.current = group;
        sceneNodeGraph.attachGroup(props.name, group);
        return () => {
          groupRef.current = null;
          sceneNodeGraph.detachGroup(props.name, group);
        };
      },
      [sceneNodeGraph, props.name],
    );
    React.useLayoutEffect(() => {
      if (!tracksDrawables) return sceneNodeGraph.addDrawable(props.name);
    }, [sceneNodeGraph, props.name, tracksDrawables]);
    React.useLayoutEffect(() => {
      if (!staticTransforms) return sceneNodeGraph.addDynamic(props.name);
    }, [sceneNodeGraph, props.name, staticTransforms]);

    // Get children.
    const children = React.useMemo(
      () => <SceneNodeChildren name={props.name} />,
      [],
    );

    // Create object + children.
    //
    // For not-fully-understood reasons, wrapping makeObject with useMemo() fixes
    // stability issues (eg breaking runtime errors) associated with
    // PivotControls.
    const viewerMutable = viewer.mutable.current;
    const objNode = React.useMemo(() => {
      if (makeObject === undefined) return null;
      return makeObject((ref: THREE.Object3D | null) => {
        if (ref === null) {
          // React detaches a ref with null: on unmount, or when an
          // unmountWhenInvisible node hides. nodeRefFromName is typed as
          // Object3D | undefined, so drop the entry rather than store the null
          // (readers that only check `!== undefined` would crash on it, see
          // #788). Only drop it if it is still ours: a successor mounted under
          // the same name has already registered by the time we detach.
          if (viewerMutable.nodeRefFromName[props.name] === objRef.current) {
            delete viewerMutable.nodeRefFromName[props.name];
          }
          objRef.current = null;
          return;
        }
        objRef.current = ref;
        viewerMutable.nodeRefFromName[props.name] = ref;
        // Poses are the only thing that modifies a node's local transform, and
        // they're applied below. Don't recompute it every frame.
        if (ref.matrixAutoUpdate) {
          ref.matrixAutoUpdate = false;
          ref.updateMatrix();
        }
        viewer.sceneNodeUpdates.markDirty(props.name);
      }, children);
    }, [makeObject, children]);

    // Helper for transient visibility checks. Uses the cached effectiveVisibility
    // which includes both this node and all ancestors in the scene tree.
    //
    // This is used for (1) suppressing click events and (2) unmounting when
    // unmountWhenInvisible is true. The latter is used for <Html /> components.
    function isDisplayed(): boolean {
      const node = viewer.useSceneTree.get(props.name);
      return node?.effectiveVisibility ?? false;
    }

    // Anything about the object may have changed.
    React.useLayoutEffect(() => {
      sceneNodeGraph.markTransformsDirty(props.name);
    }, [objNode]);

    // Pose needs to be updated whenever component is remounted / object is re-created.
    React.useEffect(() => {
      const pose = viewerMutable.nodePoseData[props.name];
      if (pose) {
        pose.poseUpdateState = "needsUpdate";
        viewer.sceneNodeUpdates.markDirty(props.name);
      }
      if (isFirstObjNode.current) {
        isFirstObjNode.current = false;
        return;
      }
      if (hoverState.isHovered) {
        // Wait 2 frames for the new mesh to be fully rendered.
        hoverRecheckCountdown.current = 2;
        viewer.sceneNodeUpdates.markDirty(props.name);
      }
    }, [objNode]);

    // Track hover state.
    const hoverState = React.useState(() => new HoverState())[0];

    // Track last pointer position for re-raycasting when mesh changes.
    const lastPointerPos = React.useRef<{
      clientX: number;
      clientY: number;
    } | null>(null);

    // Frame counter for delayed hover recheck after objNode changes.
    // We wait a few frames to ensure the new mesh geometry is fully rendered.
    const hoverRecheckCountdown = React.useRef(0);
    const isFirstObjNode = React.useRef(true);

    // R3F state for raycasting. Non-reactive: subscribing would re-render every
    // scene node when the store changes (resize ticks, dock drags, adaptive DPR).
    const threeStore = useStore();

    // Drag state lives in the viewer-level DragLayer -- this component only
    // dispatches pointer events into it and reads bindings for matching.
    const dragLayer = useDragLayer();
    const interaction = viewer.interaction;

    const getPointerXy = React.useCallback(
      (clientX: number, clientY: number): [number, number] => {
        const canvasBbox = viewerMutable.canvas!.getBoundingClientRect();
        return [clientX - canvasBbox.left, clientY - canvasBbox.top];
      },
      [viewerMutable],
    );

    // Sync attributes to the three.js object. Runs at the start of a frame if
    // any of the state that it depends on has been marked dirty.
    const applyUpdates = () => {
      // Re-check hover state after objNode changes (mesh geometry update).
      if (hoverRecheckCountdown.current > 0) {
        hoverRecheckCountdown.current--;
        // The countdown needs consecutive frames (on-demand loop).
        if (hoverRecheckCountdown.current > 0) {
          viewer.sceneNodeUpdates.markDirty(props.name);
          viewerMutable.requestRender();
        }
        if (
          hoverRecheckCountdown.current === 0 &&
          hoverState.isHovered &&
          groupRef.current &&
          lastPointerPos.current
        ) {
          // Compute NDC from stored pointer position.
          const canvas = viewerMutable.canvas;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            const { raycaster, camera } = threeStore.getState();
            const pointerNDC = new THREE.Vector2(
              ((lastPointerPos.current.clientX - rect.left) / rect.width) * 2 -
                1,
              -((lastPointerPos.current.clientY - rect.top) / rect.height) * 2 +
                1,
            );
            raycaster.setFromCamera(pointerNDC, camera);
            const intersects = raycaster.intersectObject(
              groupRef.current,
              true,
            );
            if (intersects.length === 0) {
              // Pointer is no longer over this mesh, reset hover state.
              hoverState.set(false, null);
              interaction.hover.setHovered(props.name, false);
            }
          }
        }
      }

      // Use .get() for performance in render loops (no re-renders).
      const node = viewer.useSceneTree.get(props.name);

      // Unmount when invisible.
      // Examples: <Html /> components, PivotControls.
      //
      // This is a workaround for situations where just setting `visible` doesn't
      // work (like <Html />), or to prevent invisible elements from being
      // interacted with (<PivotControls />).
      //
      // https://github.com/pmndrs/drei/issues/1323
      if (unmountWhenInvisible) {
        const displayed = isDisplayed();
        if (displayed && unmount) {
          if (objRef.current !== null) objRef.current.visible = false;
          const pose = viewerMutable.nodePoseData[props.name];
          if (pose) pose.poseUpdateState = "needsUpdate";
          setUnmount(false);
        }
        if (!displayed && !unmount) {
          setUnmount(true);
        }
      }

      if (objRef.current === null) return;
      if (node === undefined) return;

      // Set node-local visibility. Three.js automatically handles parent chain
      // propagation (children of invisible parents are not rendered).
      objRef.current.visible =
        node.overrideVisibility ?? node.visibility ?? true;
      if (objRef.current instanceof InstanceSource) {
        objRef.current.setDisplayed(node.effectiveVisibility ?? true);
      }

      // If an interactive node becomes invisible while hovered, clean up hover
      // state so the cursor doesn't stay stuck as "pointer".
      if (!node.effectiveVisibility && hoverState.isHovered && interactive) {
        hoverState.set(false, null);
        interaction.hover.setHovered(props.name, false);
      }

      // If a node disappears mid-drag, end the drag cleanly.
      if (!node.effectiveVisibility && dragLayer !== null) {
        dragLayer.stopIfNodeIs(props.name);
      }

      // Read pose from mutable ref (non-reactive, no re-renders).
      const pose = viewerMutable.nodePoseData[props.name];
      if (pose && pose.poseUpdateState === "needsUpdate") {
        pose.poseUpdateState = "updated";

        if (message!.type !== "LabelMessage") {
          const wxyz = pose.wxyz;
          objRef.current.quaternion.set(wxyz[1], wxyz[2], wxyz[3], wxyz[0]);
        }
        const position = pose.position;
        objRef.current.position.set(position[0], position[1], position[2]);

        // Update matrices if necessary. This is necessary for PivotControls.
        if (!objRef.current.matrixAutoUpdate) objRef.current.updateMatrix();
        if (!objRef.current.matrixWorldAutoUpdate)
          objRef.current.updateMatrixWorld();
        sceneNodeGraph.markTransformsDirty(props.name);
      }
    };
    const applyUpdatesRef = React.useRef(applyUpdates);
    React.useLayoutEffect(() => {
      applyUpdatesRef.current = applyUpdates;
    });
    React.useLayoutEffect(
      () =>
        viewer.sceneNodeUpdates.register(props.name, () =>
          applyUpdatesRef.current(),
        ),
      [viewer, props.name],
    );
    // Visibility may have changed again while a change to `unmount` was pending.
    React.useLayoutEffect(() => {
      viewer.sceneNodeUpdates.markDirty(props.name);
    }, [viewer, props.name, unmount]);

    // Clicking logic. The sender is created on the first click.
    const clickSenderRef = React.useRef<ReturnType<
      typeof makeThrottledMessageSender
    > | null>(null);

    // Handle case where interactivity is toggled off while still hovered. Not
    // during render: components that show the hover state are notified.
    React.useLayoutEffect(() => {
      if (!interactive && hoverState.isHovered) {
        hoverState.set(false, null);
        interaction.hover.setHovered(props.name, false);
        interaction.nodeGestures.cancelNode(props.name);
      }
    }, [interactive, hoverState, interaction, props.name]);

    // End the active drag if this node's draggability is revoked (bindings
    // cleared) or the component unmounts. DragLayer no-ops if the active
    // drag targets a different node, so this is safe to call unconditionally.
    React.useEffect(() => {
      if (!draggable && dragLayer !== null) {
        dragLayer.stopIfNodeIs(props.name);
        interaction.nodeGestures.cancelNode(props.name);
      }
    }, [draggable, dragLayer, interaction, props.name]);

    // Reset hover state on true unmount, and tell DragLayer to end the
    // drag if it targets this node.
    const dragLayerRef = React.useRef(dragLayer);
    dragLayerRef.current = dragLayer;
    useEffect(() => {
      return () => {
        if (hoverState.isHovered) {
          hoverState.set(false, null);
          interaction.hover.setHovered(props.name, false);
        }
        clickSenderRef.current?.cancel();
        dragLayerRef.current?.stopIfNodeIs(props.name);
        interaction.nodeGestures.cancelNode(props.name);
      };
    }, [interaction, props.name]);

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

    if (objNode === undefined || unmount) {
      return null;
    } else {
      return (
        <>
          <sceneNodeGroup
            ref={setGroupRef}
            // Instead of using onClick, we use onPointerDown/Move/Up to check mouse drag,
            // and only send a click if the mouse hasn't moved between the down and up events.
            //  - onPointerDown resets the click state (dragged = false)
            //  - onPointerMove, if triggered, sets dragged = true
            //  - onPointerUp, if triggered, sends a click if dragged = false.
            // Note: It would be cool to have dragged actions too...
            onPointerDown={
              !interactive
                ? undefined
                : (e) => {
                    if (!isDisplayed()) return;
                    e.stopPropagation();
                    const buttonName = pointerButtonFromNative(
                      e.nativeEvent.button,
                    );
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
                    const targetObj = objRef.current;
                    const dragMatches =
                      input !== null &&
                      draggable &&
                      dragLayer !== null &&
                      targetObj !== null &&
                      anyBindingMatches(dragBindings, input);
                    if (!clickMatches && !dragMatches) return;

                    const beginDragArgs =
                      dragMatches &&
                      input !== null &&
                      dragLayer !== null &&
                      targetObj !== null
                        ? {
                            nodeName: props.name,
                            // Batched handles (meshes/GLBs/axes) set
                            // computeClickInstanceIndexFromInstanceId; plain
                            // handles leave it undefined and instance_index
                            // is null on the wire.
                            instanceIndex:
                              computeClickInstanceIndexFromInstanceId ===
                              undefined
                                ? null
                                : computeClickInstanceIndexFromInstanceId(
                                    e.instanceId,
                                  ),
                            targetObj,
                            eventPoint: e.point,
                            pointerXy: getPointerXy(e.clientX, e.clientY),
                            pointerId: e.nativeEvent.pointerId,
                            input,
                            bindings: dragBindings,
                          }
                        : null;

                    if (clickMatches || dragMatches) {
                      // Every interactive node runs through the
                      // motion-threshold candidate: a stationary press on
                      // a clickable node fires the click without a
                      // spurious drag start/end pair, and a stationary
                      // press on a drag-only node fires nothing at all
                      // (vs. the prior behavior, where dragstart fired
                      // immediately and dragend followed on release with
                      // no motion between -- a degenerate gesture user
                      // code had to special-case).
                      interaction.nodeGestures.beginCandidate({
                        pointerId: e.nativeEvent.pointerId,
                        nodeKey: props.name,
                        startClientXy: [e.clientX, e.clientY],
                        lockCamera: dragMatches,
                        onPromote:
                          beginDragArgs === null || dragLayer === null
                            ? null
                            : (promotionModifier) =>
                                dragLayer.beginDrag({
                                  ...beginDragArgs,
                                  promotionModifier,
                                }),
                      });
                      if (dragMatches) e.nativeEvent.preventDefault();
                    }
                  }
            }
            onContextMenu={
              !interactive
                ? undefined
                : (e) => {
                    if (!isDisplayed()) return;
                    // Suppress the browser context menu only when the
                    // gesture that fired this contextmenu would actually
                    // be consumed by this node. The native contextmenu
                    // event's button code is not reliable across browsers,
                    // so we consult the input recorded by the most recent
                    // pointerdown -- which on macOS includes the
                    // pointerdown that ctrl+left-click raises alongside
                    // the contextmenu event.
                    // Fallback: if no pointerdown was recorded (e.g. the
                    // menu was triggered by the keyboard menu key), use a
                    // plain right-button input -- preserves the original
                    // "right-click on a right-bound node" behavior.
                    const input: DragInput =
                      interaction.nodeGestures.getLastPointerDownInput() ?? {
                        button: "right",
                        modifier: keyModifierFromEvent(e),
                      };
                    const dragMatches = anyBindingMatches(dragBindings, input);
                    const clickMatches = anyBindingMatches(
                      clickBindings,
                      input,
                    );
                    if (!dragMatches && !clickMatches) return;
                    e.nativeEvent.preventDefault();
                    e.stopPropagation();
                  }
            }
            onPointerMove={
              !interactive
                ? undefined
                : (e) => {
                    if (!isDisplayed()) return;
                    e.stopPropagation();

                    // Track pointer position for the useFrame hover
                    // recheck (mesh geometry update / visibility loss).
                    lastPointerPos.current = {
                      clientX: e.clientX,
                      clientY: e.clientY,
                    };
                  }
            }
            onPointerUp={
              !interactive
                ? undefined
                : (e) => {
                    if (!isDisplayed()) return;
                    e.stopPropagation();

                    // Drop the recorded pointerdown input now that the
                    // gesture is over. Prevents stale state from
                    // confusing a later keyboard-triggered contextmenu
                    // (Shift+F10 / Menu key). macOS ctrl+click fires
                    // contextmenu BEFORE pointerup, so the suppression
                    // path has already consumed the value by the time
                    // we clear it.
                    interaction.nodeGestures.clearLastPointerDownInput();
                    // Settle any node-click-candidate. "click" means the
                    // press stayed stationary; "none" means it
                    // promoted to drag, was cancelled, or no candidate
                    // was ever started (for example, a drag-only node).
                    const outcome = interaction.nodeGestures.settlePointerUp({
                      pointerId: e.nativeEvent.pointerId,
                    });
                    if (!clickable || outcome !== "click") return;
                    // Convert ray to viser coordinates.
                    const ray = rayToViserCoords(viewer, e.ray);

                    // Send OpenCV image coordinates to the server (normalized).
                    const mouseVectorOpenCV = opencvXyFromPointerXy(
                      viewer,
                      getPointerXy(e.clientX, e.clientY),
                    );

                    clickSenderRef.current ??= makeThrottledMessageSender(
                      viewer,
                      50,
                    );
                    clickSenderRef.current.send({
                      type: "SceneNodeClickMessage",
                      name: props.name,
                      instance_index:
                        computeClickInstanceIndexFromInstanceId === undefined
                          ? null
                          : computeClickInstanceIndexFromInstanceId(
                              e.instanceId,
                            ),
                      // Note that the threejs up is +Y, but we expose a +Z up.
                      ray_origin: [ray.origin.x, ray.origin.y, ray.origin.z],
                      ray_direction: [
                        ray.direction.x,
                        ray.direction.y,
                        ray.direction.z,
                      ],
                      screen_pos: [mouseVectorOpenCV.x, mouseVectorOpenCV.y],
                      modifier: keyModifierFromEvent(e),
                      // Echo the EFFECTIVE variant's owner: only the mounted
                      // variant is interactive, and the server routes the
                      // event to that scope's registry alone.
                      owner: ownerOf(
                        viewer.useSceneTree.get(props.name)?.message,
                      ),
                    });
                  }
            }
            onPointerCancel={
              !interactive
                ? undefined
                : (e) => {
                    interaction.cancelPointer(e.nativeEvent.pointerId);
                  }
            }
            onPointerOver={
              !interactive
                ? undefined
                : (e) => {
                    if (!isDisplayed()) return;
                    e.stopPropagation();

                    // Store pointer position for re-raycasting when mesh changes.
                    lastPointerPos.current = {
                      clientX: e.clientX,
                      clientY: e.clientY,
                    };

                    // Guard against double-increment if already hovered.
                    if (hoverState.isHovered) return;

                    // Update hover state.
                    hoverState.set(true, e.instanceId ?? null);
                    interaction.hover.setHovered(props.name, true);
                  }
            }
            onPointerOut={
              !interactive
                ? undefined
                : () => {
                    if (!isDisplayed()) return;
                    // Guard against decrementing if already reset (e.g., by objNode change).
                    if (!hoverState.isHovered) return;

                    // Update hover state.
                    hoverState.set(false, null);
                    interaction.hover.setHovered(props.name, false);
                  }
            }
          >
            <HoverableContext.Provider value={hoverContextValue}>
              {objNode}
            </HoverableContext.Provider>
          </sceneNodeGroup>
        </>
      );
    }
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

function SceneNodeChildren(props: { name: string }) {
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
}
