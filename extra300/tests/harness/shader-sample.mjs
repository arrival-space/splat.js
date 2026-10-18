// a trivial ShaderMaterial in both languages, for shader-check.html
export const desc = {
  uniqueName: 'sample',
  attributes: { vertex_position: pc.SEMANTIC_POSITION },
  vertexGLSL: `attribute vec3 vertex_position; varying vec2 vUv; void main(void) { vUv = vertex_position.xy * 0.5 + 0.5; gl_Position = vec4(vertex_position, 1.0); }`,
  fragmentGLSL: `uniform vec3 uTint; varying vec2 vUv; void main(void) { gl_FragColor = vec4(vUv * uTint.xy, uTint.z, 1.0); }`,
  vertexWGSL: `attribute vertex_position: vec3f; varying vUv: vec2f;
@vertex fn vertexMain(input: VertexInput) -> VertexOutput { var output: VertexOutput; output.vUv = input.vertex_position.xy * 0.5 + 0.5; output.position = vec4f(input.vertex_position, 1.0); return output; }`,
  fragmentWGSL: `uniform uTint: vec3f; varying vUv: vec2f;
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput { var output: FragmentOutput; output.color = vec4f(input.vUv * uniform.uTint.xy, uniform.uTint.z, 1.0); return output; }`,
};
export const setup = (m) => m.setParameter('uTint', [1, 0.5, 0.8]);
