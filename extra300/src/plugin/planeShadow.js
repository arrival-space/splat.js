// planeShadow.js — the airplane's shadow on whatever is under it, Google's unlit tiles included:
// the airplane seen from the sun (an orthographic camera looking down the sunbeams, only the
// airplane in its layer) into a small silhouette; the clouds' composite (clouds.js) darkens every
// surface behind it from the sun. The engine's own shadow is turned off for the airplane, so its
// shadow isn't doubled on our own ground.

const PX = 256;

export class PlaneShadow {
  constructor(app) {
    this.app = app;
    const dev = app.graphicsDevice;
    this.layer = new pc.Layer({ name: 'Extra300PlaneShadow' });
    app.scene.layers.push(this.layer);
    this.texture = new pc.Texture(dev, {
      name: 'extra300-plane-shadow', width: PX, height: PX, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    // bottom origin on both backends: sampled at clip × 0.5 + 0.5, as WebGL lays it out
    this.rt = new pc.RenderTarget({ colorBuffer: this.texture, depth: true, origin: 'bottom' });
    this.cam = new pc.Entity('PlaneShadowCamera');
    this.cam.addComponent('camera', {
      layers: [this.layer.id], priority: -60, renderTarget: this.rt, clearColor: new pc.Color(0, 0, 0, 0),
      projection: pc.PROJECTION_ORTHOGRAPHIC, orthoHeight: 10, nearClip: 0.1, farClip: 400, aspectRatio: 1, aspectRatioMode: pc.ASPECT_MANUAL,
    });
    app.root.addChild(this.cam);
    this._vp = new pc.Mat4();
    this._view = new pc.Mat4();
    this.root = null;
  }

  /** The airplane to cast: its meshes join our layer too, and stop casting the engine's shadow. */
  setCaster(root) {
    this.root = root;
    for (const r of root.findComponents('render')) {
      if (!r.layers.includes(this.layer.id)) r.layers = [...r.layers, this.layer.id];
      r.castShadows = false;
    }
  }

  /**
   * Place the camera on the sunbeam through the airplane; what the composite needs back.
   * @param {number[]} sunDir  toward the sun (world)
   * @param {number} size      the airplane's span (world units)
   * @returns {{ texture, viewProj: Float32Array, centre: number[], halfThickness: number } | null}
   */
  update(sunDir, size) {
    if (!this.root?.enabled) { this.cam.enabled = false; return null; }
    this.cam.enabled = true;
    const c = this.root.getPosition();
    const d = size * 4;
    this.cam.setPosition(c.x + sunDir[0] * d, c.y + sunDir[1] * d, c.z + sunDir[2] * d);
    // look down the sunbeam; 'up' anything not parallel to it
    const up = Math.abs(sunDir[1]) > 0.95 ? pc.Vec3.RIGHT : pc.Vec3.UP;
    this.cam.lookAt(c, up);
    const cc = this.cam.camera;
    cc.orthoHeight = size * 0.62;
    cc.nearClip = d - size;
    cc.farClip = d + size;
    this._view.copy(this.cam.getWorldTransform()).invert();
    this._vp.mul2(cc.projectionMatrix, this._view);
    return { texture: this.texture, viewProj: this._vp.data, centre: [c.x, c.y, c.z], halfThickness: size * 0.12 };
  }

  destroy() {
    this.cam.destroy();
    this.app.scene.layers.remove(this.layer);
    this.rt.destroy();
    this.texture.destroy();
  }
}
