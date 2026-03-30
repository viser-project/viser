import React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Instances, Instance } from "@react-three/drei";
// @ts-ignore - troika-three-text doesn't have type definitions
import { Text as TroikaText, BatchedText } from "troika-three-text";
import { BatchedLabelManagerContext } from "./BatchedLabelManagerContext";
import { ViewerContext } from "./ViewerContext";
import {
  setupBatchedTextMaterial,
  calculateBillboardRotation,
  calculateBaseFontSize,
  calculateScreenSpaceScale,
  LABEL_BACKGROUND_COLOR,
  LABEL_BACKGROUND_OPACITY,
  LABEL_BACKGROUND_PADDING_X,
  LABEL_BACKGROUND_PADDING_Y,
} from "./LabelUtils";

/**
 * Metadata stored for each text object.
 */
interface TextInfo {
  nodeName: string;
  parentName: string;
  depthTest: boolean;
  batchedText: BatchedText;
  backgroundInstanceId: string; // ID for the background rectangle instance
  backgroundDepthTest: boolean; // Depth test setting for the background
  fontSizeMode: "screen" | "scene"; // Font sizing mode
  fontScreenScale: number; // Scale factor for screen-space mode
  fontSceneHeight: number; // Font height for scene-space mode
  baseFontSize: number; // Computed base font size used for rendering
  anchorX: "left" | "center" | "right"; // Anchor X position
  anchorY: "top" | "middle" | "bottom"; // Anchor Y position
}

/**
 * Global manager for all labels using batched rendering.
 * Labels are grouped by depth_test setting for optimal performance.
 */
export const BatchedLabelManager: React.FC<{
  children?: React.ReactNode;
}> = ({ children }) => {
  const viewer = React.useContext(ViewerContext)!;
  const [group, setGroup] = React.useState<THREE.Group | null>(null);

  // One BatchedText instance per depthTest setting (true/false).
  const batchedTextsRef = React.useRef<Map<boolean, BatchedText>>(new Map());
  const textInfoRef = React.useRef(new Map<TroikaText, TextInfo>());
  const materialPropsSetRef = React.useRef(new Set<BatchedText>());

  // Background rectangle instances for each text label.
  const [backgroundInstances, setBackgroundInstances] = React.useState<
    Set<string>
  >(new Set());
  const backgroundInstanceRefsRef = React.useRef<
    Map<string, React.RefObject<THREE.Object3D>>
  >(new Map());

  // Dirty flags for batching sync() calls - synced in useFrame.
  const dirtyBatchesRef = React.useRef(new Set<BatchedText>());

  // Counter for generating unique background instance IDs.
  const backgroundInstanceCounterRef = React.useRef(0);

  // Reuse objects to avoid allocations.
  const groupQuaternion = React.useMemo(() => new THREE.Quaternion(), []);
  const billboardQuaternion = React.useMemo(() => new THREE.Quaternion(), []);
  const frustum = React.useMemo(() => new THREE.Frustum(), []);
  const projScreenMatrix = React.useMemo(() => new THREE.Matrix4(), []);
  const localOffset = React.useMemo(() => new THREE.Vector3(), []);
  const tempWorldPos = React.useMemo(() => new THREE.Vector3(), []);
  const tempCameraSpacePos = React.useMemo(() => new THREE.Vector3(), []);

  // Create unit rectangle geometry once (scaled per-instance).
  const rectGeometry = React.useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  // Create the group once on mount.
  React.useEffect(() => {
    const newGroup = new THREE.Group();
    setGroup(newGroup);

    // Cleanup on unmount.
    return () => {
      batchedTextsRef.current.forEach((batchedText) => {
        newGroup.remove(batchedText);
        batchedText.dispose();
      });
    };
  }, []);

  // API for components to register/unregister their text objects.
  const registerText = React.useCallback(
    (
      text: TroikaText,
      nodeName: string,
      depthTest: boolean,
      fontSizeMode: "screen" | "scene",
      fontScreenScale: number,
      fontSceneHeight: number,
      anchorX: "left" | "center" | "right",
      anchorY: "top" | "middle" | "bottom",
    ) => {
      if (!group) return;

      // Get or create BatchedText for this depthTest setting.
      let targetBatch = batchedTextsRef.current.get(depthTest);
      if (!targetBatch) {
        targetBatch = new BatchedText();
        targetBatch.renderOrder = 10_000;
        batchedTextsRef.current.set(depthTest, targetBatch);
        group.add(targetBatch);
      }

      targetBatch.add(text);

      // Mark batch as needing sync - will be synced in useFrame.
      dirtyBatchesRef.current.add(targetBatch);

      // Compute parent name once and store it.
      const parentName = nodeName.split("/").slice(0, -1).join("/");

      // Create a unique ID for the background instance, encoding depthTest to avoid stale closures.
      const backgroundInstanceId = `bg-${depthTest}-${backgroundInstanceCounterRef.current++}`;

      // Create a ref for this background instance.
      backgroundInstanceRefsRef.current.set(
        backgroundInstanceId,
        React.createRef(),
      );

      // Add to background instances set (triggers re-render to create Instance component).
      setBackgroundInstances(
        (prev) => new Set([...prev, backgroundInstanceId]),
      );

      // Calculate base font size based on mode.
      const baseFontSize = calculateBaseFontSize(
        fontSizeMode,
        fontScreenScale,
        fontSceneHeight,
      );

      // Store text metadata.
      textInfoRef.current.set(text, {
        nodeName,
        parentName,
        depthTest,
        batchedText: targetBatch,
        backgroundInstanceId,
        backgroundDepthTest: depthTest,
        fontSizeMode,
        fontScreenScale,
        fontSceneHeight,
        baseFontSize,
        anchorX,
        anchorY,
      });
    },
    [group],
  );

  const unregisterText = React.useCallback((text: TroikaText) => {
    const textInfo = textInfoRef.current.get(text);
    if (textInfo) {
      textInfo.batchedText.remove(text);

      // Mark batch as needing sync - will be synced in useFrame.
      dirtyBatchesRef.current.add(textInfo.batchedText);

      // Remove background instance.
      backgroundInstanceRefsRef.current.delete(textInfo.backgroundInstanceId);
      setBackgroundInstances((prev) => {
        const next = new Set(prev);
        next.delete(textInfo.backgroundInstanceId);
        return next;
      });

      textInfoRef.current.delete(text);
    }
  }, []);

  const syncBatchedText = React.useCallback(() => {
    // Mark all batches as needing sync - will be synced in useFrame.
    batchedTextsRef.current.forEach((batch) => {
      dirtyBatchesRef.current.add(batch);
    });
  }, []);

  const syncText = React.useCallback((text: TroikaText) => {
    // Mark only the batch containing this specific text as needing sync.
    const textInfo = textInfoRef.current.get(text);
    if (textInfo) {
      dirtyBatchesRef.current.add(textInfo.batchedText);
    }
  }, []);

  const updateText = React.useCallback(
    (
      text: TroikaText,
      depthTest: boolean,
      fontSizeMode: "screen" | "scene",
      fontScreenScale: number,
      fontSceneHeight: number,
      anchorX: "left" | "center" | "right",
      anchorY: "top" | "middle" | "bottom",
    ) => {
      const textInfo = textInfoRef.current.get(text);
      if (!textInfo) return;

      // Check if depthTest changed - this requires moving to a different batch.
      if (textInfo.depthTest !== depthTest) {
        // Need to do full re-registration for batch migration.
        const nodeName = textInfo.nodeName;
        unregisterText(text);
        registerText(
          text,
          nodeName,
          depthTest,
          fontSizeMode,
          fontScreenScale,
          fontSceneHeight,
          anchorX,
          anchorY,
        );
        return;
      }

      // Update metadata in place (no batch migration needed).
      const baseFontSize = calculateBaseFontSize(
        fontSizeMode,
        fontScreenScale,
        fontSceneHeight,
      );

      textInfo.fontSizeMode = fontSizeMode;
      textInfo.fontScreenScale = fontScreenScale;
      textInfo.fontSceneHeight = fontSceneHeight;
      textInfo.baseFontSize = baseFontSize;
      textInfo.anchorX = anchorX;
      textInfo.anchorY = anchorY;

      // Update text object's anchor properties and trigger sync.
      text.anchorX = anchorX;
      text.anchorY = anchorY;
      dirtyBatchesRef.current.add(textInfo.batchedText);
    },
    [registerText, unregisterText],
  );

  const contextValue = React.useMemo(
    () => ({
      registerText,
      unregisterText,
      updateText,
      syncBatchedText,
      syncText,
    }),
    [registerText, unregisterText, updateText, syncBatchedText, syncText],
  );

  // Billboard rotation, position updates, and visibility culling in render loop.
  useFrame(({ camera, size }) => {
    if (!group) return;

    // Sync dirty batches (batches multiple add/remove/update calls).
    dirtyBatchesRef.current.forEach((batchedText) => {
      batchedText.sync();
    });
    dirtyBatchesRef.current.clear();

    // Compute frustum for culling (shared across all batches).
    projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    frustum.setFromProjectionMatrix(projScreenMatrix);

    // Calculate billboard rotation accounting for parent transform (shared).
    calculateBillboardRotation(
      group,
      camera,
      groupQuaternion,
      billboardQuaternion,
    );

    // Set material properties on BatchedText instances if not yet set.
    // BatchedText creates its material during the render loop, so we check here.
    batchedTextsRef.current.forEach((batchedText, depthTest) => {
      if (!materialPropsSetRef.current.has(batchedText)) {
        if (setupBatchedTextMaterial(batchedText, depthTest)) {
          materialPropsSetRef.current.add(batchedText);
        }
      }
    });

    // Update text positions, visibility, and apply billboard rotation.
    // Iterate over our own textInfoRef map instead of relying on private _members API.
    textInfoRef.current.forEach((textInfo, text) => {
      try {
        // Compute position from parent node + local position.
        const parentRef =
          viewer.mutable.current.nodeRefFromName[textInfo.parentName];
        const node = viewer.useSceneTree.get(textInfo.nodeName);

        if (parentRef && node) {
          // Add label's local position offset.
          const textPosition = text.position as THREE.Vector3;
          const pose = viewer.mutable.current.nodePoseData[textInfo.nodeName];
          textPosition.set(...(pose?.position ?? [0, 0, 0]));
          textPosition.applyMatrix4(parentRef.matrixWorld);

          // Use effectiveVisibility which includes parent chain.
          // Use opacity instead of visible since BatchedText ignores individual text.visible.
          const isVisible = node.effectiveVisibility ?? false;
          if (isVisible) {
            text.fillOpacity = 1.0;
          } else {
            text.fillOpacity = 0.0;
          }

          // Apply font sizing based on mode.
          let paddingX = LABEL_BACKGROUND_PADDING_X;
          let paddingY = LABEL_BACKGROUND_PADDING_Y;

          if (textInfo.fontSizeMode === "screen") {
            // Scale based on distance, FOV, and viewport size to maintain consistent pixel size.
            // Convert text position from local space to world space using group's matrix.
            tempWorldPos.copy(text.position);
            tempWorldPos.applyMatrix4(group.matrixWorld);
            const scale = calculateScreenSpaceScale(
              camera,
              tempWorldPos,
              tempCameraSpacePos,
              size.height,
            );

            // Set fontSize directly - Troika applies this as a scale, no sync needed.
            // baseFontSize already includes fontScreenScale.
            text.fontSize = textInfo.baseFontSize * scale;
            // Also scale padding to maintain constant screen-space padding.
            paddingX =
              LABEL_BACKGROUND_PADDING_X * scale * textInfo.fontScreenScale;
            paddingY =
              LABEL_BACKGROUND_PADDING_Y * scale * textInfo.fontScreenScale;
          } else {
            // Use the fixed scene-space font size - no sync needed.
            text.fontSize = textInfo.baseFontSize;
          }

          // Update background instance position and scale.
          const backgroundRef = backgroundInstanceRefsRef.current.get(
            textInfo.backgroundInstanceId,
          );
          if (backgroundRef?.current) {
            const bg = backgroundRef.current;

            // Only update position/scale if visible and we have text render info.
            if (isVisible && text.textRenderInfo) {
              // Get both bounds from textRenderInfo.
              const blockBounds = text.textRenderInfo.blockBounds;
              const visibleBounds = text.textRenderInfo.visibleBounds;

              if (blockBounds && visibleBounds) {
                // Use visibleBounds for sizing (actual glyphs without trailing whitespace).
                const [blockMinX, blockMinY, blockMaxX, blockMaxY] =
                  blockBounds;
                const [visMinX, visMinY, visMaxX, visMaxY] = visibleBounds;

                const visibleWidth = visMaxX - visMinX;
                const visibleHeight = visMaxY - visMinY;

                // Calculate rectangle dimensions (text + padding).
                const rectWidth = visibleWidth + paddingX;
                const rectHeight = visibleHeight + paddingY;

                // Calculate rectangle bounds in text-local coordinates based on visibleBounds.
                const rectMinX = visMinX - paddingX / 2;
                const rectMaxX = visMaxX + paddingX / 2;
                const rectMinY = visMinY - paddingY / 2;
                const rectMaxY = visMaxY + paddingY / 2;

                // Troika anchors based on blockBounds - calculate where the text anchor is.
                let textAnchorX = 0;
                if (textInfo.anchorX === "left") {
                  textAnchorX = blockMinX;
                } else if (textInfo.anchorX === "right") {
                  textAnchorX = blockMaxX;
                } else {
                  textAnchorX = (blockMinX + blockMaxX) / 2;
                }

                let textAnchorY = 0;
                if (textInfo.anchorY === "top") {
                  textAnchorY = blockMaxY;
                } else if (textInfo.anchorY === "bottom") {
                  textAnchorY = blockMinY;
                } else {
                  textAnchorY = (blockMinY + blockMaxY) / 2;
                }

                // Background center based on visibleBounds.
                const rectCenterX = (rectMinX + rectMaxX) / 2;
                const rectCenterY = (rectMinY + rectMaxY) / 2;

                // Offset from text anchor (blockBounds-based) to rectangle center (visibleBounds-based).
                const offsetX = rectCenterX - textAnchorX;
                const offsetY = rectCenterY - textAnchorY;

                // Position background at text position with offset.
                // The offset is in local space, so rotate by the billboard quaternion.
                localOffset.set(offsetX, offsetY, 0);
                localOffset.applyQuaternion(billboardQuaternion);

                bg.position.copy(text.position);
                bg.position.add(localOffset);

                // Scale background to rectangle size.
                bg.scale.set(rectWidth, rectHeight, 1);

                // Match text rotation.
                bg.quaternion.copy(billboardQuaternion);
              }
            } else {
              // Hide background by scaling to 0 (InstancedMesh doesn't respect visible property).
              bg.scale.set(0, 0, 0);
            }
          }
        } else {
          text.fillOpacity = 0.0;

          // Hide background when text is hidden (scale to 0 for InstancedMesh).
          const backgroundRef = backgroundInstanceRefsRef.current.get(
            textInfo.backgroundInstanceId,
          );
          if (backgroundRef?.current) {
            backgroundRef.current.scale.set(0, 0, 0);
          }
        }

        // Apply billboard rotation.
        text.quaternion.copy(billboardQuaternion);
      } catch (error) {
        console.error("[BatchedLabelManager] Error updating text:", error);
      }
    });
  });

  // Split backgrounds by depth test setting.
  // Parse depthTest from ID to avoid stale closure issues.
  const backgroundsByDepthTest = React.useMemo(() => {
    const map = new Map<boolean, string[]>();
    map.set(true, []);
    map.set(false, []);

    backgroundInstances.forEach((instanceId) => {
      // ID format: "bg-{depthTest}-{counter}"
      const depthTest = instanceId.startsWith("bg-true");
      const list = map.get(depthTest);
      if (list) {
        list.push(instanceId);
      }
    });

    return map;
  }, [backgroundInstances]);

  return (
    <BatchedLabelManagerContext.Provider value={contextValue}>
      {group && <primitive object={group} />}
      {/* Background rectangles with depth test = true */}
      <Instances frustumCulled={false}>
        <primitive object={rectGeometry} attach="geometry" />
        <meshBasicMaterial
          color={LABEL_BACKGROUND_COLOR}
          transparent={true}
          opacity={LABEL_BACKGROUND_OPACITY}
          depthTest={true}
          depthWrite={false}
          toneMapped={false}
        />
        {backgroundsByDepthTest.get(true)?.map((instanceId) => {
          const ref = backgroundInstanceRefsRef.current.get(instanceId);
          return <Instance key={instanceId} ref={ref} renderOrder={10000} />;
        })}
      </Instances>
      {/* Background rectangles with depth test = false */}
      <Instances frustumCulled={false} renderOrder={9999}>
        <primitive object={rectGeometry} attach="geometry" />
        <meshBasicMaterial
          color={LABEL_BACKGROUND_COLOR}
          transparent={true}
          opacity={LABEL_BACKGROUND_OPACITY}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
        {backgroundsByDepthTest.get(false)?.map((instanceId) => {
          const ref = backgroundInstanceRefsRef.current.get(instanceId);
          return <Instance key={instanceId} ref={ref} />;
        })}
      </Instances>
      {children}
    </BatchedLabelManagerContext.Provider>
  );
};
