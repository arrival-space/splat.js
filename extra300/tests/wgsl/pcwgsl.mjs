// pcwgsl.mjs — PlayCanvas-flavoured WGSL (what a ShaderMaterial or a shader chunk is written in) as
// plain WGSL, close enough to compile it with WebGPU alone: the engine's chunks it #includes, its
// preprocessor, `uniform x: T` (read as uniform.x), attribute / varying, textures and samplers,
// pcPosition, the multiple-target outputs. A check, not the engine's own processing.

/** A tiny preprocessor: #define / #ifdef / #ifndef / #else / #endif, defines a Set. */
export function preprocess(src, defines = new Set()) {
  const out = [], stack = [];
  const on = () => stack.every((s) => s);
  for (const line of src.split('\n')) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+(\w+)/))) stack.push(defines.has(m[1]));
    else if ((m = t.match(/^#ifndef\s+(\w+)/))) stack.push(!defines.has(m[1]));
    else if (/^#else/.test(t)) stack[stack.length - 1] = !stack[stack.length - 1];
    else if (/^#endif/.test(t)) stack.pop();
    else if ((m = t.match(/^#define\s+(\w+)/))) { if (on()) defines.add(m[1]); }
    else if (on()) out.push(line);
  }
  return out.join('\n');
}

/**
 * @param {string} code   the shader (vertex or fragment)
 * @param {'vertex'|'fragment'} stage
 * @param {(name: string) => string} chunk  an engine chunk's WGSL source by name
 * @param {number} outputs  colour targets (fragment)
 */
export function toPlainWgsl(code, stage, chunk, outputs = 1) {
  let src = code.replace(/#include\s+"(\w+)"/g, (_, n) => chunk(n));
  src = preprocess(src, new Set(stage === 'vertex' ? ['VERTEXSHADER'] : []));
  const uniforms = [], attributes = [], varyings = [], bindings = [];
  src = src.replace(/^\s*uniform\s+(\w+)\s*:\s*([^;]+);/gm, (_, n, t) => { uniforms.push(`${n}: ${t.trim()}`); return ''; });
  src = src.replace(/^\s*attribute\s+(\w+)\s*:\s*([^;]+);/gm, (_, n, t) => { attributes.push([n, t.trim()]); return ''; });
  src = src.replace(/^\s*varying\s+(\w+)\s*:\s*([^;]+);/gm, (_, n, t) => { varyings.push([n, t.trim()]); return ''; });
  src = src.replace(/^\s*var\s+(\w+)\s*:\s*((?:texture_\w+(?:<[^>]+>)?)|sampler(?:_comparison)?)\s*;/gm, (_, n, t) => { bindings.push(`@group(1) @binding(${bindings.length}) var ${n}: ${t.replace('<uff>', '<f32>')};`); return ''; });
  src = src.replace(/\buniform\./g, 'ub.');
  const head = [];
  if (uniforms.length) head.push(`struct UB { ${uniforms.join(', ')} };`, '@group(0) @binding(0) var<uniform> ub: UB;');
  head.push(...bindings);
  if (stage === 'vertex') {
    head.push(`struct VertexInput { ${attributes.map(([n, t], i) => `@location(${i}) ${n}: ${t}`).join(', ') || '@builtin(vertex_index) vi: u32'} };`);
    head.push(`struct VertexOutput { @builtin(position) position: vec4f${varyings.map(([n, t], i) => `, @location(${i}) ${n}: ${t}`).join('')} };`);
  } else {
    head.push(`struct FragmentInput { @builtin(position) position: vec4f${varyings.map(([n, t], i) => `, @location(${i}) ${n}: ${t}`).join('')} };`);
    head.push(`struct FragmentOutput { ${Array.from({ length: outputs }, (_, i) => `@location(${i}) color${i ? i : ''}: vec4f`).join(', ')} };`);
    head.push('var<private> pcPosition: vec4f;');
  }
  return `${head.join('\n')}\n${src}`;
}
