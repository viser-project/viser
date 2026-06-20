// @ts-nocheck
import { MeshDistanceMaterial, WebGLRenderer } from 'three';
import { InstancedMesh2 } from '../InstancedMesh2.js';

// TODO: Fix if multiple renderers?

/**
 * To prevent three.js from using the same shader between InstancedMesh and InstancedMesh2 if the material is the same
 * (especially with `scene.overrideMaterial`), the `WebGLProperties` object is temporarily patched before each render of an InstancedMesh2.
 */
let propertiesGetBase: (obj: unknown) => unknown = null; // this can become const
let propertiesGet: WeakMap<any, () => unknown> = null;
const propertiesGetMap: { [x: string]: WeakMap<any, () => unknown> } = {};

function propertiesGetCallback(object: unknown): unknown {
  return propertiesGet.get(object)?.() ?? propertiesGetBase(object);
}

function addProperties(material: unknown): void {
  if (propertiesGet.has(material)) return;

  const materialProperties: { [x: string]: any } = {};

  propertiesGet.set(material, () => {
    // Fix pointLight bug. Related: https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgl/WebGLShadowMap.js#L333
    if ((material as MeshDistanceMaterial).isMeshDistanceMaterial) {
      const materialPropertiesBase = propertiesGetBase(material) as { [x: string]: any };
      materialProperties.light = materialPropertiesBase.light;
    }

    return materialProperties;
  });
}

export function patchProperties(obj: InstancedMesh2, renderer: WebGLRenderer, material: unknown): void {
  const properties = renderer.properties;
  propertiesGetBase = properties.get;

  const key = `${!!obj.colorsTexture}_${obj._useOpacity}_${!!obj.boneTexture}_${!!obj.uniformsTexture}`;
  propertiesGetMap[key] ??= new WeakMap<any, () => unknown>();
  propertiesGet = propertiesGetMap[key];

  properties.get = propertiesGetCallback;

  addProperties(material);
}

export function unpatchProperties(renderer: WebGLRenderer): void {
  renderer.properties.get = propertiesGetBase;
}
