// waterMask.js — where the lake is, for the Google 3D Tiles vibe's water shading
// ("googletiles:water-mask"): Google's lake is a satellite photo; with OpenStreetMap's
// land/water raster it can be shaded as water instead (waves, the sky reflected, the sun's
// glint), no extra geometry. Two masks, 1 = water:
//
//   near  the OSM raster itself, 4 m cells over the city and the lakefront
//   far   the land out to the horizon (world.farLand), 80 km square, ~80 m cells
//
// and for each the transform from world space to (u, v, height above the datum).

const FAR = 40000;      // m, the far mask's half-size
const FAR_PX = 1024;

/**
 * @param {object} device  the graphics device
 * @param {object} world   buildMeigs(), with the OSM attached
 * @returns {{ near: { texture, box }, far: { texture, box } } | null}
 */
export function buildWaterMasks(device, world) {
  const osm = world.osm;
  if (!osm?.mask || !world.farLand) return null;
  const { nx, ny, data } = osm.mask;
  const b = osm.header.box;
  // near: the raster as it is (row 0 = its south edge, which the engine reads at v = 0)
  const near = new pc.Texture(device, {
    width: nx, height: ny, format: pc.PIXELFORMAT_R8, mipmaps: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR, magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  const px = near.lock();
  for (let i = 0; i < data.length; i++) px[i] = data[i] === 1 ? 0 : 255;
  near.unlock();
  // far: the land polygon out to the horizon, filled on a canvas (y = north, from the south edge)
  const c = document.createElement('canvas');
  c.width = c.height = FAR_PX;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, FAR_PX, FAR_PX);
  g.fillStyle = '#000';
  g.beginPath();
  world.farLand.forEach(([e, n], i) => {
    const x = ((e + FAR) / (2 * FAR)) * FAR_PX, y = ((n + FAR) / (2 * FAR)) * FAR_PX;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  });
  g.closePath();
  g.fill();
  // and the near raster's land, coarsely, so the two agree where they meet
  const k = (2 * FAR) / FAR_PX;
  for (let y = 0; y < FAR_PX; y++) {
    const n = -FAR + (y + 0.5) * k;
    if (n < b.y0 || n >= b.y1) continue;
    for (let x = 0; x < FAR_PX; x++) {
      const e = -FAR + (x + 0.5) * k;
      if (e < b.x0 || e >= b.x1) continue;
      const i = Math.floor((e - b.x0) / ((b.x1 - b.x0) / nx)), j = Math.floor((n - b.y0) / ((b.y1 - b.y0) / ny));
      g.fillStyle = data[j * nx + i] === 1 ? '#000' : '#fff';
      g.fillRect(x, y, 1, 1);
    }
  }
  const far = new pc.Texture(device, {
    width: FAR_PX, height: FAR_PX, format: pc.PIXELFORMAT_RGBA8, mipmaps: true,
    addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
  });
  far.setSource(c);
  return {
    near: { texture: near, box: { e: [b.x0, b.x1], n: [b.y0, b.y1] } },
    far: { texture: far, box: { e: [-FAR, FAR], n: [-FAR, FAR] } },
  };
}

/**
 * World → (u, v, height) for a mask over box (e, n ranges, metres), as column-major 4×4 data:
 * the world root's inverse, then the root's render metres (x east, y up, z south) onto the mask.
 */
export function maskTransform(rootWorld, box) {
  const W = box.e[1] - box.e[0], H = box.n[1] - box.n[0];
  const a = new pc.Mat4();
  // rows: u = (x − e0)/W, v = (−z − n0)/H, h = y
  a.data.set([1 / W, 0, 0, 0, 0, 0, 1, 0, 0, -1 / H, 0, 0, -box.e[0] / W, -box.n[0] / H, 0, 1]);
  const inv = rootWorld.clone().invert();
  return Array.from(new pc.Mat4().mul2(a, inv).data);
}
