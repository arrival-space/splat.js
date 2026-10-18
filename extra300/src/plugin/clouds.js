// clouds.js — a layer of volumetric clouds, after Guerrilla's Nubis (Schneider: "The Real-time
// Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015; "Nubis: Authoring Real-Time
// Volumetric Cloudscapes with the Decima Engine", 2017):
//
//   shape    a shell round the planet between the cloud base and tops; a weather map says where the
//            clouds are (coverage) and what kind (stratus … towering cumulus, each with its height
//            profile); a Perlin-Worley 3D texture gives them their lumps and a Worley one erodes
//            their edges into wisps (render/cloudNoise.js), all drifting with the wind
//   light    Beer's law toward the sun (six samples, growing), multiple scattering as three octaves
//            of ever weaker, wider, more transmitted light (Wrenninge), a dual-lobe Henyey-Greenstein
//            phase (the silver lining toward the sun), ambient sky from above and ground from below,
//            energy-conserving integration (Hillaire), the far ones fading into the haze
//   speed    marched at a fraction of the screen's resolution into an offscreen target (its own
//            camera, before the main one), jittered per pixel and frame; the march stops where the
//            light is used up. The composite, in the main camera, scales it up and puts the clouds
//            behind what stands in front of them (the scene's depth against the clouds' own)
//
// GLSL (WebGL2) and WGSL (WebGPU) side by side. Distances in metres; heights above sea level.

import { detailNoise, shapeSlices, weatherMap } from '../render/cloudNoise.js';
import { releaseSceneMaps, requestSceneMaps } from './sceneMaps.js';

const SHAPE_N = 64;
const SHADOW_PX = 256;       // the clouds' shadow map: texels across
const SHADOW_SIZE = 24000;   // m across

// ── the march ───────────────────────────────────────────────────────────────
const MARCH_VS_GLSL = /* glsl */ `
attribute vec3 vertex_position;
varying vec2 vNdc;
void main(void) {
    vNdc = vertex_position.xy;
    gl_Position = vec4(vertex_position.xy, 0.5, 1.0);
}
`;
const MARCH_VS_WGSL = /* wgsl */ `
attribute vertex_position: vec3f;
varying vNdc: vec2f;
@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.vNdc = input.vertex_position.xy;
    output.position = vec4f(input.vertex_position.xy, 0.5, 1.0);
    return output;
}
`;

const MARCH_FS_GLSL = /* glsl */ `
#define R_EARTH 6371000.0
uniform mat4 uInvViewProj;     // clip -> world
uniform vec3 uCamWorld;        // the camera, world
uniform vec3 uCamPos;          // the camera, metres: x/z on the ground, y above sea level
uniform vec3 uSunDir;          // toward the sun
uniform vec3 uSunColor;        // its light (linear)
uniform vec3 uAmbTop;          // the sky's light from above
uniform vec3 uAmbBottom;       // the ground's from below
uniform vec3 uHaze;            // the horizon's haze
uniform vec4 uLayer;           // base, top (m above sea level), coverage 0..1, extinction (1/m)
uniform vec4 uWind;            // drift (m, x and z), time (s), -
uniform vec4 uMarch;           // steps, the farthest (m), frame, light samples
uniform highp sampler3D uShape;
uniform highp sampler3D uDetail;
uniform sampler2D uWeather;
varying vec2 vNdc;

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

// each kind's height profile in the layer: stratus a low flat band, cumulus rounded to its top
float profile(float hf, float kind) {
    float top = mix(0.3, 1.0, kind);
    return smoothstep(0.0, 0.07, hf) * (1.0 - smoothstep(top * 0.55, top, hf));
}

float density(vec3 p, float hf, bool detail) {
    if (hf <= 0.0 || hf >= 1.0) return 0.0;
    vec4 wm = textureLod(uWeather, (p.xz + uWind.xy) / 36000.0, 0.0);
    float cov = clamp(uLayer.z + (wm.r - 0.5) * 0.9, 0.0, 1.0);
    float kind = clamp(wm.g * 1.4 - 0.2 + uLayer.z * 0.25, 0.0, 1.0);
    float prof = profile(hf, kind);
    if (cov < 0.01 || prof <= 0.0) return 0.0;
    vec3 q = (p + vec3(uWind.x, 0.0, uWind.y)) / 4200.0;
    vec4 n = textureLod(uShape, q, 0.0);
    float lowFbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    float base = remap(n.r, lowFbm - 1.0, 1.0, 0.0, 1.0) * prof;
    float d = clamp(remap(base, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
    if (detail && d > 0.0) {
        vec3 dn = textureLod(uDetail, q * 7.0 + vec3(0.0, uWind.z * 0.003, 0.0), 0.0).rgb;
        float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
        float m = mix(df, 1.0 - df, clamp(hf * 5.0, 0.0, 1.0));
        d = clamp(remap(d, m * 0.4, 1.0, 0.0, 1.0), 0.0, 1.0);
    }
    return d * uLayer.w;
}

vec2 sphere(vec3 ro, vec3 rd, vec3 c, float r) {
    vec3 oc = ro - c;
    float b = dot(oc, rd), h = b * b - dot(oc, oc) + r * r;
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
}

void main(void) {
    vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 rd = normalize(w.xyz / w.w - uCamWorld);
    vec3 ro = uCamPos;
    vec3 C = vec3(ro.x, -R_EARTH, ro.z);
    float base = uLayer.x, top = uLayer.y;
    vec2 ib = sphere(ro, rd, C, R_EARTH + base), it = sphere(ro, rd, C, R_EARTH + top);
    float camH = length(ro - C) - R_EARTH;
    float t0 = 0.0, t1 = -1.0;
    if (camH < base) { t0 = ib.y; t1 = it.y; }
    else if (camH < top) { t0 = 0.0; t1 = ib.x > 0.0 ? ib.x : it.y; }
    else if (it.x > 0.0) { t0 = it.x; t1 = ib.x > 0.0 ? ib.x : it.y; }
    t1 = min(t1, uMarch.y);
    vec3 col = vec3(0.0);
    float T = 1.0, dsum = 0.0, wsum = 0.0;
    if (t1 > t0 && t0 >= 0.0) {
        float dt = max((t1 - t0) / uMarch.x, 30.0);
        float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uMarch.z * 0.618034);
        float t = t0 + dt * jitter;
        float cosT = dot(rd, uSunDir);
        for (int i = 0; i < 160; i++) {
            if (float(i) >= uMarch.x * 1.6 || t > t1 || T < 0.02) break;
            vec3 p = ro + rd * t;
            float hf = (length(p - C) - R_EARTH - base) / (top - base);
            float d = density(p, hf, true);
            if (d > 0.0) {
                // toward the sun: optical depth through six growing steps
                float od = 0.0, lt = 0.0, seg = 35.0;
                for (int j = 0; j < 6; j++) {
                    if (float(j) >= uMarch.w) break;
                    vec3 lp = p + uSunDir * (lt + seg * 0.5);
                    od += density(lp, (length(lp - C) - R_EARTH - base) / (top - base), false) * seg;
                    lt += seg;
                    seg *= 2.0;
                }
                // multiple scattering: octaves of weaker, more transmitted, less forward light
                float sun = 0.0, a = 1.0, b = 1.0, c = 1.0;
                for (int o = 0; o < 3; o++) {
                    sun += a * mix(hg(cosT, 0.8 * c), hg(cosT, -0.25 * c), 0.25) * exp(-od * b);
                    a *= 0.5; b *= 0.35; c *= 0.5;
                }
                // powder: thin wisps and edges catch less light than the cloud's depths scatter out
                float powder = 1.0 - exp(-2.5 * d / uLayer.w);
                powder = mix(powder, 1.0, 0.5 + 0.5 * cosT);
                vec3 amb = mix(uAmbBottom, uAmbTop, clamp(hf, 0.0, 1.0));
                vec3 S = uSunColor * sun * 12.566371 * 2.2 * powder + amb * 0.65;
                float Td = exp(-d * dt);
                col += T * S * (1.0 - Td);
                dsum += t * T * (1.0 - Td);
                wsum += T * (1.0 - Td);
                T *= Td;
                t += dt;
            } else {
                t += dt * 1.6;      // empty air: stride on
            }
        }
    }
    float depth = wsum > 0.0 ? dsum / wsum : uMarch.y;
    // the far clouds fade into the haze, and out at the farthest
    float fog = exp(-depth / 30000.0);
    col = mix(uHaze * (1.0 - T), col, fog);
    float edge = 1.0 - smoothstep(0.7 * uMarch.y, uMarch.y, depth);
    col *= edge;
    T = mix(1.0, T, edge);
    pcFragColor0 = vec4(col, T);
    pcFragColor1 = vec4(depth, 0.0, 0.0, 1.0);
}
`;

const MARCH_FS_WGSL = /* wgsl */ `
const R_EARTH: f32 = 6371000.0;
uniform uInvViewProj: mat4x4f;
uniform uCamWorld: vec3f;
uniform uCamPos: vec3f;
uniform uSunDir: vec3f;
uniform uSunColor: vec3f;
uniform uAmbTop: vec3f;
uniform uAmbBottom: vec3f;
uniform uHaze: vec3f;
uniform uLayer: vec4f;
uniform uWind: vec4f;
uniform uMarch: vec4f;
var uShape: texture_3d<f32>;
var uShapeSampler: sampler;
var uDetail: texture_3d<f32>;
var uDetailSampler: sampler;
var uWeather: texture_2d<f32>;
var uWeatherSampler: sampler;
varying vNdc: vec2f;

fn remap(v: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (v - a) / (b - a) * (d - c); }
fn hg(c: f32, g: f32) -> f32 { let g2 = g * g; return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

fn profile(hf: f32, kind: f32) -> f32 {
    let top = mix(0.3, 1.0, kind);
    return smoothstep(0.0, 0.07, hf) * (1.0 - smoothstep(top * 0.55, top, hf));
}

fn density(p: vec3f, hf: f32, detail: bool) -> f32 {
    if (hf <= 0.0 || hf >= 1.0) { return 0.0; }
    let wm = textureSampleLevel(uWeather, uWeatherSampler, (p.xz + uniform.uWind.xy) / 36000.0, 0.0);
    let cov = clamp(uniform.uLayer.z + (wm.r - 0.5) * 0.9, 0.0, 1.0);
    let kind = clamp(wm.g * 1.4 - 0.2 + uniform.uLayer.z * 0.25, 0.0, 1.0);
    let prof = profile(hf, kind);
    if (cov < 0.01 || prof <= 0.0) { return 0.0; }
    let q = (p + vec3f(uniform.uWind.x, 0.0, uniform.uWind.y)) / 4200.0;
    let n = textureSampleLevel(uShape, uShapeSampler, q, 0.0);
    let lowFbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
    let base = remap(n.r, lowFbm - 1.0, 1.0, 0.0, 1.0) * prof;
    var d = clamp(remap(base, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
    if (detail && d > 0.0) {
        let dn = textureSampleLevel(uDetail, uDetailSampler, q * 7.0 + vec3f(0.0, uniform.uWind.z * 0.003, 0.0), 0.0).rgb;
        let df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
        let m = mix(df, 1.0 - df, clamp(hf * 5.0, 0.0, 1.0));
        d = clamp(remap(d, m * 0.4, 1.0, 0.0, 1.0), 0.0, 1.0);
    }
    return d * uniform.uLayer.w;
}

fn sphere(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> vec2f {
    let oc = ro - c;
    let b = dot(oc, rd);
    var h = b * b - dot(oc, oc) + r * r;
    if (h < 0.0) { return vec2f(-1.0); }
    h = sqrt(h);
    return vec2f(-b - h, -b + h);
}

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let w = uniform.uInvViewProj * vec4f(input.vNdc, 1.0, 1.0);
    let rd = normalize(w.xyz / w.w - uniform.uCamWorld);
    let ro = uniform.uCamPos;
    let C = vec3f(ro.x, -R_EARTH, ro.z);
    let base = uniform.uLayer.x;
    let top = uniform.uLayer.y;
    let ib = sphere(ro, rd, C, R_EARTH + base);
    let it = sphere(ro, rd, C, R_EARTH + top);
    let camH = length(ro - C) - R_EARTH;
    var t0 = 0.0;
    var t1 = -1.0;
    if (camH < base) { t0 = ib.y; t1 = it.y; }
    else if (camH < top) { t0 = 0.0; t1 = select(it.y, ib.x, ib.x > 0.0); }
    else if (it.x > 0.0) { t0 = it.x; t1 = select(it.y, ib.x, ib.x > 0.0); }
    t1 = min(t1, uniform.uMarch.y);
    var col = vec3f(0.0);
    var T = 1.0;
    var dsum = 0.0;
    var wsum = 0.0;
    if (t1 > t0 && t0 >= 0.0) {
        let dt = max((t1 - t0) / uniform.uMarch.x, 30.0);
        let jitter = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))) + uniform.uMarch.z * 0.618034);
        var t = t0 + dt * jitter;
        let cosT = dot(rd, uniform.uSunDir);
        for (var i = 0; i < 160; i++) {
            if (f32(i) >= uniform.uMarch.x * 1.6 || t > t1 || T < 0.02) { break; }
            let p = ro + rd * t;
            let hf = (length(p - C) - R_EARTH - base) / (top - base);
            let d = density(p, hf, true);
            if (d > 0.0) {
                var od = 0.0;
                var lt = 0.0;
                var seg = 35.0;
                for (var j = 0; j < 6; j++) {
                    if (f32(j) >= uniform.uMarch.w) { break; }
                    let lp = p + uniform.uSunDir * (lt + seg * 0.5);
                    od += density(lp, (length(lp - C) - R_EARTH - base) / (top - base), false) * seg;
                    lt += seg;
                    seg *= 2.0;
                }
                var sun = 0.0;
                var a = 1.0;
                var b = 1.0;
                var c = 1.0;
                for (var o = 0; o < 3; o++) {
                    sun += a * mix(hg(cosT, 0.8 * c), hg(cosT, -0.25 * c), 0.25) * exp(-od * b);
                    a *= 0.5; b *= 0.35; c *= 0.5;
                }
                var powder = 1.0 - exp(-2.5 * d / uniform.uLayer.w);
                powder = mix(powder, 1.0, 0.5 + 0.5 * cosT);
                let amb = mix(uniform.uAmbBottom, uniform.uAmbTop, clamp(hf, 0.0, 1.0));
                let S = uniform.uSunColor * sun * 12.566371 * 2.2 * powder + amb * 0.65;
                let Td = exp(-d * dt);
                col += T * S * (1.0 - Td);
                dsum += t * T * (1.0 - Td);
                wsum += T * (1.0 - Td);
                T *= Td;
                t += dt;
            } else {
                t += dt * 1.6;
            }
        }
    }
    let depth = select(uniform.uMarch.y, dsum / max(wsum, 1e-6), wsum > 0.0);
    let fog = exp(-depth / 30000.0);
    col = mix(uniform.uHaze * (1.0 - T), col, fog);
    let edge = 1.0 - smoothstep(0.7 * uniform.uMarch.y, uniform.uMarch.y, depth);
    col *= edge;
    T = mix(1.0, T, edge);
    output.color = vec4f(col, T);
    output.color1 = vec4f(depth, 0.0, 0.0, 1.0);
    return output;
}
`;

// ── the clouds' shadow on the ground: a map round the camera, transmittance along the sun ──
// (the march's density, with the uniforms it reads; texel (i, j) is ground x, z: uv from the pixel,
// which both backends index the same way)
const SHADOW_FS_GLSL = MARCH_FS_GLSL.slice(0, MARCH_FS_GLSL.indexOf('vec2 sphere(')) + /* glsl */ `
uniform vec4 uShadowArea;      // centre x, z (m), size (m), the ground's height (m above sea level)
uniform vec4 uShadowPx;        // the map's size in texels
void main(void) {
    vec2 uv = gl_FragCoord.xy / uShadowPx.x;
    vec3 G = vec3(uShadowArea.x + (uv.x - 0.5) * uShadowArea.z, uShadowArea.w, uShadowArea.y + (uv.y - 0.5) * uShadowArea.z);
    vec3 sd = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.15), uSunDir.z));
    float base = uLayer.x, top = uLayer.y;
    vec3 P0 = G + sd * ((base - G.y) / sd.y);
    float seg = (top - base) / sd.y / 8.0;
    float od = 0.0;
    for (int i = 0; i < 8; i++) {
        vec3 p = P0 + sd * (seg * (float(i) + 0.5));
        od += density(p, (p.y - base) / (top - base), false) * seg;
    }
    // (light scattered through the cloud reaches its shadow too: a thinner shadow than the cloud is opaque)
    float T = exp(-od * 0.25);
    gl_FragColor = vec4(T, T, T, 1.0);
}
`;
const SHADOW_FS_WGSL = MARCH_FS_WGSL.slice(0, MARCH_FS_WGSL.indexOf('fn sphere(')) + /* wgsl */ `
uniform uShadowArea: vec4f;
uniform uShadowPx: vec4f;
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = pcPosition.xy / uniform.uShadowPx.x;
    let A = uniform.uShadowArea;
    let G = vec3f(A.x + (uv.x - 0.5) * A.z, A.w, A.y + (uv.y - 0.5) * A.z);
    let sd = normalize(vec3f(uniform.uSunDir.x, max(uniform.uSunDir.y, 0.15), uniform.uSunDir.z));
    let base = uniform.uLayer.x;
    let top = uniform.uLayer.y;
    let P0 = G + sd * ((base - G.y) / sd.y);
    let seg = (top - base) / sd.y / 8.0;
    var od = 0.0;
    for (var i = 0; i < 8; i++) {
        let p = P0 + sd * (seg * (f32(i) + 0.5));
        od += density(p, (p.y - base) / (top - base), false) * seg;
    }
    let T = exp(-od * 0.25);
    output.color = vec4f(T, T, T, 1.0);
    return output;
}
`;

// ── the composite, in the main camera ────────────────────────────────────────
// The clouds over the scene, behind what stands in front of them; and their shadows on whatever was
// drawn (Google's unlit tiles as much as our own ground), from their map. The shadow rides on the premultiplied
// blend: out = clouds + scene × (1 − alpha) with alpha = 1 − (1 − clouds' alpha) × shade.
const COMP_VS_GLSL = MARCH_VS_GLSL;
const COMP_VS_WGSL = MARCH_VS_WGSL;

const COMP_FS_GLSL = /* glsl */ `
#include "screenDepthPS"
uniform sampler2D uCloudColor;
uniform sampler2D uCloudDepth;
uniform sampler2D uCloudShadow;
uniform mat4 uInvViewProj;
uniform vec3 uCamWorld;
uniform vec3 uCamFwd;
uniform vec4 uComp;            // metres per world unit, tonemap in-shader (1) or linear (0), exposure, clouds on
uniform vec4 uShadowArea;      // the clouds' shadow map: centre x, z (m), size (m), strength (0: none)
uniform vec3 uRootWorld;       // the metre frame's origin, world
varying vec2 vNdc;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(void) {
    vec2 uv = gl_FragCoord.xy * uScreenSize.zw;
    float z = getLinearScreenDepth(uv);
    vec4 w = uInvViewProj * vec4(vNdc, 1.0, 1.0);
    vec3 rd = normalize(w.xyz / w.w - uCamWorld);
    float along = z / max(dot(rd, uCamFwd), 1e-3);           // world units to the surface
    bool sky = along > camera_params.y * 0.85;               // (ours a dome at 0.9 of the far plane)
    // the shade on the surface: the clouds' shadow
    float shade = 1.0;
    if (!sky) {
        vec3 P = uCamWorld + rd * along;
        if (uShadowArea.w > 0.0) {
            vec2 m = ((P.xz - uRootWorld.xz) * uComp.x - uShadowArea.xy) / uShadowArea.z + 0.5;
            float edge = smoothstep(0.0, 0.08, min(min(m.x, m.y), min(1.0 - m.x, 1.0 - m.y)));
            shade *= mix(1.0, texture2D(uCloudShadow, m).r, uShadowArea.w * edge);
        }
    }
    // the clouds, unless what's in front of them hides them (the sky, ours a dome near the far plane, doesn't)
    vec4 c = uComp.w > 0.5 ? texture2D(uCloudColor, uv) : vec4(0.0, 0.0, 0.0, 1.0);
    float a = 0.0;
    vec3 col = vec3(0.0);
    if (c.a < 0.998) {
        float cd = texture2D(uCloudDepth, uv).r;
        float vis = sky ? 1.0 : smoothstep(cd * 0.85, cd * 1.05, along * uComp.x);
        a = (1.0 - c.a) * vis;
        vec3 u = c.rgb / max(1.0 - c.a, 1e-4) * uComp.z;
        if (uComp.y > 0.5) u = pow(aces(u), vec3(1.0 / 2.2));
        col = u * a;
    }
    float alpha = 1.0 - (1.0 - a) * shade;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
}
`;
const COMP_FS_WGSL = /* wgsl */ `
#include "screenDepthPS"
var uCloudColor: texture_2d<f32>;
var uCloudColorSampler: sampler;
var uCloudDepth: texture_2d<f32>;
var uCloudDepthSampler: sampler;
var uCloudShadow: texture_2d<f32>;
var uCloudShadowSampler: sampler;
uniform uInvViewProj: mat4x4f;
uniform uCamWorld: vec3f;
uniform uCamFwd: vec3f;
uniform uComp: vec4f;
uniform uShadowArea: vec4f;
uniform uRootWorld: vec3f;
varying vNdc: vec2f;

fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let uv = pcPosition.xy * uniform.uScreenSize.zw;
    let z = getLinearScreenDepth(uv);
    let w = uniform.uInvViewProj * vec4f(input.vNdc, 1.0, 1.0);
    let rd = normalize(w.xyz / w.w - uniform.uCamWorld);
    let along = z / max(dot(rd, uniform.uCamFwd), 1e-3);
    let sky = along > uniform.camera_params.y * 0.85;
    var shade = 1.0;
    if (!sky) {
        let P = uniform.uCamWorld + rd * along;
        if (uniform.uShadowArea.w > 0.0) {
            let m = ((P.xz - uniform.uRootWorld.xz) * uniform.uComp.x - uniform.uShadowArea.xy) / uniform.uShadowArea.z + 0.5;
            let edge = smoothstep(0.0, 0.08, min(min(m.x, m.y), min(1.0 - m.x, 1.0 - m.y)));
            shade *= mix(1.0, textureSampleLevel(uCloudShadow, uCloudShadowSampler, m, 0.0).r, uniform.uShadowArea.w * edge);
        }
    }
    var c = vec4f(0.0, 0.0, 0.0, 1.0);
    if (uniform.uComp.w > 0.5) { c = textureSampleLevel(uCloudColor, uCloudColorSampler, uv, 0.0); }
    var a = 0.0;
    var col = vec3f(0.0);
    if (c.a < 0.998) {
        let cd = textureSampleLevel(uCloudDepth, uCloudDepthSampler, uv, 0.0).r;
        let vis = select(smoothstep(cd * 0.85, cd * 1.05, along * uniform.uComp.x), 1.0, sky);
        a = (1.0 - c.a) * vis;
        var u = c.rgb / max(1.0 - c.a, 1e-4) * uniform.uComp.z;
        if (uniform.uComp.y > 0.5) { u = pow(aces(u), vec3f(1.0 / 2.2)); }
        col = u * a;
    }
    let alpha = 1.0 - (1.0 - a) * shade;
    if (alpha < 0.002) { discard; }
    output.color = vec4f(col, alpha);
    return output;
}
`;

export const CLOUD_SHADERS = { MARCH_VS_GLSL, MARCH_FS_GLSL, MARCH_VS_WGSL, MARCH_FS_WGSL, SHADOW_FS_GLSL, SHADOW_FS_WGSL, COMP_VS_GLSL, COMP_FS_GLSL, COMP_VS_WGSL, COMP_FS_WGSL };

// ── what the sky looks like at this sun ──────────────────────────────────────
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function skyLight(sunUp) {
  const day = smooth(-0.05, 0.3, sunUp);
  const warm = 1 - smooth(0.02, 0.35, sunUp);
  const sun = mix3([1.0, 0.97, 0.92], [1.0, 0.55, 0.28], warm).map((v) => v * day * 1.15);
  const top = mix3([0.05, 0.06, 0.1], [0.36, 0.48, 0.7], day);
  const bottom = mix3([0.03, 0.03, 0.04], [0.15, 0.16, 0.18], day);
  const haze = mix3([0.08, 0.09, 0.12], mix3([0.72, 0.8, 0.9], [0.9, 0.62, 0.45], warm * 0.7), day);
  return { sun, top, bottom, haze };
}

/** A clouds preset: coverage and how deep the layer is (m). */
export const CLOUD_PRESETS = {
  Clear: null,
  Few: { coverage: 0.26, depth: 1400 },
  Scattered: { coverage: 0.4, depth: 1700 },
  Broken: { coverage: 0.58, depth: 2000 },
  Overcast: { coverage: 0.9, depth: 900 },
};

export class CloudLayer {
  /**
   * @param {object} app
   * @param {{ scale?: number, steps?: number, lightSteps?: number }} [opts]  resolution (of the screen's), march steps
   */
  constructor(app, { scale = 0.4, steps = 64, lightSteps = 5 } = {}) {
    this.app = app;
    this.scale = scale;
    this.steps = steps;
    this.lightSteps = lightSteps;
    this.enabled = false;
    this.ready = false;
    this._frame = 0;
    this._wind = [0, 0];
    this._time = 0;
    const dev = app.graphicsDevice;
    // noise: the shape volume made a few slices per frame, the rest at once
    this._shapeData = new Uint8Array(SHAPE_N ** 3 * 4);
    this._shapeZ = 0;
    const det = detailNoise();
    const vol = (n, data) => new pc.Texture(dev, {
      width: n, height: n, depth: n, volume: true, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, addressW: pc.ADDRESS_REPEAT, levels: [data],
    });
    this.detailTex = vol(det.size, det.data);
    const wm = weatherMap();
    this.weatherTex = new pc.Texture(dev, {
      width: wm.size, height: wm.size, format: pc.PIXELFORMAT_RGBA8, mipmaps: true,
      addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, levels: [wm.data],
    });
    this.shapeTex = null;

    // the march: its own layer, camera and target
    this.layer = new pc.Layer({ name: 'Extra300Clouds' });
    app.scene.layers.push(this.layer);
    this.marchMat = new pc.ShaderMaterial({
      uniqueName: 'extra300-clouds-march',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: MARCH_VS_GLSL, fragmentGLSL: MARCH_FS_GLSL,
      vertexWGSL: MARCH_VS_WGSL, fragmentWGSL: MARCH_FS_WGSL,
      fragmentOutputTypes: ['vec4', 'vec4'],
    });
    this.marchMat.depthTest = false;
    this.marchMat.depthWrite = false;
    this.marchMat.cull = pc.CULLFACE_NONE;
    this.marchMat.setParameter('uDetail', this.detailTex);
    this.marchMat.setParameter('uWeather', this.weatherTex);
    this.marchMat.update();
    this.marchEntity = this._triangle('CloudMarch', this.marchMat, [this.layer.id]);
    app.root.addChild(this.marchEntity);
    this.camEntity = new pc.Entity('CloudCamera');
    this.camEntity.addComponent('camera', {
      layers: [this.layer.id], priority: -50, clearColor: new pc.Color(0, 0, 0, 1),
      clearColorBuffer: true, clearDepthBuffer: false, clearStencilBuffer: false, frustumCulling: false,
    });
    app.root.addChild(this.camEntity);

    // the clouds' shadow map: the same, into a small square round the camera
    this.shadowLayer = new pc.Layer({ name: 'Extra300CloudShadow' });
    app.scene.layers.push(this.shadowLayer);
    this.shadowMat = new pc.ShaderMaterial({
      uniqueName: 'extra300-clouds-shadow',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: MARCH_VS_GLSL, fragmentGLSL: SHADOW_FS_GLSL,
      vertexWGSL: MARCH_VS_WGSL, fragmentWGSL: SHADOW_FS_WGSL,
    });
    this.shadowMat.depthTest = false;
    this.shadowMat.depthWrite = false;
    this.shadowMat.cull = pc.CULLFACE_NONE;
    this.shadowMat.setParameter('uDetail', this.detailTex);
    this.shadowMat.setParameter('uWeather', this.weatherTex);
    this.shadowMat.update();
    this.shadowEntity = this._triangle('CloudShadow', this.shadowMat, [this.shadowLayer.id]);
    app.root.addChild(this.shadowEntity);
    this.shadowTex = new pc.Texture(dev, {
      name: 'extra300-cloud-shadow', width: SHADOW_PX, height: SHADOW_PX, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    this.shadowRt = new pc.RenderTarget({ colorBuffer: this.shadowTex, depth: false });
    this.shadowCam = new pc.Entity('CloudShadowCamera');
    this.shadowCam.addComponent('camera', {
      layers: [this.shadowLayer.id], priority: -55, clearColor: new pc.Color(1, 1, 1, 1), renderTarget: this.shadowRt,
      clearColorBuffer: true, clearDepthBuffer: false, clearStencilBuffer: false, frustumCulling: false,
    });
    app.root.addChild(this.shadowCam);
    // a stand-in for the composite's shadow map when there are no clouds
    this._white = new pc.Texture(dev, { width: 1, height: 1, format: pc.PIXELFORMAT_RGBA8, mipmaps: false, levels: [new Uint8Array([255, 255, 255, 255])] });

    // the composite: drawn with the transparent geometry, after the sky, before everything nearer
    this.compMat = new pc.ShaderMaterial({
      uniqueName: 'extra300-clouds-composite',
      attributes: { vertex_position: pc.SEMANTIC_POSITION },
      vertexGLSL: COMP_VS_GLSL, fragmentGLSL: COMP_FS_GLSL,
      vertexWGSL: COMP_VS_WGSL, fragmentWGSL: COMP_FS_WGSL,
    });
    this.compMat.blendType = pc.BLEND_PREMULTIPLIED;
    this.compMat.depthTest = false;
    this.compMat.depthWrite = false;
    this.compMat.cull = pc.CULLFACE_NONE;
    this.compMat.update();
    this.compEntity = this._triangle('CloudComposite', this.compMat, [pc.LAYERID_WORLD]);
    this.compEntity.render.meshInstances[0].calculateSortDistance = () => 1e5;
    app.root.addChild(this.compEntity);
    this._target(1, 1);
    this.compMat.setParameter('uCloudShadow', this._white);
    this._setEnabled(false);
  }

  /** A full-screen triangle (its vertex shader ignores the transforms), never culled. */
  _triangle(name, mat, layers) {
    const mesh = new pc.Mesh(this.app.graphicsDevice);
    mesh.setPositions(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]));
    mesh.setIndices(new Uint16Array([0, 1, 2]));
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    const mi = new pc.MeshInstance(mesh, mat);
    mi.cull = false;
    const e = new pc.Entity(name);
    e.addComponent('render', { meshInstances: [mi], layers, castShadows: false, receiveShadows: false });
    this._meshes ??= [];
    this._meshes.push(mesh);
    return e;
  }

  /** The offscreen target, at a fraction of the screen. */
  _target(w, h) {
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    this.rt?.destroy();
    this.colorTex?.destroy();
    this.depthTex?.destroy();
    const dev = this.app.graphicsDevice;
    const fmt = dev.textureHalfFloatRenderable ? pc.PIXELFORMAT_RGBA16F : pc.PIXELFORMAT_RGBA8;
    const tex = (name) => new pc.Texture(dev, {
      name, width: w, height: h, format: fmt, mipmaps: false,
      minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    this.colorTex = tex('extra300-clouds-color');
    this.depthTex = tex('extra300-clouds-depth');
    this.rt = new pc.RenderTarget({ colorBuffers: [this.colorTex, this.depthTex], depth: false });
    this.camEntity.camera.renderTarget = this.rt;
    this.compMat.setParameter('uCloudColor', this.colorTex);
    this.compMat.setParameter('uCloudDepth', this.depthTex);
  }

  _setEnabled(on) {
    const show = on && this.ready;
    this.marchEntity.enabled = show;
    this.camEntity.enabled = show;
    this.shadowEntity.enabled = show;
    this.shadowCam.enabled = show;
    this._clouds = show;
  }

  /** Clouds on (a preset from CLOUD_PRESETS, base in m above sea level) or off (null). */
  set(preset, baseMsl) {
    this.preset = preset;
    this.base = baseMsl;
    this.enabled = !!preset;
    this._setEnabled(this.enabled);
  }

  /**
   * Every frame, after the main camera has been placed.
   * @param {number} dt
   * @param {object} o  { cam: the main camera entity, root: the world root entity, ws: world units per metre,
   *                      datumMsl: the root's height above sea level, sunDir: [x, y, z] toward the sun,
   *                      wind: [east, north] m/s, hdr: whether a later pass tonemaps }
   */
  update(dt, o) {
    // the shape volume, eight slices a frame until it's done
    if (this.enabled && !this.ready) {
      const z1 = Math.min(SHAPE_N, this._shapeZ + 8);
      shapeSlices(this._shapeData, SHAPE_N, this._shapeZ, z1);
      this._shapeZ = z1;
      if (z1 >= SHAPE_N) {
        this.shapeTex = new pc.Texture(this.app.graphicsDevice, {
          width: SHAPE_N, height: SHAPE_N, depth: SHAPE_N, volume: true, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
          minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
          addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, addressW: pc.ADDRESS_REPEAT, levels: [this._shapeData],
        });
        this.marchMat.setParameter('uShape', this.shapeTex);
        this.shadowMat.setParameter('uShape', this.shapeTex);
        this.ready = true;
        this._setEnabled(true);
      }
    }
    const cam = o.cam;
    const comp = this._clouds;
    this.compEntity.enabled = comp;
    if (!comp || !cam?.camera) { releaseSceneMaps(this.app, this); return; }
    requestSceneMaps(this.app, this, cam, { depth: true });
    const dev = this.app.graphicsDevice;
    this._target(Math.max(16, Math.round(dev.width * this.scale)), Math.max(16, Math.round(dev.height * this.scale)));
    this._time += dt;
    this._frame = (this._frame + 1) % 64;
    // the drift: the clouds go with the wind (and the textures are sampled against it)
    this._wind[0] -= o.wind[0] * dt;
    this._wind[1] += o.wind[1] * dt;

    const camWorld = cam.getPosition();
    const p = this.preset || CLOUD_PRESETS.Scattered;
    const view = new pc.Mat4().copy(cam.getWorldTransform()).invert();
    const vp = new pc.Mat4().mul2(cam.camera.projectionMatrix, view);
    const inv = vp.invert();
    const rootPos = o.root.getPosition();
    const camM = [(camWorld.x - rootPos.x) / o.ws, (camWorld.y - rootPos.y) / o.ws + o.datumMsl, (camWorld.z - rootPos.z) / o.ws];
    const sky = skyLight(o.sunDir[1]);
    const m = this.marchMat;
    m.setParameter('uInvViewProj', inv.data);
    m.setParameter('uCamWorld', [camWorld.x, camWorld.y, camWorld.z]);
    m.setParameter('uCamPos', camM);
    m.setParameter('uSunDir', o.sunDir);
    m.setParameter('uSunColor', sky.sun);
    m.setParameter('uAmbTop', sky.top);
    m.setParameter('uAmbBottom', sky.bottom);
    m.setParameter('uHaze', sky.haze);
    m.setParameter('uLayer', [this.base, this.base + p.depth, p.coverage, 0.045]);
    m.setParameter('uWind', [this._wind[0], this._wind[1], this._time, 0]);
    m.setParameter('uMarch', [this.steps, 60000, this._frame, this.lightSteps]);
    // the shadow map: 24 km square, its centre on the camera, snapped to its texels so it doesn't swim
    const step = SHADOW_SIZE / SHADOW_PX;
    const sx = Math.round(camM[0] / step) * step, sz = Math.round(camM[2] / step) * step;
    const sm = this.shadowMat;
    sm.setParameter('uSunDir', o.sunDir);
    sm.setParameter('uLayer', [this.base, this.base + p.depth, p.coverage, 0.045]);
    sm.setParameter('uWind', [this._wind[0], this._wind[1], this._time, 0]);
    sm.setParameter('uShadowArea', [sx, sz, SHADOW_SIZE, o.datumMsl]);
    sm.setParameter('uShadowPx', [SHADOW_PX, 0, 0, 0]);

    const fwd = cam.forward;
    const c = this.compMat;
    c.setParameter('uInvViewProj', inv.data);
    c.setParameter('uCamWorld', [camWorld.x, camWorld.y, camWorld.z]);
    c.setParameter('uCamFwd', [fwd.x, fwd.y, fwd.z]);
    c.setParameter('uComp', [1 / o.ws, o.hdr ? 0 : 1, 1.0, this._clouds ? 1 : 0]);
    c.setParameter('uRootWorld', [rootPos.x, rootPos.y, rootPos.z]);
    // the clouds' shadow: weaker the lower the sun (the sky lights more of what the sun doesn't)
    const sunUp = smooth(0.02, 0.25, o.sunDir[1]);
    const sunShadow = sunUp * 0.32;
    c.setParameter('uCloudShadow', this._clouds ? this.shadowTex : this._white);
    c.setParameter('uShadowArea', [sx, sz, SHADOW_SIZE, this._clouds ? sunShadow : 0]);
  }

  destroy() {
    releaseSceneMaps(this.app, this);
    this.marchEntity.destroy();
    this.compEntity.destroy();
    this.camEntity.destroy();
    this.shadowEntity.destroy();
    this.shadowCam.destroy();
    this.app.scene.layers.remove(this.layer);
    this.app.scene.layers.remove(this.shadowLayer);
    this.rt?.destroy();
    this.shadowRt.destroy();
    for (const t of [this.colorTex, this.depthTex, this.shapeTex, this.detailTex, this.weatherTex, this.shadowTex, this._white]) t?.destroy();
    this.shadowMat.destroy();
    for (const mesh of this._meshes) mesh.destroy();
    this.marchMat.destroy();
    this.compMat.destroy();
  }
}
