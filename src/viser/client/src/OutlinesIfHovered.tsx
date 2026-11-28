import React from "react";
import { useThree } from "@react-three/fiber";
import { HoverableContext, useIsHovered } from "./HoverContext";
import { Outlines } from "./Outlines";
import { OutlinesMaterial } from "./OutlinesMaterial";
import { useDrawable, useMarkTransformsDirty } from "./scene/sceneNodeHooks";
import * as THREE from "three";

/** Outlines object, which should be placed as a child of all meshes that might
 * be clickable. */
export function OutlinesIfHovered(props: { enableCreaseAngle?: boolean } = {}) {
  const hoverContext = React.useContext(HoverableContext);
  if (hoverContext === null || !hoverContext.clickable) return null;
  return <OutlinesIfHoveredInner {...props} />;
}

/** Renderers whose outline program has already been warmed up. The warm-up
 * materials are intentionally never disposed: three.js frees programs along
 * with the last material that uses them. */
const warmedRenderers = new WeakMap<THREE.WebGLRenderer, THREE.Material>();

function OutlinesIfHoveredInner(props: { enableCreaseAngle?: boolean }) {
  const isHovered = useIsHovered();
  const creaseAngle = props.enableCreaseAngle ? Math.PI : 0.0;

  // Outlines are only created once they're needed. Each one has its own
  // material, and often its own copy of the geometry; that adds up when there
  // are thousands of clickable nodes that'll never be hovered.
  const [everHovered, setEverHovered] = React.useState(false);
  if (isHovered && !everHovered) setEverHovered(true);

  // Pre-compile the outline shader before anything is hovered. The canvas
  // renders on demand, so nothing warms this program before the first hover
  // frame; compiling it there stalls that frame for the whole compile+link
  // (tens of ms on a GPU, seconds on software GL). Every OutlinesMaterial
  // shares one program, and three's compile() walks the whole scene for lights,
  // so the first mounted outline warms it for all.
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  React.useEffect(() => {
    if (warmedRenderers.has(gl)) return;
    // Parameters that affect the program should match the ones below.
    const material = new OutlinesMaterial({
      side: THREE.BackSide,
      fog: true,
      transparent: true,
    });
    warmedRenderers.set(gl, material);
    gl.compileAsync(
      new THREE.Mesh(new THREE.BoxGeometry(), material),
      camera,
      scene,
    ).catch(() => {
      /* Best-effort warm-up; the first hover frame compiles if this fails. */
    });
  }, [gl, scene, camera]);

  useDrawable(everHovered);
  useMarkTransformsDirty([everHovered]);

  if (!everHovered) return null;
  return (
    <Outlines
      visible={isHovered}
      thickness={10}
      screenspace={true}
      color={0xfbff00}
      opacity={0.8}
      transparent={true}
      angle={creaseAngle}
    />
  );
}
