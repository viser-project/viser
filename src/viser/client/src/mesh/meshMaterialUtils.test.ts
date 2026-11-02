import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { createStandardMaterial } from "./meshMaterialUtils";

describe("createStandardMaterial", () => {
  it("builds a MeshBasicMaterial that skips tone mapping for material='unlit'", () => {
    const mat = createStandardMaterial({
      material: "unlit",
      color: [255, 128, 0],
      wireframe: false,
      opacity: 0.5,
      flat_shading: false,
      side: "double",
    });
    expect(mat).toBeInstanceOf(THREE.MeshBasicMaterial);
    const basic = mat as THREE.MeshBasicMaterial;
    expect(basic.color.getHex()).toBe(0xff8000);
    expect(basic.transparent).toBe(true);
    expect(basic.opacity).toBe(0.5);
    expect(basic.side).toBe(THREE.DoubleSide);
    // Like point clouds and images, unlit colors bypass the canvas tone mapping.
    expect(basic.toneMapped).toBe(false);
  });

  it("lets wireframe=True override material='unlit', as the Python API warns", () => {
    // `_warn_wireframe_conflicts` tells users the material argument is ignored
    // for wireframes; the client must agree for every non-standard material.
    const mat = createStandardMaterial({
      material: "unlit",
      wireframe: true,
      opacity: null,
      flat_shading: false,
      side: "front",
    });
    expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((mat as THREE.MeshStandardMaterial).wireframe).toBe(true);
  });
});
