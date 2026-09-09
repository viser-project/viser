import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  applyReversedDepthCameraPriming,
  primeCamera,
} from "./ReversedDepthSort";

describe("reversed-depth camera priming", () => {
  it("primes a camera's reversedDepth flag before three would", () => {
    // three only sets this lazily in setProgram(), which runs after sort().
    // get_render builds a fresh camera per request, so without priming every
    // capture sorts with the flag still false and the projected z un-negated.
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    expect(camera.reversedDepth).toBe(false);
    const before = camera.projectionMatrix.elements.slice();

    primeCamera(camera);

    expect(camera.reversedDepth).toBe(true);
    // The projection matrix has to be rebuilt for the flag to mean anything.
    expect(Array.from(camera.projectionMatrix.elements)).not.toEqual(
      Array.from(before),
    );

    // Idempotent: priming an already-primed camera is a no-op.
    const after = camera.projectionMatrix.elements.slice();
    primeCamera(camera);
    expect(Array.from(camera.projectionMatrix.elements)).toEqual(
      Array.from(after),
    );
  });

  /** A stand-in for the two renderer members the priming touches. */
  function fakeRenderer(reversedDepthBuffer: boolean) {
    const render = vi.fn();
    const gl = {
      capabilities: { reversedDepthBuffer },
      render,
    } as unknown as THREE.WebGLRenderer;
    return { gl, render };
  }

  it("primes every camera passed to render() on a reversed-depth renderer", () => {
    const { gl, render } = fakeRenderer(true);
    applyReversedDepthCameraPriming(gl);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    gl.render(scene, camera);

    expect(camera.reversedDepth).toBe(true);
    expect(render).toHaveBeenCalledWith(scene, camera);
  });

  it("leaves the renderer alone without a reversed depth buffer", () => {
    // Without EXT_clip_control three never negates z, and a reversed
    // projection matrix on a conventional depth buffer would be wrong.
    const { gl, render } = fakeRenderer(false);
    applyReversedDepthCameraPriming(gl);
    expect(gl.render).toBe(render);

    const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    gl.render(new THREE.Scene(), camera);
    expect(camera.reversedDepth).toBe(false);
  });
});
