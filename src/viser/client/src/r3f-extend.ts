/**
 * Central registration of Three.js classes for R3F's JSX renderer.
 *
 * R3F's <Canvas> normally calls `extend(THREE)` with the entire three
 * namespace, which retains every three export in the bundle and defeats
 * tree-shaking (~35 KB of the compressed build). The production build
 * patches that call out (see the fiber-no-auto-extend plugin in
 * vite.config.mts), so every lowercase JSX intrinsic used by viser or its
 * dependencies must be registered here. The dev server keeps R3F's full
 * automatic catalogue, so threeCatalogue.test.ts guards the explicit list.
 *
 * Import this file once before any component using these elements renders
 * (App.tsx does, at the top of its import list).
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
import { dreiThreeCatalogue, viserThreeCatalogue } from "./threeCatalogue";

extend({
  ...viserThreeCatalogue,
  ...dreiThreeCatalogue,
  LineMaterial,
  Line2,
  LineSegments2,
  LineGeometry,
  LineSegmentsGeometry,
});

// TypeScript type augmentation so the custom elements are recognized in JSX.
declare module "@react-three/fiber" {
  interface ThreeElements {
    lineMaterial: ThreeElement<typeof LineMaterial>;
    line2: ThreeElement<typeof Line2>;
    lineSegments2: ThreeElement<typeof LineSegments2>;
    lineGeometry: ThreeElement<typeof LineGeometry>;
    lineSegmentsGeometry: ThreeElement<typeof LineSegmentsGeometry>;
  }
}
