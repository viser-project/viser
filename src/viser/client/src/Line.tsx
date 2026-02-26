/** Adapted from: https://github.com/pmndrs/drei/blob/d5ee73265a49d59ab87aab0fad89e997e5495daa/src/core/Line.tsx
 *
 * But takes typed arrays as input instead of vanilla arrays.
 */

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
      const line2 = React.useMemo(
        () => (segments ? new LineSegments2() : new Line2()),
        [segments],
      );
      const [lineMaterial] = React.useState(() => new LineMaterial());
      const itemSize = 3; // We're now always using RGB colors (3 components)
      const lineGeom = React.useMemo(() => {
        const geom = segments ? new LineSegmentsGeometry() : new LineGeometry();

        // points is already a Float32Array of [x,y,z] values
        geom.setPositions(points);

        if (vertexColors) {
          // Convert Uint8Array (0-255) to Float32Array (0-1)
          const normalizedColors = new Float32Array(vertexColors).map(
            (c) => c / 255,
          );
          color = 0xffffff;
          geom.setColors(normalizedColors, itemSize);
        }

        return geom;
      }, [points, segments, vertexColors, itemSize]);

      React.useLayoutEffect(() => {
        line2.computeLineDistances();
      }, [points, line2]);

      React.useLayoutEffect(() => {
        if (dashed) {
          lineMaterial.defines.USE_DASH = "";
        } else {
          // Setting lineMaterial.defines.USE_DASH to undefined is apparently not sufficient.
          delete lineMaterial.defines.USE_DASH;
        }
        lineMaterial.needsUpdate = true;
      }, [dashed, lineMaterial]);

      React.useEffect(() => {
        return () => {
          lineGeom.dispose();
          lineMaterial.dispose();
        };
      }, [lineGeom]);

      return (
        <primitive object={line2} ref={ref} {...rest}>
          <primitive object={lineGeom} attach="geometry" />
          <primitive
            object={lineMaterial}
            attach="material"
            color={color}
            vertexColors={Boolean(vertexColors)}
            resolution={[size.width, size.height]}
            linewidth={linewidth ?? lineWidth ?? 1}
            dashed={dashed}
            transparent={false} /*need to set to true if itemSize === 4*/
            {...rest}
          />
        </primitive>
      );
    },
  );

// Wrapper component for LineSegments that handles color broadcasting.
export const LineSegments = React.forwardRef<
  THREE.Group,
  LineSegmentsMessage & { children?: React.ReactNode }
>(function LineSegments({ props, children }, ref) {
  // Convert buffer views to typed arrays.
  const pointsArray = React.useMemo(
    () =>
      new Float32Array(
        props.points.buffer.slice(
          props.points.byteOffset,
          props.points.byteOffset + props.points.byteLength,
        ),
      ),
    [props.points],
  );

  const colorArray = React.useMemo(
    () =>
      new Uint8Array(
        props.colors.buffer.slice(
          props.colors.byteOffset,
          props.colors.byteOffset + props.colors.byteLength,
        ),
      ),
    [props.colors],
  );

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
