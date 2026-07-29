import { Camera, DirectionalLight, Object3D, Vector3 } from "three";

export interface ShadowCascadesParams {
  camera: Camera;
  parent: Object3D;
  cascades?: number;
  maxFar?: number;
  mode?: "practical" | "uniform" | "logarithmic" | "custom";
  shadowMapSize?: number;
  shadowBias?: number;
  lightDirection?: Vector3;
  lightIntensity?: number;
  lightNear?: number;
  lightFar?: number;
  lightMargin?: number;
  customSplitsCallback?: (
    cascades: number,
    near: number,
    far: number,
    breaks: number[],
  ) => void;
  reversedDepth?: boolean;
}

export class ShadowCascades {
  camera: Camera;
  parent: Object3D;
  cascades: number;
  maxFar: number;
  mode: "practical" | "uniform" | "logarithmic" | "custom";
  shadowMapSize: number;
  shadowBias: number;
  lightDirection: Vector3;
  lightIntensity: number;
  lightNear: number;
  lightFar: number;
  lightMargin: number;
  customSplitsCallback?: (
    cascades: number,
    near: number,
    far: number,
    breaks: number[],
  ) => void;
  lights: DirectionalLight[];

  constructor(data: ShadowCascadesParams);

  update(): void;
  updateFrustums(): void;
  remove(): void;
  dispose(): void;
}
