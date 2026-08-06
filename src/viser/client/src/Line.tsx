/** Adapted from: https://github.com/pmndrs/drei/blob/d5ee73265a49d59ab87aab0fad89e997e5495daa/src/core/Line.tsx
 *
 * But takes typed arrays as input instead of vanilla arrays.
 */

import "./r3f-extend";
import "./patchLineMaterial";
import * as React from "react";
import * as THREE from "three";
import { ColorRepresentation } from "three";
import { ThreeElement, useThree } from "@react-three/fiber";
import {
  LineGeometry,
  LineSegmentsGeometry,
  LineMaterial,
  LineMaterialParameters,
  Line2,
  LineSegments2,
} from "three-stdlib";
import { ForwardRefComponent } from "@react-three/drei/helpers/ts-utils";
import type { LineSegmentsMessage } from "./WebsocketMessages";
import { normalizeScale } from "./utils/normalizeScale";

export type LineProps = {
  points: Float32Array; // length must be n * 3
  vertexColors?: Uint8Array; // length must be n * 3, values 0-255 for RGB
  lineWidth?: number;
  segments?: boolean;
} & Omit<LineMaterialParameters, "vertexColors" | "color"> &
  Omit<ThreeElement<typeof Line2>, "args"> &
  Omit<ThreeElement<typeof LineMaterial>, "color" | "vertexColors" | "args"> & {
    color?: ColorRepresentation;
  };

// Fringe pass objects are visual-only; the core object handles picking.
const noopRaycast = () => undefined;

export const Line: ForwardRefComponent<LineProps, Line2 | LineSegments2> =
  /* @__PURE__ */ React.forwardRef<Line2 | LineSegments2, LineProps>(
    function Line(
      {
        points,
        color = 0xffffff,
        vertexColors,
        linewidth,
        lineWidth,
        segments,
        dashed,
        worldUnits,
        ...rest
      },
      ref,
    ) {
      const size = useThree((state) => state.size);
      const lineRef = React.useRef<Line2 | LineSegments2>(null);
      const matRef = React.useRef<LineMaterial>(null);

      // Build a fresh geometry per change: reusing one instance and calling
      // setPositions() in a layout effect intermittently truncates the draw
      // on LineSegments2. See:
      //   https://github.com/nerfstudio-project/viser/issues/719
      const lineGeom = React.useMemo(() => {
        const geom = segments ? new LineSegmentsGeometry() : new LineGeometry();
        geom.setPositions(points);
        if (vertexColors) {
          const normalizedColors = new Float32Array(vertexColors.length);
          for (let i = 0; i < vertexColors.length; i++) {
            normalizedColors[i] = vertexColors[i] / 255;
          }
          geom.setColors(normalizedColors, 3);
        }
        return geom;
      }, [points, vertexColors, segments]);

      React.useEffect(() => {
        return () => {
          lineGeom.dispose();
        };
      }, [lineGeom]);

      React.useLayoutEffect(() => {
        lineRef.current?.computeLineDistances();
      }, [lineGeom]);

      // Handle dashed defines via ref (can't be expressed as a prop).
      React.useLayoutEffect(() => {
        const mat = matRef.current;
        if (!mat) return;
        if (dashed) {
          mat.defines.USE_DASH = "";
        } else {
          // Setting lineMaterial.defines.USE_DASH to undefined is apparently not sufficient.
          delete mat.defines.USE_DASH;
        }
        mat.needsUpdate = true;
      }, [dashed]);

      // worldUnits toggles a shader define (WORLD_UNITS); the three-stdlib
      // setter doesn't bump the material version, so recompile explicitly.
      React.useLayoutEffect(() => {
        const mat = matRef.current;
        if (!mat) return;
        mat.worldUnits = worldUnits ?? false;
        mat.needsUpdate = true;
      }, [worldUnits]);

      // World-unit lines get a second, alpha-blended antialiasing pass (see
      // patchLineMaterial): the fringe material re-draws the line with a
      // smooth edge falloff, depth-tested but not depth-written, on top of
      // the opaque depth-anchoring core.
      const showFringe = (worldUnits ?? false) && !(dashed ?? false);
      const fringeMatRef = React.useRef<LineMaterial>(null);
      React.useLayoutEffect(() => {
        const mat = fringeMatRef.current;
        if (!mat) return;
        mat.defines.VISER_LINE_FRINGE = "";
        mat.worldUnits = true;
        mat.needsUpdate = true;
      }, [showFringe]);

      const effectiveColor = vertexColors ? 0xffffff : color;

      // Merge forwarded ref with internal ref.
      const setLineRef = React.useCallback(
        (instance: Line2 | LineSegments2 | null) => {
          (
            lineRef as React.MutableRefObject<Line2 | LineSegments2 | null>
          ).current = instance;
          if (typeof ref === "function") ref(instance);
          else if (ref)
            (ref as { current: Line2 | LineSegments2 | null }).current =
              instance;
        },
        [ref],
      );

      // Reversed-depth and antialiasing fixes for LineMaterial are applied
      // globally (all instances, including drei's) in patchLineMaterial.

      // R3F manages lifecycle for all declarative children -- no manual disposal.
      const materialJsx = (
        <lineMaterial
          ref={matRef}
          color={effectiveColor}
          vertexColors={Boolean(vertexColors)}
          resolution={[size.width, size.height]}
          linewidth={linewidth ?? lineWidth ?? 1}
          worldUnits={worldUnits ?? false}
          dashed={dashed ?? false}
          transparent={false}
          fog={true}
        />
      );

      // The fringe object shares the core's geometry; picking goes through
      // the core only.
      const fringeMaterialJsx = (
        <lineMaterial
          ref={fringeMatRef}
          color={effectiveColor}
          vertexColors={Boolean(vertexColors)}
          resolution={[size.width, size.height]}
          linewidth={linewidth ?? lineWidth ?? 1}
          worldUnits={true}
          transparent={true}
          depthWrite={false}
          fog={true}
        />
      );

      if (segments) {
        return (
          <>
            <lineSegments2 ref={setLineRef} {...rest}>
              <primitive object={lineGeom} attach="geometry" />
              {materialJsx}
            </lineSegments2>
            {showFringe && (
              <lineSegments2 raycast={noopRaycast}>
                <primitive object={lineGeom} attach="geometry" />
                {fringeMaterialJsx}
              </lineSegments2>
            )}
          </>
        );
      } else {
        return (
          <>
            <line2 ref={setLineRef} {...rest}>
              <primitive object={lineGeom} attach="geometry" />
              {materialJsx}
            </line2>
            {showFringe && (
              <line2 raycast={noopRaycast}>
                <primitive object={lineGeom} attach="geometry" />
                {fringeMaterialJsx}
              </line2>
            )}
          </>
        );
      }
    },
  );

// Wrapper component for LineSegments that handles color broadcasting.
export const LineSegments = React.forwardRef<
  THREE.Group,
  LineSegmentsMessage & { children?: React.ReactNode }
>(function LineSegments({ props, children }, ref) {
  // Binary arrays arrive as typed views. Use directly, zero copy.
  const pointsArray = props.points;
  const colorArray = props.colors;

  // Handle uniform color vs per-vertex colors.
  const { color, vertexColors } = React.useMemo(() => {
    if (colorArray.length === 3) {
      // Uniform color: convert RGB uint8 to hex number.
      return {
        color: (colorArray[0] << 16) | (colorArray[1] << 8) | colorArray[2],
        vertexColors: undefined,
      };
    } else {
      // Per-vertex colors.
      return {
        color: undefined,
        vertexColors: colorArray,
      };
    }
  }, [colorArray]);

  return (
    <group ref={ref}>
      <group scale={normalizeScale(props.scale)}>
        <Line
          points={pointsArray}
          lineWidth={props.thickness}
          worldUnits={props.thickness_units === "world"}
          color={color}
          vertexColors={vertexColors}
          segments={true}
        />
      </group>
      {children}
    </group>
  );
});
