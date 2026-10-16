// geo.js — WGS-84 latitude/longitude ↔ a flat local frame (north, east)
// tangent at an origin. At the scale of Chicago's lakefront (tens of km)
// the flat-earth error stays under a metre, well inside the source data.

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

export function radii(latDeg) {
  const s = Math.sin(latDeg * DEG);
  const w = Math.sqrt(1 - E2 * s * s);
  return { M: (A * (1 - E2)) / (w * w * w), N: A / w }; // meridional, prime vertical
}

export class LocalFrame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    const { M, N } = radii(lat0);
    this.mPerDegLat = M * DEG;
    this.mPerDegLon = N * Math.cos(lat0 * DEG) * DEG;
  }
  /** [lat, lon] → [north, east] metres */
  toNE(lat, lon) {
    return [(lat - this.lat0) * this.mPerDegLat, (lon - this.lon0) * this.mPerDegLon];
  }
  /** [north, east] metres → [lat, lon] */
  toLatLon(n, e) {
    return [this.lat0 + n / this.mPerDegLat, this.lon0 + e / this.mPerDegLon];
  }
}

/** Point-in-polygon (even-odd) for [[x, y], ...]. */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ear-clipping triangulation of a simple polygon (no holes). Returns index triples. */
export function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse(); // make it counter-clockwise
  const tris = [];
  const isEar = (a, b, c, rest) => {
    const [ax, ay] = poly[a], [bx, by] = poly[b], [cx, cy] = poly[c];
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-12) return false; // reflex
    for (const p of rest) {
      if (p === a || p === b || p === c) continue;
      const [px, py] = poly[p];
      const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (d1 >= 0 && d2 >= 0 && d3 >= 0) return false;
    }
    return true;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length];
      const b = idx[i];
      const c = idx[(i + 1) % idx.length];
      if (isEar(a, b, c, idx)) {
        tris.push([a, b, c]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break; // degenerate input; return what we have
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
