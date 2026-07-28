import { Vector3, DirectionalLight, MathUtils, Matrix4, Box3 } from "three";
import { CascadeFrustum } from "./CascadeFrustum.js";

const _cameraToLightMatrix = new Matrix4();
const _lightSpaceFrustum = new CascadeFrustum({ webGL: true });
const _center = new Vector3();
const _origin = new Vector3();
const _bbox = new Box3();
const _uniformArray = [];
const _logArray = [];
const _lightOrientationMatrix = new Matrix4();
const _lightOrientationMatrixInverse = new Matrix4();
const _up = new Vector3(0, 1, 0);

/**
 * Approximate cascaded shadows for a directional light. Derived from
 * three.js's CSM addon (three/addons/csm/CSM.js), keeping only the
 * cascade-fitting math; the shader-injection half (setupMaterial/CSMShader)
 * is removed.
 *
 * This is NOT cascaded shadow mapping in the standard sense: nothing selects
 * a cascade per fragment. Each cascade is an ordinary shadow-casting
 * DirectionalLight (at intensity/cascades) whose shadow camera is fitted to
 * a slice of the view frustum. Every fragment is lit by all cascade lights,
 * and a fragment only receives a cascade's shadow when it lands inside that
 * cascade's shadow-camera bounds. The upside is that this composes with any
 * material (streamed meshes, GLB imports, instanced meshes) with no
 * per-material setup; the cost is that fully occluded points outside the
 * nearer cascades' bounds keep part of their direct light, so distant
 * shadows render lighter than true CSM would.
 */
export class ShadowCascades {
  /**
   * Constructs a new ShadowCascades instance.
   *
   * @param {ShadowCascades~Data} data - The ShadowCascades data.
   */
  constructor(data) {
    /**
     * The scene's camera.
     *
     * @type {Camera}
     */
    this.camera = data.camera;

    /**
     * The parent object, usually the scene.
     *
     * @type {Object3D}
     */
    this.parent = data.parent;

    /**
     * The number of cascades.
     *
     * @type {number}
     * @default 3
     */
    this.cascades = data.cascades ?? 3;

    /**
     * The maximum far value.
     *
     * @type {number}
     * @default 100000
     */
    this.maxFar = data.maxFar ?? 100000;

    /**
     * The frustum split mode.
     *
     * @type {('practical'|'uniform'|'logarithmic'|'custom')}
     * @default 'practical'
     */
    this.mode = data.mode ?? "practical";

    /**
     * The shadow map size.
     *
     * @type {number}
     * @default 2048
     */
    this.shadowMapSize = data.shadowMapSize ?? 2048;

    /**
     * The shadow bias.
     *
     * @type {number}
     * @default 0.000001
     */
    this.shadowBias = data.shadowBias ?? 0.000001;

    /**
     * The light direction.
     *
     * @type {Vector3}
     */
    this.lightDirection =
      data.lightDirection || new Vector3(1, -1, 1).normalize();

    /**
     * The light intensity.
     *
     * @type {number}
     * @default 3
     */
    this.lightIntensity = data.lightIntensity ?? 3;

    /**
     * The light near value.
     *
     * @type {number}
     * @default 1
     */
    this.lightNear = data.lightNear ?? 1;

    /**
     * The light far value.
     *
     * @type {number}
     * @default 2000
     */
    this.lightFar = data.lightFar ?? 2000;

    /**
     * The light margin: how far the shadow camera is pulled back toward the
     * light beyond the closest point of each cascade's bounding box, so
     * off-screen geometry between the light and the view frustum still casts.
     *
     * @type {number}
     * @default 200
     */
    this.lightMargin = data.lightMargin ?? 200;

    /**
     * Custom split callback when using `mode='custom'`.
     *
     * @type {Function}
     */
    this.customSplitsCallback = data.customSplitsCallback;

    /**
     * Whether a reversed depth buffer is in use.
     *
     * @type {boolean}
     * @default false
     */
    this.reversedDepth = data.reversedDepth ?? false;

    /**
     * The main frustum.
     *
     * @type {CascadeFrustum}
     */
    this.mainFrustum = new CascadeFrustum({
      webGL: true,
      reversedDepth: this.reversedDepth,
    });

    /**
     * An array of frustums representing the cascades.
     *
     * @type {Array<CascadeFrustum>}
     */
    this.frustums = [];

    /**
     * An array of numbers in the range `[0,1]` the defines how the
     * main frustum should be split up.
     *
     * @type {Array<number>}
     */
    this.breaks = [];

    /**
     * An array of directional lights which cast the shadows for
     * the different cascades. There is one directional light for each
     * cascade.
     *
     * @type {Array<DirectionalLight>}
     */
    this.lights = [];

    this._createLights();
    this.updateFrustums();
  }

  /**
   * Creates the directional lights of this ShadowCascades instance.
   *
   * @private
   */
  _createLights() {
    for (let i = 0; i < this.cascades; i++) {
      const light = new DirectionalLight(0xffffff, this.lightIntensity);
      light.castShadow = true;
      light.shadow.mapSize.width = this.shadowMapSize;
      light.shadow.mapSize.height = this.shadowMapSize;

      light.shadow.camera.near = this.lightNear;
      light.shadow.camera.far = this.lightFar;
      light.shadow.bias = this.shadowBias;

      this.parent.add(light);
      this.parent.add(light.target);
      this.lights.push(light);
    }
  }

  /**
   * Inits the cascades according to the scene's camera and breaks configuration.
   *
   * @private
   */
  _initCascades() {
    const camera = this.camera;
    camera.updateProjectionMatrix();
    this.mainFrustum.setFromProjectionMatrix(
      camera.projectionMatrix,
      this.maxFar,
    );
    this.mainFrustum.split(this.breaks, this.frustums);
  }

  /**
   * Updates the shadow bounds of this ShadowCascades instance.
   *
   * @private
   */
  _updateShadowBounds() {
    const frustums = this.frustums;
    for (let i = 0; i < frustums.length; i++) {
      const light = this.lights[i];
      const shadowCam = light.shadow.camera;
      const frustum = this.frustums[i];

      // Get the two points that represent that furthest points on the frustum assuming
      // that's either the diagonal across the far plane or the diagonal across the whole
      // frustum itself.
      const nearVerts = frustum.vertices.near;
      const farVerts = frustum.vertices.far;
      const point1 = farVerts[0];
      let point2;
      if (point1.distanceTo(farVerts[2]) > point1.distanceTo(nearVerts[2])) {
        point2 = farVerts[2];
      } else {
        point2 = nearVerts[2];
      }

      const squaredBBWidth = point1.distanceTo(point2);

      shadowCam.left = -squaredBBWidth / 2;
      shadowCam.right = squaredBBWidth / 2;
      shadowCam.top = squaredBBWidth / 2;
      shadowCam.bottom = -squaredBBWidth / 2;
      shadowCam.updateProjectionMatrix();
    }
  }

  /**
   * Computes the breaks of this ShadowCascades instance based on the scene's camera, number of cascades
   * and the selected split mode.
   *
   * @private
   */
  _getBreaks() {
    const camera = this.camera;
    const far = Math.min(camera.far, this.maxFar);
    this.breaks.length = 0;

    switch (this.mode) {
      case "uniform":
        uniformSplit(this.cascades, camera.near, far, this.breaks);
        break;
      case "logarithmic":
        logarithmicSplit(this.cascades, camera.near, far, this.breaks);
        break;
      case "practical":
        practicalSplit(this.cascades, camera.near, far, 0.5, this.breaks);
        break;
      case "custom":
        if (this.customSplitsCallback === undefined)
          console.error(
            "ShadowCascades: Custom split scheme callback not defined.",
          );
        this.customSplitsCallback(this.cascades, camera.near, far, this.breaks);
        break;
    }

    function uniformSplit(amount, near, far, target) {
      for (let i = 1; i < amount; i++) {
        target.push((near + ((far - near) * i) / amount) / far);
      }

      target.push(1);
    }

    function logarithmicSplit(amount, near, far, target) {
      for (let i = 1; i < amount; i++) {
        target.push((near * (far / near) ** (i / amount)) / far);
      }

      target.push(1);
    }

    function practicalSplit(amount, near, far, lambda, target) {
      _uniformArray.length = 0;
      _logArray.length = 0;
      logarithmicSplit(amount, near, far, _logArray);
      uniformSplit(amount, near, far, _uniformArray);

      for (let i = 1; i < amount; i++) {
        target.push(
          MathUtils.lerp(_uniformArray[i - 1], _logArray[i - 1], lambda),
        );
      }

      target.push(1);
    }
  }

  /**
   * Updates the ShadowCascades. This method must be called in your animation loop before
   * calling `renderer.render()`.
   */
  update() {
    const camera = this.camera;
    const frustums = this.frustums;

    // for each frustum we need to find its min-max box aligned with the light orientation
    // the position in _lightOrientationMatrix does not matter, as we transform there and back
    _lightOrientationMatrix.lookAt(_origin, this.lightDirection, _up);
    _lightOrientationMatrixInverse.copy(_lightOrientationMatrix).invert();

    for (let i = 0; i < frustums.length; i++) {
      const light = this.lights[i];
      const shadowCam = light.shadow.camera;
      const texelWidth =
        (shadowCam.right - shadowCam.left) / this.shadowMapSize;
      const texelHeight =
        (shadowCam.top - shadowCam.bottom) / this.shadowMapSize;
      _cameraToLightMatrix.multiplyMatrices(
        _lightOrientationMatrixInverse,
        camera.matrixWorld,
      );
      frustums[i].toSpace(_cameraToLightMatrix, _lightSpaceFrustum);

      const nearVerts = _lightSpaceFrustum.vertices.near;
      const farVerts = _lightSpaceFrustum.vertices.far;
      _bbox.makeEmpty();
      for (let j = 0; j < 4; j++) {
        _bbox.expandByPoint(nearVerts[j]);
        _bbox.expandByPoint(farVerts[j]);
      }

      _bbox.getCenter(_center);
      _center.z = _bbox.max.z + this.lightMargin;
      _center.x = Math.floor(_center.x / texelWidth) * texelWidth;
      _center.y = Math.floor(_center.y / texelHeight) * texelHeight;
      _center.applyMatrix4(_lightOrientationMatrix);

      light.position.copy(_center);
      light.target.position.copy(_center);

      light.target.position.x += this.lightDirection.x;
      light.target.position.y += this.lightDirection.y;
      light.target.position.z += this.lightDirection.z;
    }
  }

  /**
   * Applications must call this method every time they change camera or ShadowCascades settings.
   */
  updateFrustums() {
    this._getBreaks();
    this._initCascades();
    this._updateShadowBounds();
  }

  /**
   * Applications must call this method when they remove the ShadowCascades usage from their scene.
   */
  remove() {
    for (let i = 0; i < this.lights.length; i++) {
      this.parent.remove(this.lights[i].target);
      this.parent.remove(this.lights[i]);
    }
  }

  /**
   * Frees the GPU-related resources allocated by this instance. Call this
   * method whenever this instance is no longer used in your app.
   */
  dispose() {
    for (const light of this.lights) {
      // Frees the cascade's shadow-map render target.
      light.dispose();
    }
  }
}

/**
 * Constructor data of `ShadowCascades`.
 *
 * @typedef {Object} ShadowCascades~Data
 * @property {Camera} camera - The scene's camera.
 * @property {Object3D} parent - The parent object, usually the scene.
 * @property {number} [cascades=3] - The number of cascades.
 * @property {number} [maxFar=100000] - The maximum far value.
 * @property {('practical'|'uniform'|'logarithmic'|'custom')} [mode='practical'] - The frustum split mode.
 * @property {Function} [customSplitsCallback] - Custom split callback when using `mode='custom'`.
 * @property {number} [shadowMapSize=2048] - The shadow map size.
 * @property {number} [shadowBias=0.000001] - The shadow bias.
 * @property {Vector3} [lightDirection] - The light direction.
 * @property {number} [lightIntensity=3] - The light intensity.
 * @property {number} [lightNear=1] - The light near value.
 * @property {number} [lightFar=2000] - The light far value.
 * @property {number} [lightMargin=200] - The light margin.
 **/
