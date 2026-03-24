import { Camera, DirectionalLight, Material, Object3D, Vector3 } from 'three';

export interface CSMParameters {
  camera: Camera;
  parent: Object3D;
  cascades?: number;
  maxFar?: number;
  mode?: 'practical' | 'uniform' | 'logarithmic' | 'custom';
  shadowMapSize?: number;
  shadowBias?: number;
  lightDirection?: Vector3;
  lightIntensity?: number;
  lightNear?: number;
  lightFar?: number;
  lightMargin?: number;
  customSplitsCallback?: (cascades: number, near: number, far: number, breaks: number[]) => void;
  reversedDepth?: boolean;
}

export class CSM {
  camera: Camera;
  parent: Object3D;
  cascades: number;
  maxFar: number;
  mode: 'practical' | 'uniform' | 'logarithmic' | 'custom';
  shadowMapSize: number;
  shadowBias: number;
  lightDirection: Vector3;
  lightIntensity: number;
  lightNear: number;
  lightFar: number;
  lightMargin: number;
  customSplitsCallback?: (cascades: number, near: number, far: number, breaks: number[]) => void;
  fade: boolean;
  lights: DirectionalLight[];
  
  constructor(data: CSMParameters);
  
  update(): void;
  updateFrustums(): void;
  remove(): void;
  dispose(): void;
  setupMaterial(material: Material): void;
}