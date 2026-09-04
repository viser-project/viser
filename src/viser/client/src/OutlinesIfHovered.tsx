import React from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { HoverableContext } from "./HoverContext";
import { Outlines } from "./Outlines";
import * as THREE from "three";

/** Outlines object, which should be placed as a child of all meshes that might
 * be clickable. */
export function OutlinesIfHovered(
  props: {
    unmountOnHide?: boolean;
    enableCreaseAngle?: boolean;
  } = {
    unmountOnHide: false, // Useful when outlines are combined with <Instances />.
    enableCreaseAngle: false,
  },
) {
  const hoverContext = React.useContext(HoverableContext);
  if (hoverContext === null || !hoverContext.clickable) return null;
  return <OutlinesIfHoveredInner {...props} />;
}

function OutlinesIfHoveredInner(props: {
  unmountOnHide?: boolean;
  enableCreaseAngle?: boolean;
}) {
  const groupRef = React.useRef<THREE.Group>(null);
  const hoverContext = React.useContext(HoverableContext);
  const [mounted, setMounted] = React.useState(true);

  const creaseAngle = props.enableCreaseAngle ? Math.PI : 0.0;

  // Pre-compile the outline shader while the outline is still hidden. The
  // canvas renders on demand, so nothing warms this program before the first
  // hover frame; compiling it there stalls that frame for the whole
  // compile+link (tens of ms on a GPU, seconds on software GL). three's
  // compile() only sets the program up -- with parallel shader compilation
  // the link happens off the main thread and the readiness poll below is
  // what waits for it -- so this costs the main thread almost nothing.
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  React.useEffect(() => {
    const group = groupRef.current;
    if (group === null) return;
    gl.compileAsync(group, camera, scene).catch(() => {
      /* Best-effort warm-up; the first hover frame compiles if this fails. */
    });
  }, [gl, scene, camera, mounted]);

  useFrame(() => {
    if (hoverContext === null || !hoverContext.clickable) return;
    if (props.unmountOnHide) {
      if (mounted !== hoverContext.state.current.isHovered)
        setMounted(hoverContext.state.current.isHovered);
      return;
    }
    if (groupRef.current !== null)
      groupRef.current.visible = hoverContext.state.current.isHovered;
  });

  return !mounted ? null : (
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
