// massprops.js — weight & balance: total mass, CG and inertia about the CG
// from the empty airframe plus point-mass items (pilot, fuel, baggage).

export function massProperties(spec, load) {
  const items = [{ m: spec.empty.m, pos: spec.empty.pos }];
  const it = spec.items;
  items.push({ m: load.pilot ?? it.pilot.m, pos: it.pilot.pos });
  items.push({ m: load.passenger ?? it.passenger.m, pos: it.passenger.pos });
  items.push({ m: load.baggage ?? it.baggage.m, pos: it.baggage.pos });
  items.push({ m: (load.fuelCenterL ?? 0) * spec.fuelDensity, pos: it.fuelCenter.pos });
  items.push({ m: (load.fuelWingsL ?? 0) * spec.fuelDensity, pos: it.fuelWings.pos });

  let m = 0;
  const cg = [0, 0, 0];
  for (const i of items) {
    m += i.m;
    cg[0] += i.m * i.pos[0]; cg[1] += i.m * i.pos[1]; cg[2] += i.m * i.pos[2];
  }
  cg[0] /= m; cg[1] /= m; cg[2] /= m;

  // empty inertia about the empty CG, shifted to the new CG, plus point masses
  const I = { xx: 0, yy: 0, zz: 0, xz: 0 };
  const e = spec.inertiaEmpty;
  const shift = (mass, p) => {
    const dx = p[0] - cg[0], dy = p[1] - cg[1], dz = p[2] - cg[2];
    I.xx += mass * (dy * dy + dz * dz);
    I.yy += mass * (dx * dx + dz * dz);
    I.zz += mass * (dx * dx + dy * dy);
    I.xz += mass * dx * dz;
  };
  I.xx += e.xx; I.yy += e.yy; I.zz += e.zz; I.xz += e.xz;
  for (const i of items) shift(i.m, i.pos);
  return { mass: m, cg, inertia: I };
}
