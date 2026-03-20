/**
 * Central registration of custom Three.js classes for R3F's JSX renderer.
 *
 * Import this file once before any component using these elements renders.
 * R3F will then manage lifecycle (creation + disposal) for these classes
 * automatically when used as JSX elements.
 */
import { extend } from "@react-three/fiber";
import type { ThreeElement } from "@react-three/fiber";
import {
  LineMaterial,
  Line2,
  LineSegments2,
  LineGeometry,
  LineSegmentsGeometry,
} from "three-stdlib";

extend({
  LineMaterial,
  Line2,
  LineSegments2,
  LineGeometry,
  LineSegmentsGeometry,
});

// TypeScript type augmentation so these elements are recognized in JSX.
declare module "@react-three/fiber" {
  interface ThreeElements {
    lineMaterial: ThreeElement<typeof LineMaterial>;
    line2: ThreeElement<typeof Line2>;
    lineSegments2: ThreeElement<typeof LineSegments2>;
    lineGeometry: ThreeElement<typeof LineGeometry>;
    lineSegmentsGeometry: ThreeElement<typeof LineSegmentsGeometry>;
  }
}
