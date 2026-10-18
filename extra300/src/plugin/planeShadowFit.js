// planeShadowFit.js — the sun's shadow map fitted round the airplane (and its pilot) while flying.
// The engine fits each cascade to a slice of the camera's frustum, out to the light's shadowDistance;
// the airplane is the only caster then (see Extra300._publishShadows), so a far chase / tower / flyby
// view, the 777's 74 m, or the shadow on the ground half a kilometre below would all fall outside.
// Instead: the shadow distance reaches past where the shadow lands, and every cascade's shadow camera
// is the airplane's own box seen down the sun (its whole map on the airplane, at any distance), deep
// enough to reach the ground under it.

const corner = new pc.Vec3();
const pos = new pc.Vec3();
const foot = new pc.Vec3();
const box = new pc.BoundingBox();
const sphereBox = new pc.BoundingBox();
const R = new pc.Vec3(), U = new pc.Vec3(), F = new pc.Vec3();

export class PlaneShadowFit {
  /**
   * @param {pc.AppBase} app
   * @param {() => ({ meshes: pc.MeshInstance[], spheres: { at: pc.Vec3, r: number }[], agl: number } | null)} focus
   *        what casts (world units; agl: the airplane's height over the ground), or null: the engine's own fit
   */
  constructor(app, focus) {
    this.focus = focus;
    this.saved = new Map();      // light → its own shadowDistance, while we've changed it
    const sr = app.renderer?._shadowRendererDirectional;
    if (!sr?.cull) return;
    this.sr = sr;
    this.orig = sr.cull;
    sr.cull = this.cull = (light, comp, camera, casters) => {
      const f = light.castShadows ? this.focus() : null;
      if (!f || !this._bounds(f)) {
        this._restore(light);
        return this.orig.call(sr, light, comp, camera, casters);
      }
      // the light travels down its node's -Y: where the shadow lands, and how far that is from the camera
      const dir = F.copy(light._node.up).mulScalar(-1);
      const reach = f.agl / Math.max(0.08, -dir.y) + box.halfExtents.length();
      foot.copy(box.center).add(pos.copy(dir).mulScalar(reach));
      const cam = camera.node.getPosition();
      const far = Math.max(cam.distance(box.center), cam.distance(foot)) + box.halfExtents.length() * 2;
      if (!this.saved.has(light)) this.saved.set(light, light.shadowDistance);
      light.shadowDistance = Math.max(this.saved.get(light), far);
      this.orig.call(sr, light, comp, camera, casters);
      for (let c = 0; c < light.numCascades; c++) this._fit(light.getRenderData(camera, c), light, comp, casters, reach);
    };
  }

  /** The casters' world box: the airplane's meshes and the spheres (the pilot). */
  _bounds(f) {
    let any = false;
    for (const mi of f.meshes) {
      if (!mi.castShadow) continue;
      if (any) box.add(mi.aabb); else { box.copy(mi.aabb); any = true; }
    }
    if (!any) return false;
    for (const s of f.spheres) {
      sphereBox.center.copy(s.at);
      sphereBox.halfExtents.set(s.r, s.r, s.r);
      box.add(sphereBox);
    }
    return true;
  }

  /** One cascade's shadow camera on the box, looking down the sun, deep enough for the ground. */
  _fit(rd, light, comp, casters, reach) {
    const cam = rd.shadowCamera, node = cam._node;
    R.copy(node.right); U.copy(node.up); F.copy(node.forward);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const c = box.center, h = box.halfExtents;
    for (let i = 0; i < 8; i++) {
      corner.set(c.x + (i & 1 ? h.x : -h.x), c.y + (i & 2 ? h.y : -h.y), c.z + (i & 4 ? h.z : -h.z));
      const x = corner.dot(R), y = corner.dot(U), z = corner.dot(F);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const half = Math.max(x1 - x0, y1 - y0) * 0.5 * 1.04 + 0.05;
    const near = z0 - 1;
    pos.copy(R).mulScalar((x0 + x1) / 2).add(foot.copy(U).mulScalar((y0 + y1) / 2)).add(corner.copy(F).mulScalar(near));
    node.setPosition(pos);
    cam.nearClip = 0.01;
    cam.farClip = z1 - near + reach + 1;
    cam.orthoHeight = half;
    cam.updateFrustum();
    this.sr.shadowRenderer.cullShadowCasters(comp, light, rd.visibleCasters, cam, casters);
    rd.projectionCompensation = half;
  }

  _restore(light) {
    if (!this.saved.has(light)) return;
    light.shadowDistance = this.saved.get(light);
    this.saved.delete(light);
  }

  destroy() {
    if (this.sr && this.sr.cull === this.cull) this.sr.cull = this.orig;
    for (const light of [...this.saved.keys()]) this._restore(light);
  }
}
