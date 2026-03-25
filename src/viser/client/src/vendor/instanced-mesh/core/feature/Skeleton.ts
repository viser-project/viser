// @ts-nocheck
import { Matrix4, Skeleton } from 'three';
import { InstancedMesh2 } from '../InstancedMesh2.js';
import { SquareDataTexture } from '../utils/SquareDataTexture.js';

declare module '../InstancedMesh2.js' {
  interface InstancedMesh2 {
    /**
     * Initialize the skeleton of the instances.
     * @param skeleton The skeleton to initialize.
     * @param disableMatrixAutoUpdate Whether to disable the matrix auto update of the bones. Default is `true`.
     */
    initSkeleton(skeleton: Skeleton, disableMatrixAutoUpdate?: boolean): void;
    /**
     * Set the bones of the skeleton to the instance at the specified index.
     * @param id The index of the instance.
     * @param updateBonesMatrices Whether to update the matrices of the bones. Default is `true`.
     * @param excludeBonesSet An optional set of bone names to exclude from updates, skipping their local matrix updates.
    */
    setBonesAt(id: number, updateBonesMatrices?: boolean, excludeBonesSet?: Set<string>): void;
    /** internal */ multiplyBoneMatricesAt(instanceIndex: number, boneIndex: number, m1: Matrix4, m2: Matrix4): void;
  }
}

InstancedMesh2.prototype.initSkeleton = function (skeleton: Skeleton, disableMatrixAutoUpdate = true) {
  if (skeleton && this.skeleton !== skeleton && !this._parentLOD) { // TODO remove !this._parentLOD
    const bones = skeleton.bones;
    this.skeleton = skeleton;
    this.bindMatrix = new Matrix4();
    this.bindMatrixInverse = new Matrix4();
    this.boneTexture = new SquareDataTexture(Float32Array, 4, 4 * bones.length, this._capacity);

    if (disableMatrixAutoUpdate) {
      for (const bone of bones) {
        bone.matrixAutoUpdate = false;
        bone.matrixWorldAutoUpdate = false;
      }
    }

    this.materialsNeedsUpdate(); // TODO this may not work if change already present skeleton
  }
};

InstancedMesh2.prototype.setBonesAt = function (id: number, updateBonesMatrices = true, excludeBonesSet?: Set<string>) {
  const skeleton = this.skeleton;
  if (!skeleton) {
    throw new Error('"setBonesAt" cannot be called before "initSkeleton"');
  }

  const bones = skeleton.bones;
  const boneInverses = skeleton.boneInverses;

  for (let i = 0, l = bones.length; i < l; i++) {
    const bone = bones[i];

    if (updateBonesMatrices) {
      if (!excludeBonesSet?.has(bone.name)) {
        bone.updateMatrix();
      }
      bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
    }

    this.multiplyBoneMatricesAt(id, i, bone.matrixWorld, boneInverses[i]);
  }

  this.boneTexture.enqueueUpdate(id);
};

InstancedMesh2.prototype.multiplyBoneMatricesAt = function (instanceIndex: number, boneIndex: number, m1: Matrix4, m2: Matrix4) {
  const offset = (instanceIndex * this.skeleton.bones.length + boneIndex) * 16;
  const ae = m1.elements;
  const be = m2.elements;
  const te = this.boneTexture._data;

  const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
  const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
  const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
  const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];

  const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
  const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
  const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
  const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];

  te[offset + 0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  te[offset + 4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  te[offset + 8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  te[offset + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

  te[offset + 1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  te[offset + 5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  te[offset + 9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  te[offset + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

  te[offset + 2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  te[offset + 6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  te[offset + 10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  te[offset + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

  te[offset + 3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  te[offset + 7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  te[offset + 11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  te[offset + 15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
};
