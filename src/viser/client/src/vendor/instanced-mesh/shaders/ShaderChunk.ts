// @ts-nocheck
import { ShaderChunk } from 'three';

// Inline GLSL shader chunks (originally imported via vite-plugin-glsl).
// Vendored from @three.ez/instanced-mesh v0.3.14 with reversed depth buffer support.

const instanced_pars_vertex = `#ifdef USE_INSTANCING_INDIRECT
  attribute uint instanceIndex;
  uniform highp sampler2D matricesTexture;

  mat4 getInstancedMatrix() {
    int size = textureSize( matricesTexture, 0 ).x;
    int j = int( instanceIndex ) * 4;
    int x = j % size;
    int y = j / size;
    vec4 v1 = texelFetch( matricesTexture, ivec2( x, y ), 0 );
    vec4 v2 = texelFetch( matricesTexture, ivec2( x + 1, y ), 0 );
    vec4 v3 = texelFetch( matricesTexture, ivec2( x + 2, y ), 0 );
    vec4 v4 = texelFetch( matricesTexture, ivec2( x + 3, y ), 0 );
    return mat4( v1, v2, v3, v4 );
  }
#endif
`;

const instanced_color_pars_vertex = `#ifdef USE_INSTANCING_COLOR_INDIRECT
  uniform highp sampler2D colorsTexture;

  vec4 getColorTexture() {
    int size = textureSize( colorsTexture, 0 ).x;
    int j = int( instanceIndex );
    int x = j % size;
    int y = j / size;
    return texelFetch( colorsTexture, ivec2( x, y ), 0 );
  }
#endif
`;

const instanced_vertex = `#ifdef USE_INSTANCING_INDIRECT
  mat4 instanceMatrix = getInstancedMatrix();

  #ifdef USE_INSTANCING_COLOR_INDIRECT
    vColor *= getColorTexture();
  #endif
#endif
`;

const instanced_color_vertex = `#ifdef USE_INSTANCING_COLOR_INDIRECT
  #ifdef USE_VERTEX_COLOR
    vColor = vec4( color );
  #else
    vColor = vec4( 1.0 );
  #endif
#endif
`;

const instanced_skinning_pars_vertex = `#ifdef USE_SKINNING
  uniform mat4 bindMatrix;
  uniform mat4 bindMatrixInverse;
  uniform highp sampler2D boneTexture;

  #ifdef USE_INSTANCING_SKINNING
    uniform int bonesPerInstance;
  #endif

  mat4 getBoneMatrix( const in float i ) {
    int size = textureSize( boneTexture, 0 ).x;

    #ifdef USE_INSTANCING_SKINNING
      int j = ( bonesPerInstance * int( instanceIndex ) + int( i ) ) * 4;
    #else
      int j = int( i ) * 4;
    #endif

    int x = j % size;
    int y = j / size;
    vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
    vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
    vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
    vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
    return mat4( v1, v2, v3, v4 );
  }
#endif
`;

ShaderChunk['instanced_pars_vertex'] = instanced_pars_vertex;
ShaderChunk['instanced_color_pars_vertex'] = instanced_color_pars_vertex;
ShaderChunk['instanced_vertex'] = instanced_vertex;
ShaderChunk['instanced_color_vertex'] = instanced_color_vertex;

/**
 * Patches the given shader string by adding a condition for indirect instancing support.
 * @param shader The shader code to modify.
 * @returns The modified shader code with the additional instancing condition.
 */
export function patchShader(shader: string): string {
  return shader.replace('#ifdef USE_INSTANCING', '#if defined USE_INSTANCING || defined USE_INSTANCING_INDIRECT');
}

ShaderChunk.project_vertex = patchShader(ShaderChunk.project_vertex);
ShaderChunk.worldpos_vertex = patchShader(ShaderChunk.worldpos_vertex);
ShaderChunk.defaultnormal_vertex = patchShader(ShaderChunk.defaultnormal_vertex);

ShaderChunk.batching_pars_vertex = ShaderChunk.batching_pars_vertex.concat('\n#include <instanced_pars_vertex>');
ShaderChunk.color_pars_vertex = ShaderChunk.color_pars_vertex.concat('\n#include <instanced_color_pars_vertex>');
ShaderChunk['batching_vertex'] = ShaderChunk['batching_vertex'].concat('\n#include <instanced_vertex>');

ShaderChunk.skinning_pars_vertex = instanced_skinning_pars_vertex;

// TODO FIX don't override like this, create a new shaderChunk to make it works also with older three.js version
if (ShaderChunk['morphinstance_vertex']) {
  ShaderChunk['morphinstance_vertex'] = ShaderChunk['morphinstance_vertex'].replaceAll('gl_InstanceID', 'instanceIndex');
}

// use 'getPatchedShader' function to make these example works
// examples/jsm/modifiers/CurveModifier.js
// examples/jsm/postprocessing/OutlinePass.js
