// @ts-nocheck
import { Intersection, Matrix4, Mesh, Ray, Raycaster, Sphere, Vector3 } from 'three';
import { InstancedMesh2 } from '../InstancedMesh2.js';

declare module '../InstancedMesh2.js' {
  interface InstancedMesh2 {
    /** @internal */ raycastInstances(raycaster: Raycaster, result: Intersection[]): void;
    /** @internal */ checkObjectIntersection(raycaster: Raycaster, objectIndex: number, result: Intersection[]): void;
  }
}

const _intersections: Intersection[] = [];
const _mesh = new Mesh();
const _ray = new Ray();
const _direction = new Vector3();
const _worldScale = new Vector3();
const _invMatrixWorld = new Matrix4();
const _sphere = new Sphere();

InstancedMesh2.prototype.raycast = function (raycaster, result) {
  if (this._parentLOD || !this.material || this._instancesArrayCount === 0 || !this.instanceIndex) return;

  _mesh.geometry = this._geometry;
  _mesh.material = this.material;

  const originalRay = raycaster.ray;
  const originalNear = raycaster.near;
  const originalFar = raycaster.far;

  _invMatrixWorld.copy(this.matrixWorld).invert();

  _worldScale.setFromMatrixScale(this.matrixWorld);
  _direction.copy(raycaster.ray.direction).multiply(_worldScale);
  const scaleFactor = _direction.length();

  raycaster.ray = _ray.copy(raycaster.ray).applyMatrix4(_invMatrixWorld);
  raycaster.near /= scaleFactor;
  raycaster.far /= scaleFactor;

  this.raycastInstances(raycaster, result);

  raycaster.ray = originalRay;
  raycaster.near = originalNear;
  raycaster.far = originalFar;
};

InstancedMesh2.prototype.raycastInstances = function (raycaster, result) {
  if (this.bvh) {
    this.bvh.raycast(raycaster, (instanceId) => this.checkObjectIntersection(raycaster, instanceId, result));
    // TODO test with three-mesh-bvh
  } else {
    if (this.boundingSphere === null) this.computeBoundingSphere();
    _sphere.copy(this.boundingSphere);
    if (!raycaster.ray.intersectsSphere(_sphere)) return;

    const instancesToCheck = this.instanceIndex.array; // TODO this is unsorted and it's slower to iterate. If raycastFrustum is false, don't use it.
    const raycastFrustum = this.raycastOnlyFrustum && this._perObjectFrustumCulled;
    const checkCount = raycastFrustum ? this.count : this._instancesArrayCount;

    for (let i = 0; i < checkCount; i++) {
      this.checkObjectIntersection(raycaster, instancesToCheck[i], result);
    }
  }
};

InstancedMesh2.prototype.checkObjectIntersection = function (raycaster, objectIndex, result) {
  // TODO check objectIndex > this._instancesArrayCount is necessary
  if (objectIndex > this._instancesArrayCount || !this.getActiveAndVisibilityAt(objectIndex)) return;

  this.getMatrixAt(objectIndex, _mesh.matrixWorld);

  _mesh.raycast(raycaster, _intersections);

  for (const intersect of _intersections) {
    intersect.instanceId = objectIndex;
    intersect.object = this;
    result.push(intersect);
  }

  _intersections.length = 0;
};
