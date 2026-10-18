// reflectionProbe.js — what the airplane's paint reflects: the world round it, live. Screen-space
// reflections don't suit a convex hull (most of what it reflects, the ground under the belly, the sky,
// the scenery behind the camera, isn't on the screen), so a small cube is rendered from the airplane
// instead, a face at a time, and the paint, metal and canopy take it for their reflections
// (plugin/finishes.js). The airplane and its pilot are hidden from the cube's own cameras.

// the face cameras, +x −x +y −y +z −z, as the engine's cubemap renderer turns them (the side faces
// unrolled: rolled, the world came out upside down on the paint)
const ROTATIONS = [[0, 90, 0], [0, -90, 0], [-90, 0, 180], [90, 0, 180], [0, 180, 0], [0, 0, 0]];

export class ReflectionProbe {
  /**
   * @param {pc.AppBase} app
   * @param {{ size?: number, every?: number }} [o]  face size (px); frames between face renders
   */
  constructor(app, { size = 128, every = 2 } = {}) {
    this.app = app;
    this.every = every;
    const device = app.graphicsDevice;
    this.texture = new pc.Texture(device, {
      name: 'extra300-reflections', cubemap: true, width: size, height: size, format: pc.PIXELFORMAT_SRGBA8,
      mipmaps: true, minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    this.root = new pc.Entity('ReflectionProbe');
    app.root.addChild(this.root);
    const layers = ['World', 'Skybox'].map((n) => app.scene.layers.getLayerByName(n)?.id).filter((id) => id !== undefined);
    this.cams = new Set();
    this.faces = ROTATIONS.map((r, i) => {
      const e = new pc.Entity(`ReflectionProbeFace${i}`);
      e.addComponent('camera', {
        layers, priority: -10, fov: 90, aspectRatioMode: pc.ASPECT_MANUAL, aspectRatio: 1,
        nearClip: 0.1, farClip: 20000, clearColor: new pc.Color(0.7, 0.78, 0.86, 1),
        renderTarget: new pc.RenderTarget({ colorBuffer: this.texture, depth: true, face: i, flipY: !device.isWebGPU }),
      });
      e.setRotation(new pc.Quat().setFromEulerAngles(...r));
      e.enabled = false;
      this.root.addChild(e);
      this.cams.add(e.camera.camera);
      return e;
    });
    this.hidden = new WeakSet();
    this.frame = 0;
    this.face = 0;
    this.filled = 0;     // faces rendered since the probe (re)started: the cube is used once all six are
  }

  /** Keep these mesh instances out of the cube (the airplane, the pilot): seen by every other camera. */
  hide(meshInstances) {
    const cams = this.cams;
    for (const mi of meshInstances) {
      if (this.hidden.has(mi)) continue;
      this.hidden.add(mi);
      const own = mi.isVisibleFunc;
      mi.isVisibleFunc = (camera) => !cams.has(camera) && (own ? own(camera) : camera.frustum.containsAabb(mi.aabb));
    }
  }

  /**
   * Once a frame: the cube at `at` (world), a face rendered every `every` frames; nothing while off.
   * @returns {boolean} whether the cube is whole (all six faces rendered since it started)
   */
  update(at, on, scale = 1) {
    for (const f of this.faces) f.enabled = false;
    if (!on) { this.filled = 0; return false; }
    this.root.setPosition(at);
    if (this.frame++ % this.every === 0) {
      const f = this.faces[this.face];
      f.camera.nearClip = 0.1 * scale;
      f.camera.farClip = 20000 * scale;
      f.enabled = true;
      this.face = (this.face + 1) % 6;
      this.filled++;
    }
    return this.filled > 6;
  }

  destroy() {
    for (const f of this.faces) f.camera.renderTarget?.destroy();
    this.root.destroy();
    this.texture.destroy();
  }
}
