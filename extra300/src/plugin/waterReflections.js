// waterReflections.js — screen-space reflections on the lake: the airplane, the carrier, the
// island and the skyline mirrored in the water, rippled by its waves.
//
// A big quad at the lake's level, drawn with the transparent geometry, after the opaque scene has
// been copied (the camera's scene colour and depth maps). Over the water (the OSM mask,
// waterMask.js) and only where nothing stands in front of the lake, each pixel marches its
// reflected view ray through the depth buffer; where the ray passes behind something, that
// something's colour is blended in by the Fresnel term. Rays that leave the screen or reach the
// sky add nothing: the water's own shading (Google's tiles, patched, or our lake) already
// reflects the sky. Works on Google's lake and on ours alike, no matter what draws it.

const FAR = 40000;

const VS = /* glsl */ `
attribute vec3 vertex_position;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
varying vec3 vPositionW;
void main(void) {
    vec4 w = matrix_model * vec4(vertex_position, 1.0);
    vPositionW = w.xyz;
    gl_Position = matrix_viewProjection * w;
}
`;

const FS = /* glsl */ `
#include "screenDepthPS"
uniform sampler2D uSceneColorMap;
uniform mat4 matrix_projection;
uniform mat4 matrix_viewInverse;
uniform vec3 view_position;
uniform mat4 uWaterNearInv;
uniform mat4 uWaterFarInv;
uniform sampler2D uWaterNear;
uniform sampler2D uWaterFar;
uniform float uWaterScale;     // metres per world unit
uniform float uWaterTime;
uniform float uSteps;          // march steps (fewer on phones)
uniform float uStrength;
varying vec3 vPositionW;

float hash1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise1(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash1(i), hash1(i + vec2(1.0, 0.0)), f.x), mix(hash1(i + vec2(0.0, 1.0)), hash1(i + vec2(1.0, 1.0)), f.x), f.y);
}
// the same waves as the tiles' water shading (scripts/tilesWater.mjs), so the mirror ripples with them
vec2 waveSlope(vec2 p, float t, float fw) {
    float gust = 0.45 + 1.1 * noise1(p / 280.0 + vec2(t * 0.012, t * 0.004));
    vec2 g = vec2(0.0);
    for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float L = 24.0 * pow(0.72, fi);
        float a = 0.6 + (hash1(vec2(fi, 3.1)) - 0.5) * 2.2;
        vec2 d = vec2(cos(a), sin(a));
        float k = 6.2831853 / L;
        float vis = 1.0 - smoothstep(0.06 * L, 0.25 * L, fw);
        g += d * (0.042 * vis * cos(k * dot(d, p) - sqrt(9.81 * k) * t + hash1(vec2(fi, 7.7)) * 6.2831853));
    }
    return g * gust;
}

// the height (world) of what the depth buffer holds at screen point sp, linear depth d
float surfaceHeight(vec2 sp, float d) {
    vec2 ndc = sp * 2.0 - 1.0;
    vec3 pv = vec3((ndc - vec2(matrix_projection[2][0], matrix_projection[2][1])) / vec2(matrix_projection[0][0], matrix_projection[1][1]) * d, -d);
    return (matrix_viewInverse * vec4(pv, 1.0)).y;
}

void main(void) {
    vec2 uv = gl_FragCoord.xy * uScreenSize.zw;
    // over the lake only
    vec3 q = (uWaterNearInv * vec4(vPositionW, 1.0)).xyz;
    vec2 qf = (uWaterFarInv * vec4(vPositionW, 1.0)).xy;
    float inNear = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    float water = smoothstep(0.3, 0.7, mix(texture2D(uWaterFar, qf).r, texture2D(uWaterNear, q.xy).r, inNear));
    vec2 wp = vPositionW.xz * uWaterScale;
    float fw = max(length(dFdx(wp)), length(dFdy(wp)));
    if (water < 0.01) discard;

    vec3 toCam = view_position - vPositionW;
    float dist = length(toCam);
    vec3 V = toCam / dist;
    // nothing in front of the water here: the scene's depth reaches the lake (Google's surface may
    // sit a metre or two off ours, which at a grazing angle is a long way in depth)
    float lakeDepth = getLinearDepth(vPositionW);
    float sceneDepth = getLinearScreenDepth(uv);
    float slack = 3.0 / max(V.y, 0.02) / uWaterScale;
    if (sceneDepth < lakeDepth - slack) discard;

    // the waves a little calmer for the mirror than for the glints: a ripple, not shreds
    vec2 g = waveSlope(wp, uWaterTime, fw) * 0.18;
    vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.01);
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);

    // march the reflected ray across the screen, evenly in pixels (a thin wing isn't stepped over),
    // its depth interpolated perspective-correctly, from a jittered start (no banding)
    vec3 P0 = (matrix_view * vec4(vPositionW, 1.0)).xyz;
    vec3 D = normalize((matrix_view * vec4(R, 0.0)).xyz);
    float L = 30000.0 / uWaterScale;                         // as far as the skyline across the lake
    float nearZ = -camera_params.z * 1.001;
    if (P0.z + D.z * L > nearZ) L = (nearZ - P0.z) / D.z;    // not behind the camera
    vec3 P1 = P0 + D * L;
    vec4 c0 = matrix_projection * vec4(P0, 1.0), c1 = matrix_projection * vec4(P1, 1.0);
    float k0 = 1.0 / c0.w, k1 = 1.0 / c1.w;
    vec2 s0 = c0.xy * k0 * 0.5 + 0.5, s1 = c1.xy * k1 * 0.5 + 0.5;
    float z0 = P0.z * k0, z1 = P1.z * k1;
    // where the segment leaves the screen
    vec2 ds = s1 - s0;
    float fMax = 1.0;
    if (ds.x > 1e-6) fMax = min(fMax, (1.0 - s0.x) / ds.x); else if (ds.x < -1e-6) fMax = min(fMax, -s0.x / ds.x);
    if (ds.y > 1e-6) fMax = min(fMax, (1.0 - s0.y) / ds.y); else if (ds.y < -1e-6) fMax = min(fMax, -s0.y / ds.y);
    float pixels = length(ds / uScreenSize.zw) * fMax;
    float n = clamp(pixels / 1.2, 1.0, uSteps);
    float stride = fMax / n;
    float f = stride * (0.5 + 0.5 * hash1(gl_FragCoord.xy));
    vec2 hitUv = vec2(0.0);
    float hit = 0.0;
    float lastF = 0.0;
    for (int i = 0; i < 160; i++) {
        if (float(i) >= n || f > fMax) break;
        float k = mix(k0, k1, f);
        float rayDepth = -mix(z0, z1, f) / k;
        vec2 sp = s0 + ds * f;
        float d = getLinearScreenDepth(sp);
        float t = L * f * k1 / k;                            // world distance along the ray
        float thick = max(max(2.0 / uWaterScale, rayDepth * 0.02), abs(rayDepth - (-mix(z0, z1, lastF) / mix(k0, k1, lastF))) * 1.5);
        // behind a surface by less than its thickness, and off the lake itself (the ray has climbed)
        // (the sky, ours a dome near the far plane, is no surface: the water's own shading has it)
        // and not the lake again, far out where the depth buffer can't tell the ray from the water
        if (rayDepth > d && rayDepth - d < thick && t * R.y * uWaterScale > 0.4 && d < camera_params.y * 0.5
            && (surfaceHeight(sp, d) - vPositionW.y) * uWaterScale > max(1.0, 0.003 * d * uWaterScale)) {
            float a = lastF, b = f;
            for (int j = 0; j < 6; j++) {
                float m = 0.5 * (a + b);
                float km = mix(k0, k1, m);
                vec2 sm = s0 + ds * m;
                if (-mix(z0, z1, m) / km > getLinearScreenDepth(sm)) { b = m; sp = sm; } else a = m;
            }
            hitUv = sp;
            hit = 1.0;
            break;
        }
        lastF = f;
        f += stride;
    }
    if (hit < 0.5) discard;
    // fade toward the screen's edges, where the reflected thing leaves the picture
    vec2 e = smoothstep(0.0, 0.08, hitUv) * smoothstep(0.0, 0.08, 1.0 - hitUv);
    // a little more than Fresnel alone: against the lake's dark body even a steep look shows the mirror
    float a = min(1.0, F * 1.3 + 0.1) * e.x * e.y * water * uStrength;
    vec3 col = texture2D(uSceneColorMap, hitUv).rgb;
    gl_FragColor = vec4(col, a);
}
`;

export class WaterReflections {
  /**
   * @param {object} app
   * @param {object} parent   the world root
   * @param {number} level    the lake's height (the root's metres)
   * @param {{ near: { texture }, far: { texture } }} masks  waterMask.js
   * @param {{ steps?: number }} [opts]
   */
  constructor(app, parent, level, masks, { steps = 160 } = {}) {
    this.app = app;
    this.masks = masks;
    const m = new pc.ShaderMaterial({
      uniqueName: 'extra300-water-ssr',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: VS,
      fragmentGLSL: FS,
    });
    m.blendType = pc.BLEND_NORMAL;
    m.depthWrite = false;
    m.depthTest = false;
    m.cull = pc.CULLFACE_NONE;
    m.setParameter('uWaterNear', masks.near.texture);
    m.setParameter('uWaterFar', masks.far.texture);
    m.setParameter('uSteps', steps);
    m.setParameter('uStrength', 1);
    m.update();
    this.material = m;
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(new Float32Array([-FAR, level, -FAR, FAR, level, -FAR, FAR, level, FAR, -FAR, level, FAR]));
    mesh.setIndices(new Uint16Array([0, 2, 1, 0, 3, 2]));
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    this.entity = new pc.Entity('WaterReflections');
    this.entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, m)], castShadows: false, receiveShadows: false });
    parent.addChild(this.entity);
    this._mesh = mesh;
    this._time = 0;
    this._camera = null;
    this._frame = null;
  }

  /** The camera must copy the scene's colour and depth for us: through its CameraFrame if it has one. */
  _request(cam) {
    if (this._camera === cam) return;
    this._release();
    this._camera = cam;
    const frame = this.app.customTravelCenter?.cameraFrame;
    if (frame?.rendering) {
      this._frame = { frame, color: frame.rendering.sceneColorMap, depth: frame.rendering.sceneDepthMap };
      frame.rendering.sceneColorMap = true;
      frame.rendering.sceneDepthMap = true;
      frame.update?.();
    } else if (cam?.camera) {
      cam.camera.requestSceneColorMap(true);
      cam.camera.requestSceneDepthMap(true);
    }
  }

  _release() {
    if (this._frame) {
      const { frame, color, depth } = this._frame;
      frame.rendering.sceneColorMap = color;
      frame.rendering.sceneDepthMap = depth;
      frame.update?.();
      this._frame = null;
    } else if (this._camera?.camera) {
      this._camera.camera.requestSceneColorMap(false);
      this._camera.camera.requestSceneDepthMap(false);
    }
    this._camera = null;
  }

  set visible(v) {
    this.entity.enabled = v;
    if (!v) this._release();
  }

  /**
   * @param {number} dt
   * @param {{ nearInv: number[], farInv: number[], scale: number }} xf  world → mask transforms, metres per unit
   */
  update(dt, xf) {
    if (!this.entity.enabled) return;
    const cam = ArrivalSpace.getCamera?.();
    if (!cam) return;
    this._request(cam);
    this._time += dt;
    const m = this.material;
    m.setParameter('uWaterNearInv', xf.nearInv);
    m.setParameter('uWaterFarInv', xf.farInv);
    m.setParameter('uWaterScale', xf.scale);
    m.setParameter('uWaterTime', this._time % 3600);
  }

  destroy() {
    this._release();
    this.entity.destroy();
    this._mesh.destroy();
    this.material.destroy();
  }
}
