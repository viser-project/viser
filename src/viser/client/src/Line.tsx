/** Adapted from: https://github.com/pmndrs/drei/blob/d5ee73265a49d59ab87aab0fad89e997e5495daa/src/core/Line.tsx
 *
 * But takes typed arrays as input instead of vanilla arrays.
 */

import "./r3f-extend";
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
        ...rest
      },
      ref,
    ) {
      const size = useThree((state) => state.size);
      const lineRef = React.useRef<Line2 | LineSegments2>(null);
      const geomRef = React.useRef<LineGeometry | LineSegmentsGeometry>(null);
      const matRef = React.useRef<LineMaterial>(null);

      // Populate geometry data via ref.
      React.useLayoutEffect(() => {
        const geom = geomRef.current;
        if (!geom) return;
        geom.setPositions(points);
        if (vertexColors) {
          const normalizedColors = new Float32Array(vertexColors).map(
            (c) => c / 255,
          );
          geom.setColors(normalizedColors, 3);
        }
      }, [points, vertexColors]);

      React.useLayoutEffect(() => {
        lineRef.current?.computeLineDistances();
      }, [points]);

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

      // R3F manages lifecycle for all declarative children — no manual disposal.
      const materialJsx = (
        <lineMaterial
          ref={matRef}
          color={effectiveColor}
          vertexColors={Boolean(vertexColors)}
          resolution={[size.width, size.height]}
          linewidth={linewidth ?? lineWidth ?? 1}
          dashed={dashed ?? false}
          transparent={false}
          fog={true}
        />
      );

      if (segments) {
        return (
          <lineSegments2 ref={setLineRef} {...rest}>
            <lineSegmentsGeometry ref={geomRef} />
            {materialJsx}
          </lineSegments2>
        );
      } else {
        return (
          <line2 ref={setLineRef} {...rest}>
            <lineGeometry ref={geomRef} />
            {materialJsx}
          </line2>
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
          lineWidth={props.line_width}
          color={color}
          vertexColors={vertexColors}
          segments={true}
        />
      </group>
      {children}
    </group>
  );
});
