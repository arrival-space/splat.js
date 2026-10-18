// planeShadow.js — the airplane's shadow on whatever is under it, Google's unlit tiles included,
// and on the airplane itself: the airplane seen from the sun (an orthographic camera looking down
// the sunbeams, only the airplane in its layer) into a small depth map, how far along the sunbeam
// the airplane first is; the clouds' composite (clouds.js) darkens every surface farther along it.
// The engine's own shadow is turned off for the airplane, so its shadow isn't doubled on our ground.

const PX = 512;     // (clouds.js's composite filters it at this size)

// the airplane's opaque meshes again, drawn as their depth along the sunbeam: 0 … 1 over the
// camera's range, in 16 bits (r high, g low), alpha 1 where the airplane is
const DEPTH_VS_GLSL = /* glsl */ `
attribute vec3 vertex_position;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vW;
void main(void) {
    vec4 w = matrix_model * vec4(vertex_position, 1.0);
    vW = w.xyz;
    gl_Position = matrix_viewProjection * w;
}
`;
const DEPTH_FS_GLSL = /* glsl */ `
uniform vec3 uDepthOrigin;     // the near plane's centre, world
uniform vec4 uDepthDir;        // down the sunbeam, 1 / range
varying vec3 vW;
void main(void) {
    float v = floor(clamp(dot(vW - uDepthOrigin, uDepthDir.xyz) * uDepthDir.w, 0.0, 1.0) * 65535.0 + 0.5);
    float hi = floor(v / 256.0);
    gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
}
`;
const DEPTH_VS_WGSL = /* wgsl */ `
attribute vertex_position: vec3f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
varying vW: vec3f;
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let w = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
    output.vW = w.xyz;
    output.position = uniform.matrix_viewProjection * w;
    return output;
}
`;
const DEPTH_FS_WGSL = /* wgsl */ `
uniform uDepthOrigin: vec3f;
uniform uDepthDir: vec4f;
varying vW: vec3f;
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let v = floor(clamp(dot(input.vW - uniform.uDepthOrigin, uniform.uDepthDir.xyz) * uniform.uDepthDir.w, 0.0, 1.0) * 65535.0 + 0.5);
    let hi = floor(v / 256.0);
    output.color = vec4f(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
    return output;
}
`;
export const PLANE_SHADOW_SHADERS = { DEPTH_VS_GLSL, DEPTH_FS_GLSL, DEPTH_VS_WGSL, DEPTH_FS_WGSL };

export class PlaneShadow {
  constructor(app) {
    this.app = app;
    const dev = app.graphicsDevice;
    this.layer = new pc.Layer({ name: 'Extra300PlaneShadow' });
    app.scene.layers.push(this.layer);
    // nearest: packed depth doesn't filter (the composite filters its comparisons instead)
    this.texture = new pc.Texture(dev, {
      name: 'extra300-plane-shadow', width: PX, height: PX, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    // bottom origin on both backends: sampled at clip × 0.5 + 0.5, as WebGL lays it out
    this.rt = new pc.RenderTarget({ colorBuffer: this.texture, depth: true, origin: 'bottom' });
    this.cam = new pc.Entity('PlaneShadowCamera');
    this.cam.addComponent('camera', {
      layers: [this.layer.id], priority: -60, renderTarget: this.rt, clearColor: new pc.Color(0, 0, 0, 0),
      projection: pc.PROJECTION_ORTHOGRAPHIC, orthoHeight: 10, nearClip: 0.1, farClip: 400, aspectRatio: 1, aspectRatioMode: pc.ASPECT_MANUAL,
    });
    app.root.addChild(this.cam);
    this.material = new pc.ShaderMaterial({
      uniqueName: 'extra300-plane-shadow-depth',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: DEPTH_VS_GLSL, fragmentGLSL: DEPTH_FS_GLSL,
      vertexWGSL: DEPTH_VS_WGSL, fragmentWGSL: DEPTH_FS_WGSL,
    });
    this.material.cull = pc.CULLFACE_NONE;
    this.material.update();
    this._vp = new pc.Mat4();
    this._view = new pc.Mat4();
    this._casters = [];
    this.root = null;
  }

  /**
   * The airplane to cast: a depth copy of each opaque mesh in our layer, as a child of its entity
   * (so it moves, and comes and goes, with it); the engine's shadow off.
   */
  setCaster(root) {
    for (const e of this._casters) if (e.parent) e.destroy();   // (gone already with an old airplane)
    this._casters = [];
    this.root = root;
    for (const r of root.findComponents('render')) {
      r.castShadows = false;
      const mis = r.meshInstances.filter((mi) => mi.material?.blendType === pc.BLEND_NONE && !mi.material?.uniqueName?.startsWith?.('extra300-plane-shadow'));
      if (!mis.length || r.entity.name === 'PlaneShadowCaster') continue;
      const e = new pc.Entity('PlaneShadowCaster');
      e.addComponent('render', {
        meshInstances: mis.map((mi) => new pc.MeshInstance(mi.mesh, this.material)),
        layers: [this.layer.id], castShadows: false, receiveShadows: false,
      });
      r.entity.addChild(e);
      this._casters.push(e);
    }
  }

  /**
   * Place the camera on the sunbeam through the airplane; what the composite needs back.
   * @param {number[]} sunDir  toward the sun (world)
   * @param {number} size      the airplane's span (world units)
   * @returns {{ texture, viewProj: Float32Array, origin: number[], invRange: number } | null}
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
    const o = [c.x + sunDir[0] * size, c.y + sunDir[1] * size, c.z + sunDir[2] * size];
    const invRange = 1 / (2 * size);
    this.material.setParameter('uDepthOrigin', o);
    this.material.setParameter('uDepthDir', [-sunDir[0], -sunDir[1], -sunDir[2], invRange]);
    return { texture: this.texture, viewProj: this._vp.data, origin: o, invRange };
  }

  destroy() {
    for (const e of this._casters) if (e.parent) e.destroy();
    this.cam.destroy();
    this.app.scene.layers.remove(this.layer);
    this.rt.destroy();
    this.texture.destroy();
    this.material.destroy();
  }
}
