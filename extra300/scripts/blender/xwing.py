# xwing.py — the Incom T-65B X-wing, modelled in Blender from the three-view schematic (Troy Vigil:
# top, side, front and rear views), scaled to its 12.5 m length.
#
#   npm run model:xwing   (BPY=<python with the bpy module>)
#   python scripts/blender/xwing.py [out.json] [--glb out.glb] [--blend out.blend] [--render dir]
#
# Body axes as the flight model's src/sim/aircraft/xwing.js: x forward, y right, z down, metres from R
# at the wing roots' leading edge. The four S-foils are separate moving parts, each with its engine,
# its laser cannon and its red markings, hinged along the fuselage so the sim can swing them into the
# X (attack position) or close them flat for cruise. The engines' glow rides on each S-foil.

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import Kit, V, body, loft, outward, superellipse, smooth_interp, bisect_paint, box, cylinder, rod, surface, merge, wheel  # noqa: E402
import bmesh  # noqa: E402  (after kit, which imports bpy first)
from mathutils import Matrix  # noqa: E402

# ── the numbers (as src/sim/aircraft/xwing.js) ──────────────────────────────
ROOT_Y, TIP_Y = 0.55, 5.3          # S-foil span: from inside the fuselage to the cannon's axis
LE = 0.2
def te(y): return -1.3 + (-1.95 + 1.3) * (y - 0.95) / (TIP_Y - 0.95)
HINGE_Z = 0.26                     # upper pair this far above R, lower this far below
ENGINE_Y, ENGINE_R = 1.62, 0.40
NOSE_X, TAIL_X = 9.08, -3.4
EYE = (2.55, 0.0, -0.80)
MAIN = dict(x=-1.6, y=0.85, z=1.75, r=0.30, w=0.18)
NOSEW = dict(x=4.8, z=1.75, r=0.22, w=0.14)

COLORS = {
    'white': '#dedcd5', 'grey': '#9c9ea1', 'darkGrey': '#55585d', 'red': '#c4452e', 'black': '#151618',
    'intake': '#1c1d20', 'metal': '#a4a7ab', 'glass': '#2c3540', 'tyre': '#151515', 'blue': '#2f5fae',
    'panel': '#2b2d31', 'seat': '#3b3f46', 'gearWhite': '#cfcfca', 'floor': '#3a3c40', 'nozzle': '#4b4541',
}
kit = Kit(COLORS)

# ── fuselage: the long tapering nose, the cockpit, the wide rear block ──────
# x, top z, bottom z, half-width, squareness (side and top views of the schematic)
FUS = [
    (NOSE_X, 0.00, 0.06, 0.012, 2.0),
    (8.70, -0.15, 0.20, 0.20, 2.2),
    (7.60, -0.27, 0.32, 0.38, 2.4),
    (5.50, -0.40, 0.42, 0.50, 2.6),
    (4.00, -0.52, 0.48, 0.60, 2.7),
    (3.00, -0.60, 0.52, 0.66, 2.8),
    (1.60, -0.68, 0.58, 0.80, 3.0),
    (1.15, -0.72, 0.62, 0.98, 3.6),
    (-2.55, -0.72, 0.62, 1.00, 4.0),
    (-2.80, -0.62, 0.52, 0.90, 3.4),
]


def fus_at(x):
    return smooth_interp(FUS, [x])[0]


def fuselage():
    bm = bmesh.new()
    xs = sorted(set([round(NOSE_X - (NOSE_X + 2.8) * i / 70, 4) for i in range(71)] + [8.95, 8.85, 1.3, 1.2, 1.1]), reverse=True)
    rings = []
    for x in xs:
        _, top, bot, hw, e = fus_at(x)
        rings.append(superellipse(x, top, bot, max(hw, 0.005), e, 40))
    loft(bm, rings, cap=True)
    # the red band down the nose's sides, the nose cone, the grey deck of the rear block
    bisect_paint(bm, [((7.6, 0, 0), (1, 0, 0)), ((1.3, 0, 0), (1, 0, 0)), ((0, 0, -0.10), (0, 0, 1)), ((0, 0, 0.10), (0, 0, 1)),
                      ((0, 0, -0.66), (0, 0, 1))])
    outward(bm)
    for f in bm.faces:
        x, y, z = body(f.calc_center_median())
        if 1.3 < x < 7.6 and -0.10 < z < 0.10 and abs(y) > 0.2:
            f.material_index = 1
        elif x < 1.2 and z < -0.66:
            f.material_index = 2
    kit.new_object('fuselage', bm, ['white', 'red', 'grey'], smooth_angle=40)
    # panels and vents on the rear block's flanks, the S-foil actuators between the wing roots
    bm = bmesh.new()
    for s in (-1, 1):
        box(bm, (-0.8, s * 1.0, 0.0), (2.6, 0.04, 0.30))
        box(bm, (-2.2, s * 0.99, -0.45), (0.6, 0.04, 0.18))
    box(bm, (-2.6, 0, 0), (0.08, 1.4, 0.9))
    outward(bm)
    kit.new_object('rearPanels', bm, ['darkGrey'], smooth_angle=30)


def canopy():
    # x, top z, half-width at the sill: the faceted transparisteel canopy
    rows = [(3.85, -0.60, 0.30), (3.30, -0.90, 0.40), (2.60, -1.10, 0.44), (2.00, -1.12, 0.44), (1.55, -1.00, 0.38)]
    sill = lambda x: fus_at(x)[1] + 0.02
    rings = []
    for x, top, hw in rows:
        z0 = sill(x)
        r = []
        for k in range(13):
            t = math.pi * k / 12
            c, s_ = math.cos(t), math.sin(t)
            r.append((x, hw * math.copysign(abs(c) ** (2 / 3.2), c), z0 - (z0 - top) * abs(s_) ** (2 / 3.2)))
        rings.append(r)
    bm = bmesh.new()
    loft(bm, rings, close=False, cap=False)
    outward(bm)
    ob = kit.new_object('canopy', bm, ['glass'], smooth_angle=20, meta=dict(transparent=True))
    ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.01
    # the frame: bows across and the spine along its top, the rails along the sill
    bm = bmesh.new()
    for ring in rings[1:4]:
        for a, b in zip(ring, ring[1:]):
            rod(bm, a, b, 0.022, 6)
    # (no spine along the top: nothing over the pilot's line of sight)
    for side in (0, -1):
        rail = [r[side] for r in rings]
        for a, b in zip(rail, rail[1:]):
            rod(bm, a, b, 0.03, 6)
    outward(bm)
    kit.new_object('canopyFrame', bm, ['darkGrey'], smooth_angle=40)
    # inside: seat, panel, stick
    bm = bmesh.new()
    box(bm, (2.05, 0, -0.35), (0.40, 0.46, 0.10))
    box(bm, (1.85, 0, -0.62), (0.10, 0.46, 0.60), Matrix.Rotation(math.radians(-15), 3, 'Y'))
    outward(bm)
    kit.new_object('seat', bm, ['seat'], smooth_angle=30)
    bm = bmesh.new()
    box(bm, (3.25, 0, -0.55), (0.06, 0.62, 0.30), Matrix.Rotation(math.radians(20), 3, 'Y'))
    box(bm, (3.30, 0, -0.71), (0.30, 0.66, 0.04))
    box(bm, (2.6, 0, -0.15), (1.6, 0.70, 0.04))
    outward(bm)
    kit.new_object('cockpitPanel', bm, ['panel'], smooth_angle=30)
    pivot = (2.75, 0, -0.18)
    bm = bmesh.new()
    rod(bm, pivot, (pivot[0], 0, -0.48), 0.016)
    box(bm, (pivot[0], 0, -0.53), (0.05, 0.05, 0.12))
    outward(bm)
    kit.new_object('stick', bm, ['black'], origin=pivot, smooth_angle=30, meta=dict(kind='stick', hinge=list(pivot), axis=[0, 1, 0]))


def astromech():
    """R2 in his socket behind the cockpit: the white dome with its blue panels, the radar eye."""
    c = (1.0, 0, -0.70)
    bm = bmesh.new()
    vs = bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=0.27)['verts']
    bmesh.ops.translate(bm, vec=V(*c), verts=vs)
    kill = [f for f in bm.faces if body(f.calc_center_median())[2] > c[2] + 0.02]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    outward(bm)
    kit.new_object('astromechDome', bm, ['white'], smooth_angle=60)
    bm = bmesh.new()
    for ang in (0, 60, 120, 180, 240, 300):
        a = math.radians(ang)
        box(bm, (c[0] + 0.24 * math.cos(a), 0.24 * math.sin(a), c[2] - 0.1), (0.07, 0.07, 0.07),
            Matrix.Rotation(-a, 3, 'Z'))
    box(bm, (c[0], 0, c[2] - 0.26), (0.12, 0.12, 0.04))
    outward(bm)
    kit.new_object('astromechPanels', bm, ['blue'], smooth_angle=30)
    bm = bmesh.new()
    vs = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=0.045)['verts']
    bmesh.ops.translate(bm, vec=V(c[0] + 0.2, 0.08, c[2] - 0.16), verts=vs)
    outward(bm)
    kit.new_object('astromechEye', bm, ['black'], smooth_angle=60)


# ── the four S-foils: wing, engine, cannon, markings — each one moving part ──
def sfoil(side, layer):
    """side: +1 right, -1 left; layer: +1 upper, -1 lower."""
    name = f"sfoil{'R' if side > 0 else 'L'}{'U' if layer > 0 else 'D'}"
    z = -layer * HINGE_Z
    # the wing: a flat slab widening toward the tip
    st = [(side * y, LE, te(y), 0.07, z) for y in (ROOT_Y, 0.95, 2.4, 3.8, TIP_Y - 0.18)]
    bm = surface(st, 0, 0.07)
    # red markings across the wing's outer half, on its outward face (upper wings' tops, lower wings' bottoms)
    bisect_paint(bm, [((0, side * 3.3, 0), (0, 1, 0)), ((0, side * 4.4, 0), (0, 1, 0)), ((-1.05, 0, 0), (1, 0, 0)), ((-0.65, 0, 0), (1, 0, 0))])
    for f in bm.faces:
        x, y, zz = body(f.calc_center_median())
        outward_face = (f.normal.z > 0.3) if layer > 0 else (f.normal.z < -0.3)
        stripe = (3.3 < abs(y) < 4.4 and x < -1.05) or (3.3 < abs(y) < 3.55 and x < -0.65)
        if outward_face and stripe:
            f.material_index = 1
    # the engine on the wing's outer face: intake ring, the can, the ribbed exhaust section
    ez = z - layer * (0.035 + ENGINE_R)
    ey = side * ENGINE_Y
    eng = bmesh.new()
    rings = []
    for x, r in ((0.68, 0.30), (0.66, 0.44), (0.40, 0.45), (0.20, 0.42), (-1.30, 0.40), (-1.40, 0.36), (-2.55, 0.36), (-2.62, 0.40), (-3.30, 0.38), (-3.40, 0.33)):
        rings.append([(x, ey + r * math.cos(2 * math.pi * k / 24), ez + r * math.sin(2 * math.pi * k / 24)) for k in range(24)])
    loft(eng, rings, cap=False)
    # exhaust fins around the rear section
    for k in range(8):
        a = 2 * math.pi * k / 8
        box(eng, (-2.95, ey + 0.40 * math.cos(a), ez + 0.40 * math.sin(a)), (0.6, 0.05, 0.05))
    outward(eng)
    merge(bm, eng)
    # the cannon at the tip: housing, barrel, flash suppressor, tip
    gun = bmesh.new()
    gy, gz = side * TIP_Y, z
    cylinder(gun, (-0.8, gy, gz), 0.15, 2.1, 'x', 12)
    cylinder(gun, (2.1, gy, gz), 0.065, 3.6, 'x', 10)
    cylinder(gun, (1.0, gy, gz), 0.09, 0.25, 'x', 10)
    cylinder(gun, (3.95, gy, gz), 0.13, 0.22, 'x', 12)
    cylinder(gun, (4.5, gy, gz), 0.03, 0.9, 'x', 8)
    outward(gun)
    merge(bm, gun)
    # the dark parts: the intake face, the cannon's housing rings
    dark = bmesh.new()
    dark.faces.new([dark.verts.new(V(0.62, ey + 0.29 * math.cos(2 * math.pi * k / 20), ez + 0.29 * math.sin(2 * math.pi * k / 20))) for k in range(20)])
    cylinder(dark, (-3.36, ey, ez), 0.31, 0.06, 'x', 20)
    outward(dark)
    hinge = (0.0, side * 0.6, z)
    m = len(bm.faces)
    merge(bm, dark)
    for i, f in enumerate(bm.faces):
        if i >= m:
            f.material_index = 2
    kit.new_object(name, bm, ['white', 'red', 'intake'], origin=hinge, smooth_angle=35,
                   meta=dict(kind='sfoil', side=side, layer=layer, hinge=list(hinge), axis=[1, 0, 0]))
    # the engine's glow is drawn by the plugin; the exhaust's centre rides on this S-foil (meta parent)
    bm = bmesh.new()
    bm.faces.new([bm.verts.new(V(-3.43, ey + 0.30 * math.cos(2 * math.pi * k / 20), ez + 0.30 * math.sin(2 * math.pi * k / 20))) for k in range(20)])
    outward(bm)
    glow = (-3.43, ey, ez)
    kit.new_object(f'{name}Glow', bm, ['red'], origin=glow, smooth_angle=10,
                   meta=dict(kind='engineGlow', hinge=list(glow), axis=[1, 0, 0], parent=name, transparent=True))


# ── landing gear: three legs that fold forward ──────────────────────────────
def gear():
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        hub = (MAIN['x'], side * MAIN['y'], MAIN['z'] - MAIN['r'])
        top = (MAIN['x'] + 0.1, side * 0.75, 0.60)
        bm = bmesh.new()
        rod(bm, top, (hub[0] + 0.02, side * (MAIN['y'] - MAIN['w'] / 2 - 0.04), hub[2] - 0.05), 0.07, 10)
        outward(bm)
        leg = f'mainLeg{sname}'
        kit.new_object(leg, bm, ['gearWhite'], origin=top, smooth_angle=40, meta=dict(kind='gearLeg', gear=0 if side < 0 else 1, hinge=list(top), axis=[0, 1, 0], fold=90))
        wheel(kit, f'wheel{sname}', hub, MAIN['r'], MAIN['w'], dict(kind='wheel', gear=0 if side < 0 else 1, parent=leg))
    top = (NOSEW['x'] + 0.05, 0, 0.45)
    hub = (NOSEW['x'], 0, NOSEW['z'] - NOSEW['r'])
    bm = bmesh.new()
    rod(bm, top, (hub[0] + 0.03, 0, hub[2] - 0.25), 0.055, 10)
    for s in (-1, 1):
        rod(bm, (hub[0] + 0.03, s * 0.10, hub[2] - 0.27), (hub[0], s * 0.10, hub[2]), 0.03, 8)
    outward(bm)
    kit.new_object('noseLeg', bm, ['gearWhite'], origin=top, smooth_angle=40, meta=dict(kind='gearLeg', gear=2, hinge=list(top), axis=[0, 1, 0], fold=95))
    wheel(kit, 'nosewheel', hub, NOSEW['r'], NOSEW['w'], dict(kind='steerwheel', gear=2, parent='noseLeg'))


fuselage()
canopy()
astromech()
for s in (-1, 1):
    for l in (1, -1):
        sfoil(s, l)
gear()

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
out_json = args[0] if args and not args[0].startswith('--') else 'data/model/xwing.json'
kit.export(out_json, EYE)
if '--glb' in args:
    import bpy
    p = args[args.index('--glb') + 1]
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', export_apply=True)
    print('glb →', p)
if '--blend' in args:
    import bpy
    p = os.path.abspath(args[args.index('--blend') + 1])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=p)
    print('blend →', p)
if '--render' in args:
    import bpy
    # the render shows it in attack position: swing the S-foils open
    for ob, meta in kit.parts:
        if meta.get('kind') == 'sfoil':
            ob.rotation_euler = (-meta['side'] * meta['layer'] * math.radians(15), 0, 0)
    views = {
        'front34': ((11, -9, 3.5), (1.5, 0, 0), 40),
        'rear34': ((-12, 8, 4), (0, 0, 0), 40),
        'side': ((2.8, -24, 0), (2.8, 0, 0), 'ortho', 14),
        'top': ((2.8, 0, 24), (2.8, 0, 0), 'ortho', 14),
        'front': ((24, 0, 0), (0, 0, 0), 'ortho', 12),
        'cockpit': (V(*EYE), V(9, 0, -0.3), 80),
    }
    kit.render(args[args.index('--render') + 1], views, MAIN['z'] - 0.05)
