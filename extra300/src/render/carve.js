// carve.js — the box Google's 3D tiles are cut away in (the Google 3D Tiles vibe's
// "googletiles:patch-region"): a box aligned with the runway, as a 4×4 matrix in
// render metres (x east, y up, z south), column-major like pc.Mat4.data.

/**
 * @param {{ centre: number[], dir: number[], halfAlong: number, halfAcross: number }} box  (n, e), from world.airfieldBox()
 * @param {number} y0  bottom, metres above the datum
 * @param {number} y1  top
 * @returns {{ local: number[], half: number[] }}  box → render-metres transform, half-extents (across, up, along)
 */
export function carveBox(box, y0, y1) {
  const [d0, d1] = box.dir;                   // along the runway, (n, e)
  const x = [d0, 0, d1];                      // across: (n, e) = (-d1, d0) → (e, up, -n)
  const z = [-d1, 0, d0];                     // along, as x × up
  const p = [box.centre[1], (y0 + y1) / 2, -box.centre[0]];
  return {
    local: [x[0], x[1], x[2], 0, 0, 1, 0, 0, z[0], z[1], z[2], 0, p[0], p[1], p[2], 1],
    half: [box.halfAcross, (y1 - y0) / 2, box.halfAlong],
  };
}
