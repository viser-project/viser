// @ts-nocheck
import { DataTexture, FloatType, RedFormat, TypedArray } from 'three';
import { InstancedMesh2 } from '../InstancedMesh2.js';

// TODO: add optimize method to reduce buffer size and remove instances objects

declare module '../InstancedMesh2.js' {
  interface InstancedMesh2 {
    /**
     * Resizes internal buffers to accommodate the specified capacity.
     * This ensures that the buffers are large enough to handle the required number of instances.
     * @param capacity The new capacity of the buffers.
     * @returns The current `InstancedMesh2` instance.
     */
    resizeBuffers(capacity: number): this;
    /** @internal */ setInstancesArrayCount(count: number): void;
  }
}

InstancedMesh2.prototype.resizeBuffers = function (capacity: number): InstancedMesh2 {
  const oldCapacity = this._capacity;
  this._capacity = capacity;
  const minCapacity = Math.min(capacity, oldCapacity);

  if (this.instanceIndex) {
    const indexArray = new Uint32Array(capacity);
    indexArray.set(new Uint32Array(this.instanceIndex.array.buffer, 0, minCapacity)); // safely copy TODO method
    this.instanceIndex.array = indexArray;
  }

  if (this.LODinfo) {
    for (const obj of this.LODinfo.objects) {
      obj._capacity = capacity;

      if (obj.instanceIndex) {
        const indexArray = new Uint32Array(capacity);
        indexArray.set(new Uint32Array(obj.instanceIndex.array.buffer, 0, minCapacity)); // safely copy TODO method
        obj.instanceIndex.array = indexArray;
      }
    }
  }

  this.availabilityArray.length = capacity * 2;

  this.matricesTexture.resize(capacity);

  if (this.colorsTexture) {
    this.colorsTexture.resize(capacity);
    if (capacity > oldCapacity) {
      this.colorsTexture._data.fill(1, oldCapacity * 4);
    }
  }

  if (this.morphTexture) { // test it
    const oldArray = this.morphTexture.image.data as TypedArray; // TODO check if they fix d.ts
    const size = oldArray.length / oldCapacity;
    this.morphTexture.dispose();
    this.morphTexture = new DataTexture(new Float32Array(size * capacity), size, capacity, RedFormat, FloatType);
    (this.morphTexture.image.data as TypedArray).set(oldArray); // FIX if reduce
  }

  this.uniformsTexture?.resize(capacity);

  return this;
};

InstancedMesh2.prototype.setInstancesArrayCount = function (count: number): void {
  if (count < this._instancesArrayCount) {
    const bvh = this.bvh;
    if (bvh) {
      for (let i = this._instancesArrayCount - 1; i >= count; i--) {
        if (!this.getActiveAt(i)) continue;
        bvh.delete(i);
      }
    }

    this._instancesArrayCount = count;
    return;
  }

  if (count > this._capacity) {
    let newCapacity = this._capacity + (this._capacity >> 1) + 512;
    while (newCapacity < count) {
      newCapacity += (newCapacity >> 1) + 512;
    }

    this.resizeBuffers(newCapacity);
  }

  const start = this._instancesArrayCount;
  this._instancesArrayCount = count;
  if (this._createEntities) this.createEntities(start);
};
