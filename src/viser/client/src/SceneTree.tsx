import {
  CatmullRomLine,
  CubicBezierLine,
  PivotControls,
} from "@react-three/drei";
import { Grid } from "./Grid";
import { ContextBridge, useContextBridge } from "its-fine";
import { useFrame, useThree } from "@react-three/fiber";
import React, { useEffect } from "react";
import * as THREE from "three";

import { ViewerContext, ViewerContextContents } from "./ViewerContext";
import {
  makeThrottledMessageSender,
  useThrottledMessageSender,
} from "./WebsocketUtils";
import { Html } from "@react-three/drei";
import { useSceneTreeState } from "./SceneTreeState";
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
import { SceneNodeMessage, SpotLightMessage } from "./WebsocketMessages";
import { SplatObject } from "./Splatting/GaussianSplats";
import { Paper } from "@mantine/core";
import GeneratedGuiContainer from "./ControlPanel/Generated";
import { LineSegments } from "./Line";
import { Arrows } from "./Arrows";
import { shadowArgs } from "./ShadowArgs";
import { CsmDirectionalLight } from "./CsmDirectionalLight";
import { BasicMesh } from "./mesh/BasicMesh";
import { BoxMesh } from "./mesh/BoxMesh";
import { IcosphereMesh } from "./mesh/IcosphereMesh";
import { CylinderMesh } from "./mesh/CylinderMesh";
import { SkinnedMesh } from "./mesh/SkinnedMesh";
import { BatchedMesh } from "./mesh/BatchedMesh";
import { SingleGlbAsset } from "./mesh/SingleGlbAsset";
import { BatchedGlbAsset } from "./mesh/BatchedGlbAsset";
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

/** Component for updating attributes of a scene node. */
function SceneNodeLabel(props: { name: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const labelVisible = viewer.useSceneTree(
    props.name,
    (node) => node?.labelVisible,
  );
  return labelVisible ? (
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
  ) : null;
}

function tripletListFromFloat32Array(data: Float32Array) {
  const triplets: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 3) {
    triplets.push([data[i], data[i + 1], data[i + 2]]);
  }
  return triplets;
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

function createObjectFactory(
  message: SceneNodeMessage | undefined,
  viewer: ViewerContextContents,
  ContextBridge: ContextBridge,
): {
  makeObject: MakeObject;
  unmountWhenInvisible?: boolean;
  computeClickInstanceIndexFromInstanceId?: (
    instanceId: number | undefined,
  ) => number | null;
} {
  if (message === undefined) return { makeObject: () => null };

  switch (message.type) {
    // Add a coordinate frame.
    case "FrameMessage": {
      return {
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
        makeObject: (ref, children) => (
          <BasicMesh ref={ref} {...message}>
            {children}
          </BasicMesh>
        ),
      };
    }
    case "BoxMessage": {
      return {
        makeObject: (ref, children) => (
          <BoxMesh ref={ref} {...message}>
            {children}
          </BoxMesh>
        ),
      };
    }
    case "IcosphereMessage": {
      return {
        makeObject: (ref, children) => (
          <IcosphereMesh ref={ref} {...message}>
            {children}
          </IcosphereMesh>
        ),
      };
    }
    case "CylinderMessage": {
      return {
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
                sendDragMessage({
                  type: "TransformControlsUpdateMessage",
                  name: message.name,
                  wxyz: wxyzArray,
                  position: positionArray,
                });
              }}
              onDragEnd={() => {
                if (isDragging) {
                  isDragging = false;
                  flushDragMessage();
                  viewer.mutable.current.sendMessage({
                    type: "TransformControlsDragEndMessage",
                    name: message.name,
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
                    <GeneratedGuiContainer
                      containerUuid={message.props.container_uuid}
                    />
                  </Paper>
                </ContextBridge>
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
        makeObject: (ref, children) => {
          return (
            <group ref={ref}>
              <group scale={normalizeScale(message.props.scale)}>
                <CatmullRomLine
                  points={tripletListFromFloat32Array(message.props.points)}
                  closed={message.props.closed}
                  curveType={message.props.curve_type}
                  tension={message.props.tension}
                  lineWidth={message.props.line_width}
                  color={rgbToInt(message.props.color)}
                  // Sketchy cast needed due to https://github.com/pmndrs/drei/issues/1476.
                  segments={(message.props.segments ?? undefined) as undefined}
                />
              </group>
              {children}
            </group>
          );
        },
      };
    }
    case "CubicBezierSplineMessage": {
      return {
        makeObject: (ref, children) => {
          const points = tripletListFromFloat32Array(message.props.points);
          const controlPoints = tripletListFromFloat32Array(
            message.props.control_points,
          );
          return (
            <group ref={ref}>
              <group scale={normalizeScale(message.props.scale)}>
                {[...Array(points.length - 1).keys()].map((i) => (
                  <CubicBezierLine
                    key={i}
                    start={points[i]}
                    end={points[i + 1]}
                    midA={controlPoints[2 * i]}
                    midB={controlPoints[2 * i + 1]}
                    lineWidth={message.props.line_width}
                    color={rgbToInt(message.props.color)}
                    // Sketchy cast needed due to https://github.com/pmndrs/drei/issues/1476.
                    segments={
                      (message.props.segments ?? undefined) as undefined
                    }
                  ></CubicBezierLine>
                ))}
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
            <CsmDirectionalLight
              lightIntensity={message.props.intensity}
              color={rgbToInt(message.props.color)}
              castShadow={message.props.cast_shadow}
            />
            {children}
          </group>
        ),
        // CsmDirectionalLight is not influenced by visibility, since the
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

export function SceneNodeThreeObject(props: { name: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const message = viewer.useSceneTree(props.name, (node) => node?.message);
  const ContextBridge = useContextBridge();

  const {
    makeObject,
    unmountWhenInvisible,
    computeClickInstanceIndexFromInstanceId,
  } = React.useMemo(
    () => createObjectFactory(message, viewer, ContextBridge),
    [message, viewer, ContextBridge],
  );

  const [unmount, setUnmount] = React.useState(false);
  // shallowArrayEqual: the server echoes a fresh `bindings` array on
  // every binding update even if the content is unchanged; this
  // prevents spurious re-renders when the binding set is identical.
  const clickBindings =
    viewer.useSceneTree(
      props.name,
      (node) => node?.clickBindings,
      shallowArrayEqual,
    ) ?? EMPTY_DRAG_BINDINGS;
  const dragBindings =
    viewer.useSceneTree(
      props.name,
      (node) => node?.dragBindings,
      shallowArrayEqual,
    ) ?? EMPTY_DRAG_BINDINGS;
  const clickable = clickBindings.length > 0;
  const draggable = dragBindings.length > 0;
  const interactive = clickable || draggable;
  const objRef = React.useRef<THREE.Object3D | null>(null);
  const groupRef = React.useRef<THREE.Group | null>(null);

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
    return makeObject((ref: THREE.Object3D) => {
      objRef.current = ref;
      viewerMutable.nodeRefFromName[props.name] = objRef.current;
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

  // Pose needs to be updated whenever component is remounted / object is re-created.
  React.useEffect(() => {
    const pose = viewerMutable.nodePoseData[props.name];
    if (pose) {
      pose.poseUpdateState = "needsUpdate";
    }
  }, [objNode]);

  // Track hover state.
  const hoveredRef = React.useRef<HoverState>({
    isHovered: false,
    instanceId: null,
  });

  // Track last pointer position for re-raycasting when mesh changes.
  const lastPointerPos = React.useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);

  // Frame counter for delayed hover recheck after objNode changes.
  // We wait a few frames to ensure the new mesh geometry is fully rendered.
  const hoverRecheckCountdown = React.useRef(0);
  const isFirstObjNode = React.useRef(true);
  React.useEffect(() => {
    if (isFirstObjNode.current) {
      isFirstObjNode.current = false;
      return;
    }
    if (hoveredRef.current.isHovered) {
      // Wait 2 frames for the new mesh to be fully rendered.
      hoverRecheckCountdown.current = 2;
    }
  }, [objNode]);

  // Get R3F state for raycasting.
  const { raycaster, camera } = useThree();

  // Reusable Vector2 for hover recheck raycasting.
  const pointerNDC = React.useMemo(() => new THREE.Vector2(), []);

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

  // Update attributes on a per-frame basis. Currently does redundant work,
  // although this shouldn't be a bottleneck.
  useFrame(
    () => {
      // Re-check hover state after objNode changes (mesh geometry update).
      if (hoverRecheckCountdown.current > 0) {
        hoverRecheckCountdown.current--;
        if (
          hoverRecheckCountdown.current === 0 &&
          hoveredRef.current.isHovered &&
          groupRef.current &&
          lastPointerPos.current
        ) {
          // Compute NDC from stored pointer position.
          const canvas = viewerMutable.canvas;
          if (canvas) {
            const rect = canvas.getBoundingClientRect();
            pointerNDC.set(
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
              hoveredRef.current.isHovered = false;
              hoveredRef.current.instanceId = null;
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

      // If an interactive node becomes invisible while hovered, clean up hover
      // state so the cursor doesn't stay stuck as "pointer".
      if (
        !node.effectiveVisibility &&
        hoveredRef.current.isHovered &&
        interactive
      ) {
        hoveredRef.current.isHovered = false;
        hoveredRef.current.instanceId = null;
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
      }
    },
    // Other useFrame hooks may depend on transforms + visibility. So it's best
    // to call this hook early.
    //
    // However, it's also important that this is *higher* than the priority for
    // the MessageHandler's useFrame. This is to make sure that transforms are
    // updated in the same frame that they are set.
    -1000,
  );

  // Clicking logic.
  const sendClicksThrottled = useThrottledMessageSender(50).send;

  // Handle case where interactivity is toggled off while still hovered.
  if (!interactive && hoveredRef.current.isHovered) {
    hoveredRef.current.isHovered = false;
    interaction.hover.setHovered(props.name, false);
    interaction.nodeGestures.cancelNode(props.name);
  }

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
      if (hoveredRef.current.isHovered) {
        hoveredRef.current.isHovered = false;
        interaction.hover.setHovered(props.name, false);
      }
      dragLayerRef.current?.stopIfNodeIs(props.name);
      interaction.nodeGestures.cancelNode(props.name);
    };
  }, [interaction, props.name]);

  if (objNode === undefined || unmount) {
    return null;
  } else {
    return (
      <>
        <group
          ref={groupRef}
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
                  const clickMatches = anyBindingMatches(clickBindings, input);
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

                  sendClicksThrottled({
                    type: "SceneNodeClickMessage",
                    name: props.name,
                    instance_index:
                      computeClickInstanceIndexFromInstanceId === undefined
                        ? null
                        : computeClickInstanceIndexFromInstanceId(e.instanceId),
                    // Note that the threejs up is +Y, but we expose a +Z up.
                    ray_origin: [ray.origin.x, ray.origin.y, ray.origin.z],
                    ray_direction: [
                      ray.direction.x,
                      ray.direction.y,
                      ray.direction.z,
                    ],
                    screen_pos: [mouseVectorOpenCV.x, mouseVectorOpenCV.y],
                    modifier: keyModifierFromEvent(e),
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
                  if (hoveredRef.current.isHovered) return;

                  // Update hover state.
                  hoveredRef.current.isHovered = true;
                  // Store the instanceId in the hover ref.
                  hoveredRef.current.instanceId = e.instanceId ?? null;
                  interaction.hover.setHovered(props.name, true);
                }
          }
          onPointerOut={
            !interactive
              ? undefined
              : () => {
                  if (!isDisplayed()) return;
                  // Guard against decrementing if already reset (e.g., by objNode change).
                  if (!hoveredRef.current.isHovered) return;

                  // Update hover state.
                  hoveredRef.current.isHovered = false;
                  // Clear the instanceId when no longer hovering.
                  hoveredRef.current.instanceId = null;
                  interaction.hover.setHovered(props.name, false);
                }
          }
        >
          <HoverableContext.Provider value={{ state: hoveredRef, clickable }}>
            {objNode}
          </HoverableContext.Provider>
        </group>
      </>
    );
  }
}

function SceneNodeChildren(props: { name: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const childrenNames = viewer.useSceneTree(
    props.name,
    (node) => node?.children,
    shallowArrayEqual,
  );
  return (
    <>
      {childrenNames &&
        childrenNames.map((child_id) => (
          <SceneNodeThreeObject key={child_id} name={child_id} />
        ))}
      <SceneNodeLabel name={props.name} />
    </>
  );
}
