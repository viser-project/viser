// @ts-nocheck
import { InstancedBufferAttribute, InstancedMesh, Mesh, SkinnedMesh } from 'three';
import { InstancedMesh2, InstancedMesh2Params } from '../core/InstancedMesh2.js';

/**
 * Create an `InstancedMesh2` instance from an existing `Mesh` or `InstancedMesh`.
 * @param mesh The `Mesh` or `InstancedMesh` to create an `InstanceMesh2` from.
 * @param params  Optional configuration parameters object. See `InstancedMesh2Params` for details.
 * @returns The created `InstancedMesh2` instance.
 */
export function createInstancedMesh2From<TData = {}>(mesh: Mesh, params: InstancedMesh2Params = {}): InstancedMesh2<TData> {
  if ((mesh as SkinnedMesh).isSkinnedMesh) return createFromSkinnedMesh(mesh as SkinnedMesh);
  if ((mesh as InstancedMesh).isInstancedMesh) return createFromInstancedMesh(mesh as InstancedMesh);
  // TODO add morph support
  return new InstancedMesh2<TData>(mesh.geometry, mesh.material, params);

  function createFromSkinnedMesh<TData = {}>(mesh: SkinnedMesh): InstancedMesh2<TData> {
    const instancedMesh = new InstancedMesh2<TData>(mesh.geometry.clone(), mesh.material, params);
    instancedMesh.initSkeleton(mesh.skeleton);
    return instancedMesh;
  }

  function createFromInstancedMesh<TData = {}>(mesh: InstancedMesh): InstancedMesh2<TData> {
    params.capacity = Math.max(mesh.count, params.capacity);

    const geometry = mesh.geometry.clone();
    geometry.deleteAttribute('instanceIndex');
    warnIfInstancedAttribute();

    const instancedMesh = new InstancedMesh2<TData>(geometry, mesh.material, params);

    instancedMesh.position.copy(mesh.position);
    instancedMesh.quaternion.copy(mesh.quaternion);
    instancedMesh.scale.copy(mesh.scale);

    copyInstances();
    copyMatrices();
    copyColors();
    // TODO copy morph target?

    return instancedMesh;

    function copyInstances(): void {
      instancedMesh.setInstancesArrayCount(mesh.count);
      instancedMesh._instancesCount = mesh.count;
      instancedMesh.availabilityArray.fill(true, 0, mesh.count * 2);
    }

    function copyMatrices(): void {
      (instancedMesh.matricesTexture.image.data as Float32Array).set(mesh.instanceMatrix.array);
    }

    function copyColors(): void {
      if (mesh.instanceColor) {
        (instancedMesh as any).initColorsTexture();

        const rgbArray = mesh.instanceColor.array;
        const rgbaArray = instancedMesh.colorsTexture.image.data as Float32Array;

        for (let i = 0, j = 0; i < rgbArray.length; i += 3, j += 4) {
          rgbaArray[j] = rgbArray[i];
          rgbaArray[j + 1] = rgbArray[i + 1];
          rgbaArray[j + 2] = rgbArray[i + 2];
          rgbaArray[j + 3] = 1;
        }
      }
    }

    function warnIfInstancedAttribute(): void {
      const attributes = geometry.attributes;
      for (const name in attributes) {
        if ((attributes[name] as InstancedBufferAttribute).isInstancedBufferAttribute) {
          console.warn(`InstancedBufferAttribute "${name}" is not supported. It will be ignored.`);
        }
      }
    }
  }
}
