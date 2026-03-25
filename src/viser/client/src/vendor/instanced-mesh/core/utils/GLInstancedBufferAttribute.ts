// @ts-nocheck
import { GLBufferAttribute, TypedArray, WebGLRenderer } from 'three';

/**
 * A class that extends `GLBufferAttribute` to handle instanced buffer attributes.
 * This class was specifically created to allow updating instanced buffer attributes during the `onBeforeRender` callback,
 * providing an efficient way to modify the buffer data dynamically before rendering.
 */
export class GLInstancedBufferAttribute extends GLBufferAttribute {
  /**
   * Indicates if this is an `isGLInstancedBufferAttribute`.
   */
  public isGLInstancedBufferAttribute = true;
  /**
   * The number of meshes that share the same attribute data.
   */
  public meshPerAttribute: number;
  /**
   * The data array that holds the attribute values.
   */
  public array: TypedArray;
  protected _cacheArray: TypedArray;
  /** @internal */ _needsUpdate = false;

  // HACK TO MAKE IT WORK WITHOUT UPDATE CORE
  /** @internal */ isInstancedBufferAttribute = true;

  /**
   * @param gl The WebGL2RenderingContext used to create the buffer.
   * @param type The type of data in the attribute.
   * @param itemSize The number of elements per attribute.
   * @param elementSize The size of individual elements in the array.
   * @param array The data array that holds the attribute values.
   * @param meshPerAttribute The number of meshes that share the same attribute data.
   */
  constructor(gl: WebGL2RenderingContext, type: GLenum, itemSize: number, elementSize: 1 | 2 | 4, array: TypedArray, meshPerAttribute = 1) {
    const buffer = gl.createBuffer();
    super(buffer, type, itemSize, elementSize, array.length / itemSize);

    this.meshPerAttribute = meshPerAttribute;
    this.array = array;
    this._cacheArray = array;

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, array, gl.DYNAMIC_DRAW);
  }

  /**
   * Updates the buffer data.
   * This method is designed to be called during the `onBeforeRender` callback.
   * It ensures that the attribute data is updated just before the rendering process begins.
   * @param renderer The WebGLRenderer used to render the scene.
   * @param count The number of elements to update in the buffer.
   */
  public update(renderer: WebGLRenderer, count: number): void {
    if (!this._needsUpdate || count === 0) return;

    const gl = renderer.getContext();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    if (this.array === this._cacheArray) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.array, 0, count);
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, this.array, gl.DYNAMIC_DRAW);
      this._cacheArray = this.array;
    }

    this._needsUpdate = false;
  }

  /** @internal */
  public clone(): this {
    // This method is intentionally empty but necessary to avoid exceptions when cloning geometry.
    return this;
  }
}
