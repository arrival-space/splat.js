// reflectionProbe.js — what the airplane's paint reflects: the world round it, live. Screen-space
// reflections don't suit a convex hull (most of what it reflects, the ground under the belly, the sky,
// the scenery behind the camera, isn't on the screen), so a small cube is rendered from the airplane
// instead, a face at a time, and the paint, metal and canopy take it for their reflections
// (plugin/finishes.js). The airplane and its pilot are hidden from the cube's own cameras.
//
// Its sky is our own blue gradient (render/sky.js), drawn for the cube alone: Google's atmosphere
// shell is HDR, made for a tonemapped view, and in the cube's plain 8-bit faces it clipped to a flat
// grey; it is hidden from the cube instead. And the cube lights the airplane too: read back now and
// then, it is projected onto spherical harmonics, the ambient light its materials take
// (irradiance()).

import { buildSkyDome } from '../render/sky.js';
import { toMesh } from './pcMesh.js';

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
    this.size = size;
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
        nearClip: 0.1, farClip: 60000, clearColor: new pc.Color(0.7, 0.78, 0.86, 1),
        renderTarget: new pc.RenderTarget({ colorBuffer: this.texture, depth: true, face: i, flipY: !device.isWebGPU }),
      });
      e.setRotation(new pc.Quat().setFromEulerAngles(...r));
      e.enabled = false;
      this.root.addChild(e);
      this.cams.add(e.camera.camera);
      return e;
    });
    this.hidden = new WeakSet();
    // the sky, for the cube's cameras only
    const m = new pc.StandardMaterial();
    m.useLighting = false;
    m.diffuse = new pc.Color(0, 0, 0);
    m.emissiveVertexColor = true;
    m.emissive = new pc.Color(1, 1, 1);
    m.cull = pc.CULLFACE_NONE;
    m.useFog = false;
    m.useSkybox = false;
    m.update();
    this.skyMesh = toMesh(device, buildSkyDome());
    this.skyMi = new pc.MeshInstance(this.skyMesh, m);
    this.skyMi.isVisibleFunc = (camera) => this.cams.has(camera);
    this.sky = new pc.Entity('ReflectionProbeSky');
    this.sky.addComponent('render', { meshInstances: [this.skyMi], castShadows: false, receiveShadows: false });
    this.root.addChild(this.sky);
    this.sun = null;
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
  update(at, on, scale = 1, sun = null) {
    for (const f of this.faces) f.enabled = false;
    if (!on) { this.filled = 0; return false; }
    this.root.setPosition(at);
    // the sky just inside the far clip; its haze brightened toward the sun (re-made when it moves)
    this.sky.setLocalScale(54000 * scale, 54000 * scale, 54000 * scale);
    if (sun && (!this.sun || sun[0] * this.sun[0] + sun[1] * this.sun[1] + sun[2] * this.sun[2] < 0.9995)) {
      this.sun = sun.slice();
      const old = this.skyMesh;
      this.skyMesh = toMesh(this.app.graphicsDevice, buildSkyDome(32, 14, this.sun));
      this.skyMi.mesh = this.skyMesh;
      old.destroy();
    }
    if (this.frame++ % this.every === 0) {
      const f = this.faces[this.face];
      f.camera.nearClip = 0.1 * scale;
      f.camera.farClip = 60000 * scale;
      f.enabled = true;
      this.face = (this.face + 1) % 6;
      this.filled++;
    }
    return this.filled > 6;
  }

  /**
   * The light the cube sheds on a surface, as the engine's ambientSH takes it: an irradiance-convolved
   * second-order spherical harmonic (Ramamoorthi & Hanrahan), in the shader's terms (1, x, y, z, xz,
   * zy, yx, 3z²−1, x²−y²) × rgb, scaled so a sky of even radiance L lights a surface as an ambient L
   * would. Read back from the GPU (every 8th texel of each face); null while a read is under way.
   * @returns {Promise<Float32Array|null>}
   */
  async irradiance() {
    if (this._reading) return null;
    this._reading = true;
    try {
      const S = this.size, step = Math.max(1, S >> 4);
      const acc = new Float64Array(27);
      let wsum = 0;
      const d = new pc.Vec3(), lin = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      // each face's read begun outside the frame (begun inside the app's update, one never came
      // back), and given up on if it doesn't come back
      const readFace = (i) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 3000);
        setTimeout(() => {
          if (this._destroyed) { clearTimeout(t); resolve(null); return; }
          Promise.resolve(this.texture.read(0, 0, S, S, { face: i, immediate: true }))
            .then((px) => { clearTimeout(t); resolve(px); }, () => { clearTimeout(t); resolve(null); });
        }, 0);
      });
      for (let i = 0; i < 6; i++) {
        const px = await readFace(i);
        if (!px || this._destroyed) return null;
        const q = this.faces[i].getRotation();
        // the faces are stored top row first (flipped as rendered on WebGL, natively on WebGPU)
        for (let r = step >> 1; r < S; r += step) {
          for (let c = step >> 1; c < S; c += step) {
            const u = -1 + (2 * (c + 0.5)) / S, v = 1 - (2 * (r + 0.5)) / S;
            q.transformVector(d.set(u, v, -1), d).normalize();
            const w = 1 / (u * u + v * v + 1) ** 1.5;          // the texel's solid angle
            const k = (r * S + c) * 4;
            const x = d.x, y = d.y, z = d.z;
            const Y = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z,
              0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
            const rgb = [lin(px[k]), lin(px[k + 1]), lin(px[k + 2])];
            for (let j = 0; j < 9; j++) for (let ch = 0; ch < 3; ch++) acc[j * 3 + ch] += Y[j] * rgb[ch] * w;
            wsum += w;
          }
        }
      }
      // L_lm (the band-l, order-m coefficients: 00, 1−1, 10, 11, 2−2, 2−1, 20, 21, 22) → the shader's terms,
      // each with its band's convolution over π (1, 2/3, 1/4)
      const L = (j, ch) => acc[j * 3 + ch] * ((4 * Math.PI) / wsum);
      const out = new Float32Array(27);
      const terms = [[0, 1, 0.282095], [3, 2 / 3, 0.488603], [1, 2 / 3, 0.488603], [2, 2 / 3, 0.488603],
        [7, 1 / 4, 1.092548], [5, 1 / 4, 1.092548], [4, 1 / 4, 1.092548], [6, 1 / 4, 0.315392], [8, 1 / 4, 0.546274]];
      terms.forEach(([j, a, k], t) => { for (let ch = 0; ch < 3; ch++) out[t * 3 + ch] = a * k * L(j, ch); });
      return out;
    } finally {
      this._reading = false;
    }
  }

  destroy() {
    this._destroyed = true;
    for (const f of this.faces) f.camera.renderTarget?.destroy();
    this.root.destroy();
    this.texture.destroy();
  }
}
