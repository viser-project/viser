// @ts-nocheck
import { Color, ColorManagement, DataTexture, FloatType, IntType, Matrix3, Matrix4, NoColorSpace, PixelFormat, RedFormat, RedIntegerFormat, RGBAFormat, RGBAIntegerFormat, RGFormat, RGIntegerFormat, TextureDataType, TypedArray, UnsignedIntType, Vector2, Vector3, Vector4, WebGLRenderer, WebGLUtils } from 'three';

/**
 * Represents the number of elements per pixel.
 */
export type ChannelSize = 1 | 2 | 3 | 4;
/**
 * A constructor signature for creating TypedArray.
 */
export type TypedArrayConstructor = new (count: number) => TypedArray;
/**
 * Represents the texture information including its data, size, format, and data type.
 */
export type TextureInfo = { array: TypedArray; size: number; format: PixelFormat; type: TextureDataType };
/**
 * Represents information for updating rows in the texture, including the row index and number of rows.
 */
export type UpdateRowInfo = { row: number; count: number };
/**
 * Defines the possible types of uniforms that can be used in shaders.
 */
export type UniformType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'mat3' | 'mat4';
/**
 * Represents a value that can be used as a uniform.
 */
export type UniformValueObj = Vector2 | Vector3 | Vector4 | Matrix3 | Matrix4 | Color;
/**
 * Defines a uniform value as either a number or a compatible Three.js object.
 */
export type UniformValue = number | UniformValueObj;
/**
 * Represents the schema for a uniform, defining its offset, size, and type.
 */
export type UniformMapType = { offset: number; size: number; type: UniformType };
/**
 * Represents a map of uniform names to their schema definitions.
 */
export type UniformMap = Map<string, UniformMapType>;

/**
 * Calculates the square texture size based on the capacity and pixels per instance.
 * This ensures the texture is large enough to store all instances in a square layout.
 * @param capacity The maximum number of instances allowed in the texture.
 * @param pixelsPerInstance The number of pixels required for each instance.
 * @returns The size of the square texture needed to store all the instances.
 */
export function getSquareTextureSize(capacity: number, pixelsPerInstance: number): number {
  return Math.max(pixelsPerInstance, Math.ceil(Math.sqrt(capacity / pixelsPerInstance)) * pixelsPerInstance);
}

/**
 * Generates texture information (size, format, type) for a square texture based on the provided parameters.
 * @param arrayType The constructor for the TypedArray.
 * @param channels The number of channels in the texture.
 * @param pixelsPerInstance The number of pixels required for each instance.
 * @param capacity The maximum number of instances allowed in the texture.
 * @returns An object containing the texture's array, size, format, and data type.
 */
export function getSquareTextureInfo(arrayType: TypedArrayConstructor, channels: ChannelSize, pixelsPerInstance: number, capacity: number): TextureInfo {
  if (channels === 3) {
    console.warn('"channels" cannot be 3. Set to 4. More info: https://github.com/mrdoob/three.js/pull/23228');
    channels = 4;
  }

  const size = getSquareTextureSize(capacity, pixelsPerInstance);
  const array = new arrayType(size * size * channels);
  const isFloat = arrayType.name.includes('Float');
  const isUnsignedInt = arrayType.name.includes('Uint');
  const type: TextureDataType = isFloat ? FloatType : (isUnsignedInt ? UnsignedIntType : IntType);
  let format: PixelFormat;

  switch (channels) {
    case 1:
      format = isFloat ? RedFormat : RedIntegerFormat;
      break;
    case 2:
      format = isFloat ? RGFormat : RGIntegerFormat;
      break;
    case 4:
      format = isFloat ? RGBAFormat : RGBAIntegerFormat;
      break;
  }

  return { array, size, type, format };
}

/**
 * A class that extends `DataTexture` to manage a square texture optimized for instances rendering.
 * It supports dynamic resizing, partial update based on rows, and allows setting/getting uniforms per instance.
 */
export class SquareDataTexture extends DataTexture {
  /**
   * Whether to enable partial texture updates by row. If `false`, the entire texture will be updated.
   * @default true.
   */
  public partialUpdate = true;
  /**
   * The maximum number of update calls per frame.
   * @default Infinity
   */
  public maxUpdateCalls = Infinity;
  /** @internal */ _data: TypedArray; // TODO make it public or remove it?
  protected _channels: ChannelSize;
  protected _pixelsPerInstance: number;
  protected _stride: number;
  protected _rowToUpdate: boolean[];
  protected _uniformMap: UniformMap;
  protected _fetchUniformsInFragmentShader: boolean;
  protected _utils: WebGLUtils = null; // TODO add it to renderer instead of creating for each texture
  protected _needsUpdate = true;
  protected _lastWidth = -1;

  /**
   * @param arrayType The constructor for the TypedArray.
   * @param channels The number of channels in the texture.
   * @param pixelsPerInstance The number of pixels required for each instance.
   * @param capacity The total number of instances.
   * @param uniformMap Optional map for handling uniform values.
   * @param fetchInFragmentShader Optional flag that determines if uniform values should be fetched in the fragment shader instead of the vertex shader.
   */
  constructor(arrayType: TypedArrayConstructor, channels: ChannelSize, pixelsPerInstance: number, capacity: number, uniformMap?: UniformMap, fetchInFragmentShader?: boolean) {
    if (channels === 3) channels = 4;
    const { array, format, size, type } = getSquareTextureInfo(arrayType, channels, pixelsPerInstance, capacity);
    super(array, size, size, format, type);
    this._data = array;
    this._channels = channels;
    this._pixelsPerInstance = pixelsPerInstance;
    this._stride = pixelsPerInstance * channels;
    this._rowToUpdate = new Array(size);
    this._uniformMap = uniformMap;
    this._fetchUniformsInFragmentShader = fetchInFragmentShader;
    this.needsUpdate = true; // necessary to init texture
  }

  /**
   * Resizes the texture to accommodate a new number of instances.
   * @param count The new total number of instances.
   */
  public resize(count: number): void {
    const size = getSquareTextureSize(count, this._pixelsPerInstance);
    if (size === this.image.width) return;

    const currentData = this._data;
    const channels = this._channels;
    this._rowToUpdate.length = size;
    const arrayType = (currentData as any).constructor;

    const data = new arrayType(size * size * channels);
    const minLength = Math.min(currentData.length, data.length);
    data.set(new arrayType(currentData.buffer, 0, minLength));

    this.dispose();
    this.image = { data, height: size, width: size };
    this._data = data;
  }

  /**
   * Marks a row of the texture for update during the next render cycle.
   * This helps in optimizing texture updates by only modifying the rows that have changed.
   * @param index The index of the instance to update.
   */
  public enqueueUpdate(index: number): void {
    this._needsUpdate = true;
    if (!this.partialUpdate) return;

    const elementsPerRow = this.image.width / this._pixelsPerInstance;
    const rowIndex = Math.floor(index / elementsPerRow);
    this._rowToUpdate[rowIndex] = true;
  }

  public bindToProgram(renderer: WebGLRenderer, gl: WebGL2RenderingContext, programUniforms: unknown, materialUniforms: unknown, uniformName: string): void {
    if (!materialUniforms[uniformName]) return;

    materialUniforms[uniformName].value = this;

    const slot = this.getSlot(programUniforms, uniformName);
    if (slot === undefined) return;

    const textureProperties: any = renderer.properties.get(this);
    (renderer.state as any).bindTexture(gl.TEXTURE_2D, textureProperties.__webglTexture, gl.TEXTURE0 + slot); // TODO fix d.ts
  }

  /**
   * Updates the texture data based on the rows that need updating.
   * This method is optimized to only update the rows that have changed, improving performance.
   * @param renderer The WebGLRenderer used for rendering.
   * @param materialProperties The material properties associated with the texture.
   * @param uniformName The name of the uniform in the shader.
   */
  public update(renderer: WebGLRenderer, materialProperties: any, uniformName: string): void {
    const textureProperties: any = renderer.properties.get(this);
    const versionChanged = textureProperties.__version !== this.version;

    if (!this._needsUpdate && !versionChanged) return;

    const sizeChanged = this._lastWidth !== this.image.width;

    if (!textureProperties.__webglTexture || sizeChanged) {
      renderer.initTexture(this);
    } else {
      const slot = this.getSlot(materialProperties, uniformName) ?? renderer.capabilities.maxTextures - 1;

      if (this.partialUpdate) {
        this.updatePartial(textureProperties, renderer, slot);
      } else {
        this.updateFull(textureProperties, renderer, slot);
      }

      textureProperties.__version = this.version;
    }

    this._lastWidth = this.image.width;
    this._needsUpdate = false;
  }

  protected getSlot(programUniforms: any, uniformName: string): number | undefined {
    return programUniforms[uniformName]?.cache[0] as number;
  }

  protected updateFull(textureProperties: any, renderer: WebGLRenderer, slot: number): void {
    this.updateRows(textureProperties, renderer, [{ row: 0, count: this.image.height }], slot);
  }

  protected updatePartial(textureProperties: any, renderer: WebGLRenderer, slot: number): void {
    const rowsInfo = this.getUpdateRowsInfo();
    if (rowsInfo.length === 0) return;

    if (rowsInfo.length > this.maxUpdateCalls) {
      this.updateFull(textureProperties, renderer, slot);
    } else {
      this.updateRows(textureProperties, renderer, rowsInfo, slot);
    }

    this._rowToUpdate.fill(false);
  }

  // TODO reuse same objects to prevent memory leak
  protected getUpdateRowsInfo(): UpdateRowInfo[] {
    const rowsToUpdate = this._rowToUpdate;
    const result: UpdateRowInfo[] = [];

    for (let i = 0, l = rowsToUpdate.length; i < l; i++) {
      if (rowsToUpdate[i]) {
        const row = i;
        for (; i < l; i++) {
          if (!rowsToUpdate[i]) break;
        }
        result.push({ row, count: i - row });
      }
    }

    return result;
  }

  protected updateRows(textureProperties: any, renderer: WebGLRenderer, info: UpdateRowInfo[], slot: number): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    // @ts-expect-error Expected 2 arguments, but got 3.
    this._utils ??= new WebGLUtils(gl, renderer.extensions, renderer.capabilities); // third argument is necessary for older three versions
    const glFormat = this._utils.convert(this.format);
    const glType = this._utils.convert(this.type);
    const { data, width } = this.image;
    const channels = this._channels;

    renderer.state.activeTexture(gl.TEXTURE0 + slot);
    (renderer.state as any).bindTexture(gl.TEXTURE_2D, textureProperties.__webglTexture, gl.TEXTURE0 + slot); // TODO fix d.ts

    const workingPrimaries = ColorManagement.getPrimaries(ColorManagement.workingColorSpace);
    const texturePrimaries = this.colorSpace === NoColorSpace ? null : ColorManagement.getPrimaries(this.colorSpace);
    const unpackConversion = this.colorSpace === NoColorSpace || workingPrimaries === texturePrimaries ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL;

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, this.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.premultiplyAlpha);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, this.unpackAlignment);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, unpackConversion);

    for (const { count, row } of info) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, width, count, glFormat, glType, data, row * width * channels);
    }

    this.onUpdate?.(this);
  }

  /**
   * Sets a uniform value at the specified instance ID in the texture.
   * @param id The instance ID to set the uniform for.
   * @param name The name of the uniform.
   * @param value The value to set for the uniform.
   */
  public setUniformAt(id: number, name: string, value: UniformValue): void {
    const { offset, size } = this._uniformMap.get(name);
    const stride = this._stride;

    if (size === 1) {
      this._data[id * stride + offset] = value as number;
    } else {
      (value as UniformValueObj).toArray(this._data, id * stride + offset);
    }
  }

  /**
   * Retrieves a uniform value at the specified instance ID from the texture.
   * @param id The instance ID to retrieve the uniform from.
   * @param name The name of the uniform.
   * @param target Optional target object to store the uniform value.
   * @returns The uniform value for the specified instance.
   */
  public getUniformAt(id: number, name: string, target?: UniformValueObj): UniformValue {
    const { offset, size } = this._uniformMap.get(name);
    const stride = this._stride;

    if (size === 1) {
      return this._data[id * stride + offset];
    }

    return target.fromArray(this._data, id * stride + offset);
  }

  /**
   * Generates the GLSL code for accessing the uniform data stored in the texture.
   * @param textureName The name of the texture in the GLSL shader.
   * @param indexName The name of the index in the GLSL shader.
   * @param indexType The type of the index in the GLSL shader.
   * @returns An object containing the GLSL code for the vertex and fragment shaders.
   */
  public getUniformsGLSL(textureName: string, indexName: string, indexType: string): { vertex: string; fragment: string } {
    const vertex = this.getUniformsVertexGLSL(textureName, indexName, indexType);
    const fragment = this.getUniformsFragmentGLSL(textureName, indexName, indexType);
    return { vertex, fragment };
  }

  protected getUniformsVertexGLSL(textureName: string, indexName: string, indexType: string): string {
    if (this._fetchUniformsInFragmentShader) {
      return `
        flat varying ${indexType} ez_v${indexName}; 
        void main() {
          ez_v${indexName} = ${indexName};`;
    }

    const texelsFetch = this.texelsFetchGLSL(textureName, indexName);
    const getFromTexels = this.getFromTexelsGLSL();
    const { assignVarying, declareVarying } = this.getVarying();

    return `
      uniform highp sampler2D ${textureName};  
      ${declareVarying}
      void main() {
        ${texelsFetch}
        ${getFromTexels}
        ${assignVarying}`;
  }

  protected getUniformsFragmentGLSL(textureName: string, indexName: string, indexType: string): string {
    if (!this._fetchUniformsInFragmentShader) {
      const { declareVarying, getVarying } = this.getVarying();

      return `
      ${declareVarying}
      void main() {
        ${getVarying}`;
    }

    const texelsFetch = this.texelsFetchGLSL(textureName, `ez_v${indexName}`);
    const getFromTexels = this.getFromTexelsGLSL();

    return `
      uniform highp sampler2D ${textureName};  
      flat varying ${indexType} ez_v${indexName};
      void main() {
        ${texelsFetch}
        ${getFromTexels}`;
  }

  protected texelsFetchGLSL(textureName: string, indexName: string): string {
    const pixelsPerInstance = this._pixelsPerInstance;

    let texelsFetch = `
      int size = textureSize(${textureName}, 0).x;
      int j = int(${indexName}) * ${pixelsPerInstance};
      int x = j % size;
      int y = j / size;
    `;

    for (let i = 0; i < pixelsPerInstance; i++) {
      texelsFetch += `vec4 ez_texel${i} = texelFetch(${textureName}, ivec2(x + ${i}, y), 0);\n`;
    }

    return texelsFetch;
  }

  protected getFromTexelsGLSL(): string {
    const uniforms = this._uniformMap;
    let getFromTexels = '';

    for (const [name, { type, offset, size }] of uniforms) {
      const tId = Math.floor(offset / this._channels);

      if (type === 'mat3') {
        getFromTexels += `mat3 ${name} = mat3(ez_texel${tId}.rgb, vec3(ez_texel${tId}.a, ez_texel${tId + 1}.rg), vec3(ez_texel${tId + 1}.ba, ez_texel${tId + 2}.r));\n`;
      } else if (type === 'mat4') {
        getFromTexels += `mat4 ${name} = mat4(ez_texel${tId}, ez_texel${tId + 1}, ez_texel${tId + 2}, ez_texel${tId + 3});\n`;
      } else {
        const components = this.getUniformComponents(offset, size);
        getFromTexels += `${type} ${name} = ez_texel${tId}.${components};\n`;
      }
    }

    return getFromTexels;
  }

  protected getVarying(): { declareVarying: string; assignVarying: string; getVarying: string } {
    const uniforms = this._uniformMap;
    let declareVarying = '';
    let assignVarying = '';
    let getVarying = '';

    for (const [name, { type }] of uniforms) {
      declareVarying += `flat varying ${type} ez_v${name};\n`;
      assignVarying += `ez_v${name} = ${name};\n`;
      getVarying += `${type} ${name} = ez_v${name};\n`;
    }

    return { declareVarying, assignVarying, getVarying };
  }

  protected getUniformComponents(offset: number, size: number): string {
    const startIndex = offset % this._channels;
    let components = '';

    for (let i = 0; i < size; i++) {
      components += componentsArray[startIndex + i];
    }

    return components;
  }

  public override copy(source: SquareDataTexture): this {
    super.copy(source);

    this.partialUpdate = source.partialUpdate;
    this.maxUpdateCalls = source.maxUpdateCalls;
    this._channels = source._channels;
    this._pixelsPerInstance = source._pixelsPerInstance;
    this._stride = source._stride;
    this._rowToUpdate = source._rowToUpdate;
    this._uniformMap = source._uniformMap;
    this._fetchUniformsInFragmentShader = source._fetchUniformsInFragmentShader;

    return this;
  }
}

const componentsArray = ['r', 'g', 'b', 'a'];
