import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { HoverableContext } from "./HoverContext";
import { Outlines } from "./Outlines";
import * as THREE from "three";

/** Outlines object, which should be placed as a child of all meshes that might
 * be clickable. */
export function OutlinesIfHovered(props: { enableCreaseAngle?: boolean } = {}) {
  const hoverContext = React.useContext(HoverableContext);
  if (hoverContext === null || !hoverContext.clickable) return null;
  return <OutlinesIfHoveredInner {...props} />;
}

/** Renderers whose outline program has already been warmed up. */
const warmedRenderers = new WeakSet<THREE.WebGLRenderer>();

function OutlinesIfHoveredInner(props: { enableCreaseAngle?: boolean }) {
  const groupRef = React.useRef<THREE.Group>(null);
  const hoverContext = React.useContext(HoverableContext)!;
  const creaseAngle = props.enableCreaseAngle ? Math.PI : 0.0;

  // Pre-compile the outline shader while the outline is still hidden. The
  // canvas renders on demand, so nothing warms this program before the first
  // hover frame; compiling it there stalls that frame for the whole
  // compile+link (tens of ms on a GPU, seconds on software GL). Every
  // OutlinesMaterial shares one program, and three's compile() walks the
  // whole scene for lights, so the first mounted outline warms it for all.
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  React.useEffect(() => {
    const group = groupRef.current;
    if (group === null || warmedRenderers.has(gl)) return;
    warmedRenderers.add(gl);
    gl.compileAsync(group, camera, scene).catch(() => {
      /* Best-effort warm-up; the first hover frame compiles if this fails. */
    });
  }, [gl, scene, camera]);

  useFrame(() => {
    if (groupRef.current !== null)
      groupRef.current.visible = hoverContext.state.current.isHovered;
  });

  return (
    <Outlines
      ref={groupRef}
      thickness={10}
      screenspace={true}
      color={0xfbff00}
      opacity={0.8}
      transparent={true}
      angle={creaseAngle}
    />
  );
}
