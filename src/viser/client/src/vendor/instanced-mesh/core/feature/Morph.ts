// @ts-nocheck
import { DataTexture, FloatType, Mesh, RedFormat } from 'three';
import { InstancedMesh2 } from '../InstancedMesh2.js';

declare module '../InstancedMesh2.js' {
  interface InstancedMesh2 {
    /**
     * Gets the morph target data for a specific instance.
     * @param id The index of the instance.
     * @param object Optional `Mesh` to store the morph target data.
     * @returns The mesh object with updated morph target influences.
     */
    getMorphAt(id: number, object?: Mesh): Mesh;
    /**
     * Sets the morph target influences for a specific instance.
     * @param id The index of the instance.
     * @param object The `Mesh` containing the morph target influences to apply.
     */
    setMorphAt(id: number, object: Mesh): void;
  }
}

const _tempMesh = new Mesh();

InstancedMesh2.prototype.getMorphAt = function (id: number, object = _tempMesh): Mesh {
  const objectInfluences = object.morphTargetInfluences;
  const array = this.morphTexture.source.data.data;
  const len = objectInfluences.length + 1; // All influences + the baseInfluenceSum
  const dataIndex = id * len + 1; // Skip the baseInfluenceSum at the beginning

  for (let i = 0; i < objectInfluences.length; i++) {
    objectInfluences[i] = array[dataIndex + i];
  }

  return object;
};

InstancedMesh2.prototype.setMorphAt = function (id: number, object: Mesh): void {
  const objectInfluences = object.morphTargetInfluences;
  const len = objectInfluences.length + 1;

  if (this.morphTexture === null && !this._parentLOD) {
    this.morphTexture = new DataTexture(new Float32Array(len * this._capacity), len, this._capacity, RedFormat, FloatType);
  }

  const array = this.morphTexture.source.data.data;
  let morphInfluencesSum = 0;

  for (const objectInfluence of objectInfluences) {
    morphInfluencesSum += objectInfluence;
  }

  const morphBaseInfluence = this._geometry.morphTargetsRelative ? 1 : 1 - morphInfluencesSum;
  const dataIndex = len * id;
  array[dataIndex] = morphBaseInfluence;
  array.set(objectInfluences, dataIndex + 1);
  this.morphTexture.needsUpdate = true;
};
