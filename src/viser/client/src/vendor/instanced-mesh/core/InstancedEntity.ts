// @ts-nocheck
import { Color, ColorRepresentation, Euler, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { InstancedMesh2 } from './InstancedMesh2.js';
import { UniformValue, UniformValueObj } from './utils/SquareDataTexture.js';

// TODO add other object3D methods
// TODO implement parent

/**
 * Represents an instance in an `InstancedMesh2`.
 * This class stores transformation data (position, rotation, scale) and provides methods to manipulate them.
 */
export class InstancedEntity {
  /**
   * Indicates if this is an `InstancedEntity`.
   */
  public readonly isInstanceEntity = true;
  /**
   * The unique identifier for this instance (relative to the `InstancedMesh2` it references).
   */
  public readonly id: number;
  /**
   * `InstancedMesh2` to which this instance refers.
   */
  public readonly owner: InstancedMesh2;
  /**
   * The local position.
   */
  public position = new Vector3();
  /**
   * The local scale.
   */
  public scale = new Vector3(1, 1, 1);
  /**
   * The local rotation as `Quaternion`.
   */
  public quaternion = new Quaternion();
  /**
   * The local rotation as `Euler`.
   * This works only if `allowsEuler` is set to `true` in the `InstancedMesh2` constructor parameters.
   */
  public rotation: Euler;

  /**
   * The visibility state set and got from `owner.availabilityArray`.
   */
  public get visible(): boolean { return this.owner.getVisibilityAt(this.id); }
  public set visible(value: boolean) { this.owner.setVisibilityAt(this.id, value); }

  /**
   * The availability set and got from `owner.availabilityArray`.
   */
  public get active(): boolean { return this.owner.getActiveAt(this.id); }
  public set active(value: boolean) { this.owner.setActiveAt(this.id, value); }

  /**
   * Color set and got from `owner.colorsTexture`.
   */
  public get color(): Color { return this.owner.getColorAt(this.id); }
  public set color(value: ColorRepresentation) { this.owner.setColorAt(this.id, value); }

  /**
   * Opacity set and got from `owner.colorsTexture`.
   */
  public get opacity(): number { return this.owner.getOpacityAt(this.id); }
  public set opacity(value: number) { this.owner.setOpacityAt(this.id, value); }

  /**
   * Morph target influences set and got from `owner.morphTexture`.
   */
  public get morph(): Mesh { return this.owner.getMorphAt(this.id); }
  public set morph(value: Mesh) { this.owner.setMorphAt(this.id, value); }

  /**
   * The local transform matrix got from `owner.matricesTexture`.
   */
  public get matrix(): Matrix4 { return this.owner.getMatrixAt(this.id); }

  /**
   * The world transform matrix got by multiplying the matrix got from `owner.matricesTexture` and `this.owner.matrixWorld`.
   */
  public get matrixWorld(): Matrix4 { return this.matrix.premultiply(this.owner.matrixWorld); }

  /**
   * This object is instantiated automatically by setting `createEntities` to `true` in the `InstancedMesh2` constructor parameters.
   * Dont instantiate this manually.
   * @param owner The `InstancedMesh2` that owns this instance.
   * @param id The unique identifier for this instance within the `InstancedMesh2`.
   * @param useEuler Whether to use Euler rotations in addition to quaternion rotations.
   */
  constructor(owner: InstancedMesh2, id: number, useEuler: boolean) {
    this.id = id;
    this.owner = owner;

    if (useEuler) {
      const quaternion = this.quaternion;
      const rotation = this.rotation = new Euler();

      rotation._onChange(() => quaternion.setFromEuler(rotation, false));
      quaternion._onChange(() => rotation.setFromQuaternion(quaternion, undefined, false));
    }
  }

  /**
   * @internal
   */
  public setMatrixIdentity(): void {
    const owner = this.owner;
    const te = owner.matricesTexture._data;
    const id = this.id;
    const offset = id * 16;

    te[offset + 0] = 1;
    te[offset + 1] = 0;
    te[offset + 2] = 0;
    te[offset + 3] = 0;

    te[offset + 4] = 0;
    te[offset + 5] = 1;
    te[offset + 6] = 0;
    te[offset + 7] = 0;

    te[offset + 8] = 0;
    te[offset + 9] = 0;
    te[offset + 10] = 1;
    te[offset + 11] = 0;

    te[offset + 12] = 0;
    te[offset + 13] = 0;
    te[offset + 14] = 0;
    te[offset + 15] = 1;

    owner.matricesTexture.enqueueUpdate(id);
  }

  /**
   * Updates the transformation matrix with its current position, quaternion, and scale.
   * The updated matrix is stored in the `owner.matricesTexture`.
   */
  public updateMatrix(): void {
    const owner = this.owner;
    const position = this.position;
    const quaternion = this.quaternion as any;
    const scale = this.scale;
    const te = owner.matricesTexture._data;
    const id = this.id;
    const offset = id * 16;

    const x = quaternion._x, y = quaternion._y, z = quaternion._z, w = quaternion._w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;

    const sx = scale.x, sy = scale.y, sz = scale.z;

    te[offset + 0] = (1 - (yy + zz)) * sx;
    te[offset + 1] = (xy + wz) * sx;
    te[offset + 2] = (xz - wy) * sx;
    te[offset + 3] = 0;

    te[offset + 4] = (xy - wz) * sy;
    te[offset + 5] = (1 - (xx + zz)) * sy;
    te[offset + 6] = (yz + wx) * sy;
    te[offset + 7] = 0;

    te[offset + 8] = (xz + wy) * sz;
    te[offset + 9] = (yz - wx) * sz;
    te[offset + 10] = (1 - (xx + yy)) * sz;
    te[offset + 11] = 0;

    te[offset + 12] = position.x;
    te[offset + 13] = position.y;
    te[offset + 14] = position.z;
    te[offset + 15] = 1;

    owner.matricesTexture.enqueueUpdate(id);

    if (owner.bvh && owner.autoUpdateBVH) {
      owner.bvh.move(id);
    }
  }

  /**
   * Updates only the position component of the transformation matrix.
   * This is useful if only position changes, avoiding recalculating the full matrix.
   * The updated matrix is stored in the `owner.matricesTexture`.
   */
  public updateMatrixPosition(): void {
    const owner = this.owner;
    const position = this.position;
    const te = owner.matricesTexture._data;
    const id = this.id;
    const offset = id * 16;

    te[offset + 12] = position.x;
    te[offset + 13] = position.y;
    te[offset + 14] = position.z;

    owner.matricesTexture.enqueueUpdate(id);

    if (owner.bvh && owner.autoUpdateBVH) {
      owner.bvh.move(id);
    }
  }

  /**
   * Retrieves the uniform value associated with the given name.
   * @param name The name of the uniform to retrieve.
   * @param target Optional target object where the uniform value will be written.
   * @returns The retrieved uniform value.
   */
  public getUniform(name: string, target?: UniformValueObj): UniformValue {
    return this.owner.getUniformAt(this.id, name, target);
  }

  /**
   * Updates the bones of the skeleton to the instance.
   * @param updateBonesMatrices Whether to update the matrices of the bones. Default is `true`.
   * @param excludeBonesSet An optional set of bone names to exclude from updates, skipping their local matrix updates.
  */
  public updateBones(updateBonesMatrices = true, excludeBonesSet?: Set<string>): void {
    this.owner.setBonesAt(this.id, updateBonesMatrices, excludeBonesSet);
  }

  /**
   * Sets the uniform value for the given name
   * @param name The name of the uniform to set.
   * @param value The new value for the uniform.
   */
  public setUniform(name: string, value: UniformValue): void {
    this.owner.setUniformAt(this.id, name, value);
  }

  /**
   * Copies the transformation properties (`position`, `scale`, `quaternion`) of this instance to the specified `Object3D`.
   * @param target The `Object3D` where the transformation properties will be copied.
   */
  public copyTo(target: Object3D): void {
    target.position.copy(this.position);
    target.scale.copy(this.scale);
    target.quaternion.copy(this.quaternion);
    if (this.rotation) target.rotation.copy(this.rotation); // TODO check if this is necessary.. it's probably already synched
  }

  /**
   * Applies the matrix transform to the object and updates the object's position, rotation and scale.
   * @param m The matrix to apply.
   * @returns The instance of the object.
   */
  public applyMatrix4(m: Matrix4): this {
    this.matrix.premultiply(m).decompose(this.position, this.quaternion, this.scale);
    return this;
  }

  /**
   * Applies the rotation represented by the quaternion to the object.
   * @param q The quaternion representing the rotation to apply.
   * @returns The instance of the object.
   */
  public applyQuaternion(q: Quaternion): this {
    this.quaternion.premultiply(q);
    return this;
  }

  /**
   * Rotate an object along an axis in object space. The axis is assumed to be normalized.
   * @param axis A normalized vector in object space.
   * @param angle The angle in radians.
   * @returns The instance of the object.
   */
  public rotateOnAxis(axis: Vector3, angle: number): this {
    _quat.setFromAxisAngle(axis, angle);
    this.quaternion.multiply(_quat);
    return this;
  }

  /**
   * Rotate an object along an axis in world space. The axis is assumed to be normalized. Method Assumes no rotated parent.
   * @param axis A normalized vector in world space.
   * @param angle The angle in radians.
   * @returns The instance of the object.
   */
  public rotateOnWorldAxis(axis: Vector3, angle: number): this {
    _quat.setFromAxisAngle(axis, angle);
    this.quaternion.premultiply(_quat);
    return this;
  }

  /**
   * Rotates the object around x axis in local space.
   * @param angle The angle to rotate in radians.
   * @returns The instance of the object.
   */
  public rotateX(angle: number): this {
    return this.rotateOnAxis(_xAxis, angle);
  }

  /**
   * Rotates the object around y axis in local space.
   * @param angle The angle to rotate in radians.
   * @returns The instance of the object.
   */
  public rotateY(angle: number): this {
    return this.rotateOnAxis(_yAxis, angle);
  }

  /**
   * Rotates the object around z axis in local space.
   * @param angle The angle to rotate in radians.
   * @returns The instance of the object.
   */
  public rotateZ(angle: number): this {
    return this.rotateOnAxis(_zAxis, angle);
  }

  /**
   * Translate an object by distance along an axis in object space. The axis is assumed to be normalized.
   * @param axis A normalized vector in object space.
   * @param distance The distance to translate.
   * @returns The instance of the object.
   */
  public translateOnAxis(axis: Vector3, distance: number): this {
    _vec3.copy(axis).applyQuaternion(this.quaternion);
    this.position.add(_vec3.multiplyScalar(distance));
    return this;
  }

  /**
   * Translates object along x axis in object space by distance units.
   * @param distance The distance to translate.
   * @returns The instance of the object.
   */
  public translateX(distance: number): this {
    return this.translateOnAxis(_xAxis, distance);
  }

  /**
   * Translates object along y axis in object space by distance units.
   * @param distance The distance to translate.
   * @returns The instance of the object.
   */
  public translateY(distance: number): this {
    return this.translateOnAxis(_yAxis, distance);
  }

  /**
   * Translates object along z axis in object space by distance units.
   * @param distance The distance to translate.
   * @returns The instance of the object.
   */
  public translateZ(distance: number): this {
    return this.translateOnAxis(_zAxis, distance);
  }

  /**
   * Removes this entity from its owner instance.
   * @returns The instance of the object.
   */
  public remove(): this {
    this.owner.removeInstances(this.id);
    return this;
  }
}

const _quat = new Quaternion();
const _vec3 = new Vector3();
const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _zAxis = new Vector3(0, 0, 1);
