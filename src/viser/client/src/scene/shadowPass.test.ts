import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { collectShadowCasters, installFastShadowPass } from "./shadowPass";

describe("shadow pass", () => {
  it("collects the topmost visible casters", () => {
    const scene = new THREE.Scene();
    const hidden = new THREE.Group();
    hidden.visible = false;
    const [a, b, nested, light] = [
      new THREE.Mesh(),
      new THREE.Mesh(),
      new THREE.Mesh(),
      new THREE.DirectionalLight(),
    ];
    a.castShadow = b.castShadow = nested.castShadow = light.castShadow = true;
    a.add(nested);
    hidden.add(b);
    scene.add(a, hidden, light, new THREE.Mesh());
    const out: THREE.Object3D[] = [];
    collectShadowCasters(scene, out);
    expect(out).toEqual([a]);
  });

  it("is skipped when there's nothing to draw or clear", () => {
    const render = vi.fn();
    const shadowMap = {
      enabled: true,
      type: THREE.PCFShadowMap,
      render,
    };
    installFastShadowPass({ shadowMap } as any);
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh();
    mesh.castShadow = true;
    const lights = [{ shadow: { map: {} } }];
    const run = () => {
      render.mockClear();
      (shadowMap.render as any)(lights, scene, new THREE.Camera());
      return render.mock.calls.length;
    };
    expect(run()).toBe(1); // Clears.
    expect(run()).toBe(0);
    scene.add(mesh);
    expect(run()).toBe(1);
    expect(run()).toBe(1);
    scene.remove(mesh);
    expect(run()).toBe(1); // Clears.
    expect(run()).toBe(0);
    lights.push({ shadow: { map: {} } });
    expect(run()).toBe(1);
    expect(run()).toBe(0);
    lights[0] = { shadow: { map: null as any } }; // Not allocated yet.
    expect(run()).toBe(1);
    expect(run()).toBe(1);
  });
});
