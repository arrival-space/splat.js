# f15c.py — the McDonnell Douglas F-15C Eagle, modelled in Blender from numbers.
#
#   npm run model:f15   (BPY=<python with the bpy module>)
#   python scripts/blender/f15c.py [out.json] [--glb out.glb] [--blend out.blend] [--render dir]
#
# Published dimensions (19.43 m long, 13.05 m span, 5.63 m high, 56.5 m² wing with a 45° leading
# edge, 8.61 m stabilator span, 5.42 m wheelbase, 2.75 m track) and the three-view's proportions,
# in the flight model's body axes: the planform, the stabilators, fins and rudders, the gear and
# the eye point are those of src/sim/aircraft/f15c.js (x forward, y right, z down, metres from R;
# the radome tip is 11.0 m ahead of R). Moving parts have their origin on their hinge; the gear
# legs fold forward into the fuselage and their wheels ride on them (meta `parent`).
#
# scripts/bake-model.mjs turns the JSON into src/render/data/f15cModel.js.

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import Kit, V, body, loft, outward, superellipse, smooth_interp, bisect_paint, box, cylinder, rod, surface, merge, wheel  # noqa: E402
import bmesh  # noqa: E402  (after kit, which imports bpy first)
from mathutils import Matrix  # noqa: E402

NOSE = 11.0
def xb(st): return NOSE - st                    # station (m aft of the radome tip) → body x

# ── the airplane's numbers (as src/sim/aircraft/f15c.js) ─────────────────────
SEMI = 13.05 / 2
LE0 = xb(7.2)
WING_Z = -0.50
def wing_le(y): return LE0 - abs(y)               # 45°
def chord_at(y): return 6.93 + (1.73 - 6.93) * abs(y) / SEMI
def wing_te(y): return wing_le(y) - chord_at(y)
def wing_z(y): return WING_Z + max(0.0, abs(y) - 1.35) * math.tan(math.radians(1.0))   # 1° anhedral
FLAP_IN, FLAP_OUT, FLAP_FRAC = 1.65, 4.1, 0.24
AIL_IN, AIL_OUT, AIL_FRAC = 4.1, 6.0, 0.22

STAB_Y0, STAB_Y1, STAB_Z = 1.95, 4.305, 0.0
def stab_le(y): return xb(15.6) - (y - STAB_Y0)
def stab_chord(y): return 3.0 + (1.1 - 3.0) * (y - STAB_Y0) / (STAB_Y1 - STAB_Y0)
STAB_PIVOT_X = xb(16.9)

FIN_Y, FIN_Z0, FIN_Z1 = 1.3, -0.75, 2.15 - 5.63
def fin_le(z): return xb(14.9) - (FIN_Z0 - z) * math.tan(math.radians(37))
def fin_chord(z): return 2.9 + (1.0 - 2.9) * (z - FIN_Z0) / (FIN_Z1 - FIN_Z0)
RUD_Z0, RUD_Z1, RUD_FRAC = -0.85, -2.10, 0.30

MAIN = dict(x=-0.9, y=1.375, z=2.27, r=0.44, w=0.25)     # contact point (strut extended), tyre
NOSEW = dict(x=4.52, z=2.27, r=0.28, w=0.17)
NOZZLE_Y = 0.64
EYE = (xb(5.3), 0.0, -1.32)
SILL_Z = -1.0

COLORS = {
    'grey': '#8e969d', 'darkGrey': '#6b737b', 'radome': '#a3a8ab', 'nozzle': '#4b4541', 'burner': '#2a2622',
    'intake': '#26282b', 'tyre': '#151515', 'metal': '#a4a7ab', 'gearWhite': '#d9d9d4', 'panel': '#2b2d31',
    'gauge': '#0c0d0f', 'seat': '#2d2f33', 'strap': '#6d6342', 'glass': '#6b6754', 'floor': '#3a3c40',
    'navRed': '#ff2a2a', 'navGreen': '#22d25a', 'black': '#151618', 'hud': '#3f6b54',
    'cushion': '#4b5333', 'yellow': '#e2b21e', 'key': '#6f7276', 'consolePanel': '#121315', 'red': '#c2281f',
    'screenBlue': '#203d73', 'screenGreen': '#1d6e3e', 'lampGreen': '#5dff8a', 'lampAmber': '#ffb238', 'cockpit': '#1a1b1e',
}

kit = Kit(COLORS)


# ── fuselage: radome, cockpit, the spine between the intakes, the two engine bays ──
# station, top z, bottom z, half-width, squareness — from the three-view's side and top views
FUS = [
    (0.00, -0.33, -0.31, 0.012, 2.0),
    (0.35, -0.43, -0.19, 0.11, 2.0),
    (1.10, -0.60, -0.01, 0.28, 2.0),
    (2.10, -0.77, 0.14, 0.44, 2.1),
    (3.10, -0.91, 0.25, 0.55, 2.3),
    (4.20, -1.00, 0.33, 0.62, 2.5),
    (5.40, -1.02, 0.40, 0.66, 2.7),
    (6.80, -1.03, 0.48, 0.73, 3.0),
    (8.00, -0.99, 0.56, 0.86, 3.2),
    (9.50, -0.95, 0.62, 1.15, 3.6),
    (11.0, -0.91, 0.66, 1.35, 4.0),
    (13.0, -0.82, 0.62, 1.38, 4.0),
    (15.0, -0.72, 0.57, 1.34, 4.0),
    (16.5, -0.64, 0.54, 1.28, 3.6),
    (17.9, -0.56, 0.52, 1.20, 3.0),
]
CANOPY_ST0, CANOPY_BOW, CANOPY_ST1 = 3.6, 4.65, 7.45
COCKPIT_X0, COCKPIT_X1 = 4.95, 6.84         # body x: the opening, from behind the seat to the coaming
# canopy: station, top z, half-width at the sill
CANOPY = [(3.60, -1.05, 0.42), (4.10, -1.27, 0.50), (4.65, -1.40, 0.55), (5.30, -1.46, 0.57), (6.00, -1.45, 0.56),
          (6.60, -1.37, 0.52), (7.10, -1.22, 0.42), (7.45, -1.06, 0.26)]


def fus_at(st):
    rows = [(-r[0],) + r[1:] for r in FUS]        # smooth_interp wants x descending: use -station
    return smooth_interp(rows, [-st])[0]


def fuselage():
    bm = bmesh.new()
    sts = [17.9 * (i / 90) ** 1.0 for i in range(91)]
    sts = sorted(set([round(s, 4) for s in sts] + [0.05, 0.12, 0.2, 0.28]))
    rings = []
    for st in sts:
        _, top, bot, hw, e = fus_at(st)
        rings.append([(xb(st), y, z) for _, y, z in superellipse(0, top, bot, max(hw, 0.004), e, 48)])
    loft(bm, rings, cap=True)
    # the radome a lighter grey; the anti-glare panel ahead of the windscreen black
    bisect_paint(bm, [((xb(2.35), 0, 0), (1, 0, 0)), ((xb(CANOPY_ST0), 0, 0), (1, 0, 0)), ((0, 0, -0.80), (0, 0, 1)),
                      ((0, 0.30, 0), (0, 1, 0)), ((0, -0.30, 0), (0, 1, 0)),
                      ((COCKPIT_X0, 0, 0), (1, 0, 0)), ((COCKPIT_X1, 0, 0), (1, 0, 0)), ((0, 0.57, 0), (0, 1, 0)), ((0, -0.57, 0), (0, 1, 0)),
                      ((0, 0, -0.78), (0, 0, 1))])
    # the cockpit's opening under the canopy: the skin's top cut away between the coaming and the seat
    kill = [f for f in bm.faces if COCKPIT_X0 < body(f.calc_center_median())[0] < COCKPIT_X1
            and abs(body(f.calc_center_median())[1]) < 0.57 and body(f.calc_center_median())[2] < -0.78]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    outward(bm)
    for f in bm.faces:
        x, y, z = body(f.calc_center_median())
        st = NOSE - x
        if st < 2.35:
            f.material_index = 1
        elif st < CANOPY_ST0 and z < -0.80 and abs(y) < 0.30:
            f.material_index = 2
    kit.new_object('fuselage', bm, ['grey', 'radome', 'black'], smooth_angle=60)
    # dorsal spine fairing behind the canopy, a little proud of the top, the speed brake sits in it
    bm = bmesh.new()
    rings = []
    for st in (7.2, 7.6, 8.2, 10.6, 12.5, 14.5):
        _, top, bot, hw, e = fus_at(st)
        w = {7.2: 0.12, 7.6: 0.30, 8.2: 0.42, 10.6: 0.45, 12.5: 0.40, 14.5: 0.10}[st]
        lift = {7.2: 0.0, 7.6: 0.08, 8.2: 0.10, 10.6: 0.10, 12.5: 0.07, 14.5: 0.0}[st]
        rings.append(superellipse(xb(st), top - lift, top + 0.25, w, 3.0, 24))
    loft(bm, rings, cap=True)
    outward(bm)
    kit.new_object('spine', bm, ['grey'], smooth_angle=50)


def intakes():
    """Two big rectangular intakes either side of the cockpit, the upper lip raked forward, blending aft into the
    engine bays; a dark duct face a little way in."""
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        bm = bmesh.new()
        # station, inner y, outer y, top z, bottom z
        rows = [(5.30, 0.72, 1.63, -0.80, 0.78), (6.0, 0.74, 1.64, -0.81, 0.79), (7.5, 0.78, 1.64, -0.83, 0.78),
                (9.0, 0.85, 1.60, -0.85, 0.74), (10.5, 0.95, 1.52, -0.86, 0.70), (12.0, 1.05, 1.44, -0.86, 0.68)]
        rings = []
        for i, (st, yi, yo, zt, zb) in enumerate(rows):
            r = superellipse(0, zt, zb, (yo - yi) / 2, 6.0, 40, yc=side * (yo + yi) / 2)
            ring = []
            for _, y, z in r:
                # the lip is raked: the top edge 0.75 m ahead of the bottom
                rake = 0.75 * (z - zt) / (zb - zt) if i == 0 else 0.0
                ring.append((xb(st + rake), y, z))
            rings.append(ring)
        loft(bm, rings, cap=False)
        outward(bm)
        ob = kit.new_object(f'intake{sname}', bm, ['grey'], smooth_angle=45)
        ob.modifiers.new('shell', 'SOLIDIFY').thickness = 0.03
        # the duct face, the variable ramp's dark mouth
        bm = bmesh.new()
        st, yi, yo, zt, zb = rows[1]
        sec = superellipse(0, zt + 0.06, zb - 0.06, (yo - yi) / 2 - 0.06, 6.0, 32, yc=side * (yo + yi) / 2)
        bm.faces.new([bm.verts.new(V(xb(6.3), y, z)) for _, y, z in sec])
        outward(bm)
        kit.new_object(f'duct{sname}', bm, ['intake'], smooth_angle=10)


def engines():
    """Two nozzles with their petals, the hot section dark inside, and the tail booms the fins stand on."""
    bm_n, bm_i = bmesh.new(), bmesh.new()
    for side in (-1, 1):
        y = side * NOZZLE_Y
        rings = []
        for st, r in ((17.3, 0.60), (17.9, 0.58), (18.4, 0.55), (18.9, 0.51), (19.3, 0.47)):
            rings.append([(xb(st), y + r * math.cos(2 * math.pi * k / 32), 0.0 + r * math.sin(2 * math.pi * k / 32)) for k in range(32)])
        # turned in at the lip: the petals' thickness
        rings.append([(xb(19.3), y + 0.43 * math.cos(2 * math.pi * k / 32), 0.43 * math.sin(2 * math.pi * k / 32)) for k in range(32)])
        rings.append([(xb(18.7), y + 0.42 * math.cos(2 * math.pi * k / 32), 0.42 * math.sin(2 * math.pi * k / 32)) for k in range(32)])
        loft(bm_n, rings, cap=False)
        bm_i.faces.new([bm_i.verts.new(V(xb(18.7), y + 0.42 * math.cos(2 * math.pi * k / 24), 0.42 * math.sin(2 * math.pi * k / 24))) for k in range(24)])
    # petal seams
    bisect_paint(bm_n, [((xb(18.4), 0, 0), (1, 0, 0))])
    outward(bm_n)
    outward(bm_i)
    for f in bm_n.faces:
        x, _, _ = body(f.calc_center_median())
        f.material_index = 1 if NOSE - x > 18.4 else 0
    kit.new_object('nozzles', bm_n, ['grey', 'nozzle'], smooth_angle=50)
    kit.new_object('burnerCans', bm_i, ['burner'], smooth_angle=10)
    # tail booms outboard of the engines: the stabilators pivot on them
    for side in (-1, 1):
        bm = bmesh.new()
        rings = []
        for st, r in ((13.6, 0.02), (14.4, 0.20), (16.0, 0.26), (17.6, 0.24), (18.7, 0.12), (19.0, 0.02)):
            rings.append(superellipse(xb(st), -0.05 - r * 0.7, 0.10 + r * 0.45, r + 0.04, 3.0, 20, yc=side * 1.48))
        loft(bm, rings, cap=True)
        outward(bm)
        kit.new_object('boomL' if side < 0 else 'boomR', bm, ['grey'], smooth_angle=50)


def canopy_rings(n=26):
    rings = []
    sts = [CANOPY_ST0 + (CANOPY_ST1 - CANOPY_ST0) * i / 28 for i in range(29)]
    for st in sts:
        # interpolate the canopy's own table
        for (s0, t0, w0), (s1, t1, w1) in zip(CANOPY, CANOPY[1:]):
            if s0 <= st <= s1:
                u = (st - s0) / (s1 - s0)
                top, hw = t0 + (t1 - t0) * u, w0 + (w1 - w0) * u
                break
        r = []
        for k in range(n + 1):
            t = math.pi * k / n
            c, s = math.cos(t), math.sin(t)
            r.append((xb(st), hw * math.copysign(abs(c) ** (2 / 2.4), c), SILL_Z + 0.02 - (SILL_Z + 0.02 - top) * abs(s) ** (2 / 2.4)))
        rings.append((st, r))
    return rings


def canopy():
    rings = canopy_rings()
    # the fixed windscreen ahead of the bow, the opening bubble behind it: both glass
    for name, a, b in (('windscreen', CANOPY_ST0, CANOPY_BOW), ('canopy', CANOPY_BOW, CANOPY_ST1)):
        bm = bmesh.new()
        loft(bm, [r for st, r in rings if a - 1e-6 <= st <= b + 0.06], close=False, cap=False)
        outward(bm)
        ob = kit.new_object(name, bm, ['glass'], smooth_angle=85, meta=dict(transparent=True))
        ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.008
    # frame: sill rails, the windscreen bow and the canopy's rear edge
    bm = bmesh.new()
    for side in (0, -1):
        rail = [r[side] for _, r in rings]
        s = 1 if side == 0 else -1
        r0 = [(x, y + s * 0.012, z + 0.02) for x, y, z in rail]
        r1 = [(x, y + s * 0.012, z - 0.025) for x, y, z in rail]
        r2 = [(x, y - s * 0.025, z - 0.025) for x, y, z in rail]
        r3 = [(x, y - s * 0.025, z + 0.02) for x, y, z in rail]
        loft(bm, [list(q) for q in zip(r0, r1, r2, r3)], close=True, cap=True)
    for st in (CANOPY_BOW, CANOPY_ST1 - 0.05):
        _, ring = min(rings, key=lambda r: abs(r[0] - st))
        out = [(x, y * 1.015, z - 0.008) for x, y, z in ring]
        inn = [(x, y * 0.985, z + 0.014) for x, y, z in ring]
        for (a, b), (c, d) in zip(zip(out, out[1:]), zip(inn, inn[1:])):
            bm.faces.new([bm.verts.new(V(*p)) for p in (a, b, d, c)])
    outward(bm)
    kit.new_object('canopyFrame', bm, ['black'], smooth_angle=40)


# the large area display: where the plugin draws its live pages (src/plugin/cockpitDisplay.js has the same numbers)
LAD = dict(c=(6.553, 0.0, -0.856), w=0.50, h=0.27, tilt=25)


def cockpit():
    """The Advanced Eagle's cockpit (after the F-15EX photo): the big touchscreen across the panel under the
    coaming, the up-front controller and the HUD on its posts above it, the standby displays either side,
    side consoles with their panels, knobs, switches and lit lamps, the throttles on the left, the centre
    stick, rudder pedals, and the ACES II seat with its olive cushion and yellow handles."""
    tilt = Matrix.Rotation(math.radians(LAD['tilt']), 3, 'Y')      # the panel leans away, its face up to the eye
    n = (-math.cos(math.radians(LAD['tilt'])), 0, -math.sin(math.radians(LAD['tilt'])))   # toward the pilot
    u = (math.sin(math.radians(LAD['tilt'])), 0, -math.cos(math.radians(LAD['tilt'])))    # up the panel's face
    def on_panel(du, dy, dn=0.0):
        c = LAD['c']
        return (c[0] + u[0] * du + n[0] * dn, dy, c[2] + u[2] * du + n[2] * dn)

    # ── the main panel and the coaming over it ──
    bm = bmesh.new()
    box(bm, on_panel(-0.07, 0, -0.035), (0.06, 0.94, 0.52), tilt)
    # the bezel round the display, its rows of option buttons above and below
    for du in (LAD['h'] / 2 + 0.018, -LAD['h'] / 2 - 0.018):
        box(bm, on_panel(du, 0, 0.004), (0.012, LAD['w'] + 0.05, 0.02), tilt)
    for dy in (-LAD['w'] / 2 - 0.016, LAD['w'] / 2 + 0.016):
        box(bm, on_panel(0, dy, 0.004), (0.012, 0.018, LAD['h'] + 0.05), tilt)
    # the lower panel down to the floor between the knees
    box(bm, (6.62, 0, -0.38), (0.08, 0.50, 0.40), Matrix.Rotation(math.radians(8), 3, 'Y'))
    outward(bm)
    kit.new_object('panel', bm, ['cockpit'], smooth_angle=30)
    bm = bmesh.new()
    rings = []
    # (it starts at the panel's top edge, in front of the display, and runs forward under the windscreen)
    for x in (6.62, 6.75, 6.95):
        r = []
        for k in range(17):
            y = -0.54 + 1.08 * k / 16
            r.append((x, y, -1.05 + 0.30 * (abs(y) / 0.54) ** 3 + (0.03 if x < 6.7 else 0)))
        rings.append(r)
    loft(bm, rings, close=False, cap=False)
    outward(bm)
    ob = kit.new_object('coaming', bm, ['cockpit'], smooth_angle=40)
    ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.03
    # option-button keys along the display's bezel
    bm = bmesh.new()
    for k in range(12):
        dy = -LAD['w'] / 2 + 0.03 + k * (LAD['w'] - 0.06) / 11
        for du in (LAD['h'] / 2 + 0.018, -LAD['h'] / 2 - 0.018):
            box(bm, on_panel(du, dy, 0.012), (0.008, 0.026, 0.012), tilt)
    for k in range(6):
        for dy in (-LAD['w'] / 2 - 0.016, LAD['w'] / 2 + 0.016):
            box(bm, on_panel(-LAD['h'] / 2 + 0.03 + k * 0.042, dy, 0.012), (0.008, 0.012, 0.026), tilt)
    outward(bm)
    kit.new_object('ladKeys', bm, ['key'], smooth_angle=30)

    # ── the standby displays either side and the warning lights ──
    bm = bmesh.new()
    box(bm, on_panel(-0.06, -0.37, 0.004), (0.006, 0.085, 0.085), tilt)     # standby attitude
    bm2 = bmesh.new()
    box(bm2, on_panel(-0.02, 0.37, 0.004), (0.006, 0.07, 0.16), tilt)       # engine monitor
    outward(bm); outward(bm2)
    kit.new_object('standbyAttitude', bm, ['screenBlue'], smooth_angle=30)
    kit.new_object('engineMonitor', bm2, ['screenGreen'], smooth_angle=30)
    bm = bmesh.new()
    for i, dy in enumerate((-0.40, -0.35, 0.33, 0.38, 0.43)):
        box(bm, on_panel(0.16, dy, 0.006), (0.006, 0.022, 0.014), tilt)
    outward(bm)
    kit.new_object('panelLamps', bm, ['lampGreen'], smooth_angle=30)
    bm = bmesh.new()
    box(bm, on_panel(0.20, -0.30, 0.006), (0.006, 0.026, 0.026), tilt)
    outward(bm)
    kit.new_object('masterCaution', bm, ['red'], smooth_angle=30)

    # ── the up-front controller: keypad, its little display, knobs either side ──
    ufc = (6.60, 0, -1.04)
    ut = Matrix.Rotation(math.radians(20), 3, 'Y')
    bm = bmesh.new()
    box(bm, ufc, (0.10, 0.32, 0.13), ut)
    outward(bm)
    kit.new_object('ufc', bm, ['black'], smooth_angle=30)
    face = (ufc[0] - 0.052 * math.cos(math.radians(20)), 0, ufc[2] - 0.052 * math.sin(math.radians(20)))
    fu = (math.sin(math.radians(20)), 0, -math.cos(math.radians(20)))
    at = lambda du, dy, dn=0.0: (face[0] + fu[0] * du - dn * math.cos(math.radians(20)), dy, face[2] + fu[2] * du - dn * math.sin(math.radians(20)))
    bm = bmesh.new()
    for row in range(4):
        for col in range(5):
            box(bm, at(-0.045 + row * 0.024, -0.06 + col * 0.03, 0.004), (0.008, 0.022, 0.018), ut)
    outward(bm)
    kit.new_object('ufcKeys', bm, ['key'], smooth_angle=30)
    bm = bmesh.new()
    box(bm, at(0.052, 0, 0.003), (0.004, 0.16, 0.014), ut)
    outward(bm)
    kit.new_object('ufcDisplay', bm, ['screenGreen'], smooth_angle=30)
    bm = bmesh.new()
    for dy in (-0.13, 0.13):
        for du in (-0.035, 0.03):
            c = at(du, dy, 0.012)
            cylinder(bm, c, 0.014, 0.025, 'x', 10)
    outward(bm)
    kit.new_object('ufcKnobs', bm, ['black'], smooth_angle=40)

    # ── the HUD: two posts up from the controller, the combiner glass between them, a bar over it ──
    bm = bmesh.new()
    for dy in (-0.115, 0.115):
        box(bm, (6.66, dy, -1.20), (0.02, 0.022, 0.26), Matrix.Rotation(math.radians(-8), 3, 'Y'))
    box(bm, (6.68, 0, -1.33), (0.02, 0.25, 0.014))
    outward(bm)
    kit.new_object('hudFrame', bm, ['black'], smooth_angle=30)
    bm = bmesh.new()
    box(bm, (6.665, 0, -1.215), (0.006, 0.21, 0.21), Matrix.Rotation(math.radians(-8), 3, 'Y'))
    outward(bm)
    kit.new_object('hudGlass', bm, ['hud'], smooth_angle=30, meta=dict(transparent=True))

    # ── floor, the tub's walls, the side consoles with their panels ──
    bm = bmesh.new()
    box(bm, (5.95, 0, 0.02), (1.6, 0.96, 0.04))
    for sgn in (-1, 1):
        box(bm, (5.90, sgn * 0.47, -0.30), (1.90, 0.14, 0.62))         # console body
        box(bm, (5.90, sgn * 0.555, -0.79), (1.90, 0.03, 0.40))        # wall up to the sill
    box(bm, (4.97, 0, -0.50), (0.04, 1.12, 0.98))                      # the bulkhead behind the seat
    outward(bm)
    kit.new_object('cockpitTub', bm, ['cockpit'], smooth_angle=30)
    bm = bmesh.new()
    for sgn in (-1, 1):
        for i, (x0, w) in enumerate(((5.15, 0.22), (5.40, 0.24), (5.66, 0.22), (5.92, 0.24), (6.20, 0.26))):
            box(bm, (x0, sgn * 0.47, -0.62), (w - 0.02, 0.13, 0.012))
    outward(bm)
    kit.new_object('consolePanels', bm, ['consolePanel'], smooth_angle=30)
    bm, bk, bl, ba = bmesh.new(), bmesh.new(), bmesh.new(), bmesh.new()
    import random
    rnd = random.Random(15)
    for sgn in (-1, 1):
        for x0 in (5.15, 5.40, 5.66, 5.92, 6.20):
            if sgn < 0 and x0 in (5.66, 5.92):
                continue                                  # the throttle quadrant sits here
            for _ in range(4):
                x, y = x0 + rnd.uniform(-0.08, 0.08), sgn * (0.47 + rnd.uniform(-0.045, 0.045))
                kind = rnd.random()
                if kind < 0.4:
                    cylinder(bk, (x, y, -0.64), 0.012, 0.03, 'z', 8)                      # knob
                elif kind < 0.75:
                    rod(bm, (x, y, -0.627), (x + 0.012, y, -0.665), 0.004, 5)              # toggle switch
                elif kind < 0.9:
                    box(bl, (x, y, -0.628), (0.018, 0.012, 0.006))                         # green lamp
                else:
                    box(ba, (x, y, -0.628), (0.018, 0.012, 0.006))                         # amber lamp
    for b, nm, mat_ in ((bm, 'consoleSwitches', 'metal'), (bk, 'consoleKnobs', 'black'), (bl, 'consoleLampsG', 'lampGreen'), (ba, 'consoleLampsA', 'lampAmber')):
        outward(b)
        kit.new_object(nm, b, [mat_], smooth_angle=40)

    # ── throttles on the left console, moving with the throttle (origin on their pivot) ──
    pivot = (5.78, -0.46, -0.64)
    bm = bmesh.new()
    for dy in (-0.022, 0.022):
        box(bm, (pivot[0], pivot[1] + dy, pivot[2] - 0.07), (0.035, 0.03, 0.14), Matrix.Rotation(math.radians(-10), 3, 'Y'))
        box(bm, (pivot[0] + 0.02, pivot[1] + dy, pivot[2] - 0.15), (0.07, 0.034, 0.045))
    outward(bm)
    kit.new_object('throttles', bm, ['black'], origin=pivot, smooth_angle=30, meta=dict(kind='throttle', hinge=list(pivot), axis=[0, 1, 0]))
    bm = bmesh.new()
    box(bm, (5.78, -0.46, -0.627), (0.30, 0.09, 0.008))
    outward(bm)
    kit.new_object('throttleQuadrant', bm, ['consolePanel'], smooth_angle=30)

    # ── stick and rudder pedals ──
    pivot = (5.85, 0, -0.02)
    bm = bmesh.new()
    cylinder(bm, (pivot[0], 0, -0.06), 0.06, 0.08, 'z', 12)                      # the boot
    rod(bm, pivot, (pivot[0] - 0.02, 0, -0.44), 0.016)
    box(bm, (pivot[0] - 0.03, 0, -0.50), (0.05, 0.045, 0.13), Matrix.Rotation(math.radians(-12), 3, 'Y'))
    box(bm, (pivot[0] - 0.01, 0, -0.575), (0.06, 0.05, 0.03))
    outward(bm)
    kit.new_object('stick', bm, ['black'], origin=pivot, smooth_angle=30, meta=dict(kind='stick', hinge=list(pivot), axis=[0, 1, 0]))
    bm = bmesh.new()
    for dy in (-0.17, 0.17):
        box(bm, (6.35, dy, -0.20), (0.03, 0.10, 0.16), Matrix.Rotation(math.radians(-20), 3, 'Y'))
    outward(bm)
    kit.new_object('pedals', bm, ['metal'], smooth_angle=30)

    # ── the ACES II seat ──
    seat_x = 5.32
    rot = Matrix.Rotation(math.radians(-14), 3, 'Y')
    bm = bmesh.new()
    box(bm, (seat_x + 0.06, 0, -0.18), (0.55, 0.50, 0.55))                       # the bucket
    box(bm, (seat_x - 0.13, 0, -0.85), (0.12, 0.52, 0.85), rot)                  # the back
    box(bm, (seat_x - 0.20, 0, -1.42), (0.20, 0.46, 0.30), rot)                  # the headbox
    for dy in (-0.27, 0.27):
        box(bm, (seat_x - 0.05, dy, -0.75), (0.10, 0.04, 0.85), rot)            # side rails
    outward(bm)
    kit.new_object('seat', bm, ['seat'], smooth_angle=30)
    bm = bmesh.new()
    box(bm, (seat_x + 0.12, 0, -0.50), (0.44, 0.44, 0.08))                       # cushion on the pan
    box(bm, (seat_x - 0.06, 0, -0.85), (0.08, 0.42, 0.60), rot)                  # and on the back
    outward(bm)
    kit.new_object('seatCushion', bm, ['cushion'], smooth_angle=30)
    bm = bmesh.new()
    for dy in (-0.23, 0.23):
        rod(bm, (seat_x + 0.30, dy, -0.47), (seat_x + 0.38, dy, -0.56), 0.016, 8)   # the ejection handles
        rod(bm, (seat_x + 0.38, dy, -0.56), (seat_x + 0.28, dy, -0.62), 0.016, 8)
    outward(bm)
    kit.new_object('ejectionHandles', bm, ['yellow'], smooth_angle=40)
    bm = bmesh.new()
    for dy in (-0.12, 0.12):
        box(bm, (seat_x - 0.02, dy, -0.95), (0.03, 0.05, 0.70), rot)
    box(bm, (seat_x + 0.15, 0, -0.56), (0.30, 0.05, 0.02))
    outward(bm)
    kit.new_object('harness', bm, ['strap'], smooth_angle=30)


# ── lifting surfaces ────────────────────────────────────────────────────────
def thick(y): return 0.05 + (0.03 - 0.05) * (abs(y) - 1.35) / (SEMI - 1.35)


def wing(side):
    sname = 'L' if side < 0 else 'R'
    st = lambda y, te=None: (side * y, wing_le(y), wing_te(y) if te is None else te, thick(y), wing_z(y) - WING_Z)
    bm = surface([st(1.35), st(FLAP_IN)], WING_Z, 0.05)
    merge(bm, surface([st(y, wing_te(y) + FLAP_FRAC * chord_at(y)) for y in (FLAP_IN, 2.8, FLAP_OUT)], WING_Z, 0.05))
    merge(bm, surface([st(y, wing_te(y) + AIL_FRAC * chord_at(y)) for y in (AIL_IN, 5.0, AIL_OUT)], WING_Z, 0.04))
    # the raked tip: the trailing edge corner at 6.2 m, the leading edge running on to the full span
    tip_y = SEMI
    merge(bm, surface([st(AIL_OUT), st(6.2), (side * tip_y, wing_le(tip_y), wing_le(tip_y) - 1.05, 0.03, wing_z(tip_y) - WING_Z)], WING_Z, 0.03))
    kit.new_object(f'wing{sname}', bm, ['grey'], smooth_angle=40)
    # nav light and formation light at the tip
    bm = bmesh.new()
    vs = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.05)['verts']
    bmesh.ops.translate(bm, vec=V(wing_le(tip_y) - 0.3, side * (tip_y - 0.03), wing_z(tip_y)), verts=vs)
    kit.new_object(f'nav{sname}', bm, ['navRed' if side < 0 else 'navGreen'], smooth_angle=80)
    # flap and aileron, origin on their hinge lines
    for kind, y0, y1, frac in (('flap', FLAP_IN, FLAP_OUT, FLAP_FRAC), ('aileron', AIL_IN, AIL_OUT, AIL_FRAC)):
        h0 = wing_te(y0) + frac * chord_at(y0)
        h1 = wing_te(y1) + frac * chord_at(y1)
        hinge = (0.5 * (h0 + h1), side * 0.5 * (y0 + y1), 0.5 * (wing_z(y0) + wing_z(y1)))
        sts = [(side * y, wing_te(y) + frac * chord_at(y) - 0.015, wing_te(y), thick(y) * 0.7, wing_z(y) - WING_Z) for y in (y0 + 0.01, 0.5 * (y0 + y1), y1 - 0.01)]
        bm = surface(sts, WING_Z, 0.04)
        kit.new_object(f'{kind}{sname}', bm, ['grey'], origin=hinge, smooth_angle=40,
                       meta=dict(kind=kind, side=side, hinge=list(hinge), axis=[h1 - h0, side * (y1 - y0), wing_z(y1) - wing_z(y0)]))


def stabilators():
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        ys = (1.72, STAB_Y0, 3.1, STAB_Y1 - 0.25, STAB_Y1)
        sts = []
        for y in ys:
            c = stab_chord(y)
            le = stab_le(y)
            # the outer leading edge cut back a little: the flutter dogtooth
            if y > 3.2:
                le -= 0.12
                c -= 0.12
            sts.append((side * y, le, le - c, 0.045 if y < 3 else 0.035))
        bm = surface(sts, STAB_Z, 0.04)
        hinge = (STAB_PIVOT_X, side * 1.72, STAB_Z)
        kit.new_object(f'stab{sname}', bm, ['grey'], origin=hinge, smooth_angle=40,
                       meta=dict(kind='stabilator', side=side, hinge=list(hinge), axis=[0, 1, 0]))


def fins():
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        y = side * FIN_Y
        st = lambda z, te=None: (z, fin_le(z), (fin_le(z) - fin_chord(z)) if te is None else te)
        hinge_x = lambda z: fin_le(z) - (1 - RUD_FRAC) * fin_chord(z)
        bm = surface([st(FIN_Z0 + 0.15), st(RUD_Z0)], 0, 0.045, vertical=True, plane_y=y)
        merge(bm, surface([st(RUD_Z0, hinge_x(RUD_Z0)), st(RUD_Z1, hinge_x(RUD_Z1))], 0, 0.045, vertical=True, plane_y=y))
        merge(bm, surface([st(RUD_Z1), st(-3.0), st(FIN_Z1)], 0, 0.04, vertical=True, plane_y=y))
        # a dark band near the top: the tail's antenna fairing
        bisect_paint(bm, [((0, 0, FIN_Z1 + 0.28), (0, 0, 1))])
        for f in bm.faces:
            f.material_index = 1 if body(f.calc_center_median())[2] < FIN_Z1 + 0.28 else 0
        kit.new_object(f'fin{sname}', bm, ['grey', 'darkGrey'], smooth_angle=40)
        # the rudder: lower half of the trailing edge, origin on its hinge line
        a = (hinge_x(RUD_Z0), y, RUD_Z0)
        b = (hinge_x(RUD_Z1), y, RUD_Z1)
        hinge = tuple(0.5 * (p + q) for p, q in zip(a, b))
        sts = [(z, hinge_x(z) - 0.015, fin_le(z) - fin_chord(z), 0.03) for z in (RUD_Z0 - 0.01, 0.5 * (RUD_Z0 + RUD_Z1), RUD_Z1 + 0.01)]
        bm = surface(sts, 0, 0.03, vertical=True, plane_y=y)
        kit.new_object(f'rudder{sname}', bm, ['grey'], origin=hinge, smooth_angle=40,
                       meta=dict(kind='rudder', side=side, hinge=list(hinge), axis=[b[0] - a[0], 0, b[2] - a[2]]))


def speedbrake():
    """The big dorsal speed brake behind the canopy, hinged at its front edge."""
    st0, st1 = 8.25, 10.55
    hinge = (xb(st0), 0, fus_at(st0)[1] - 0.11)
    bm = bmesh.new()
    rings = []
    for st in (st0, 9.0, 9.8, st1):
        _, top, _, _, _ = fus_at(st)
        w = 0.40 if st < st1 else 0.36
        z0 = top - 0.11
        r = []
        for k in range(13):
            t = math.pi * k / 12
            r.append((xb(st), w * math.cos(t), z0 - 0.06 * math.sin(t) ** 0.6))
        rings.append(r)
    loft(bm, rings, close=False, cap=False)
    outward(bm)
    ob = kit.new_object('speedbrake', bm, ['grey'], origin=hinge, smooth_angle=50, meta=dict(kind='speedbrake', hinge=list(hinge), axis=[0, 1, 0]))
    ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.03


def hook():
    """The tail hook between the engines: a shank on a pivot, the hook point at its end, stowed flat under
    the aft fuselage and swung down by the sim (src/sim/aircraft/f15c.js `hook`)."""
    pivot = (xb(17.0), 0, 0.55)
    L = 1.9
    bm = bmesh.new()
    rod(bm, pivot, (pivot[0] - L + 0.12, 0, pivot[2] + 0.02), 0.045, 8)
    box(bm, (pivot[0] - L + 0.05, 0, pivot[2] + 0.06), (0.16, 0.10, 0.12))      # the hook point
    box(bm, (pivot[0] + 0.05, 0, pivot[2]), (0.16, 0.14, 0.10))                  # the pivot fitting
    outward(bm)
    kit.new_object('hook', bm, ['gearWhite'], origin=pivot, smooth_angle=40, meta=dict(kind='hook', hinge=list(pivot), axis=[0, 1, 0]))


# ── landing gear: folds forward into the fuselage ───────────────────────────
def gear():
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        hub = (MAIN['x'], side * MAIN['y'], MAIN['z'] - MAIN['r'])
        top = (MAIN['x'] + 0.15, side * 1.12, 0.55)
        bm = bmesh.new()
        rod(bm, top, (hub[0] + 0.02, side * (MAIN['y'] - MAIN['w'] / 2 - 0.05), hub[2] - 0.05), 0.09, 12)
        rod(bm, (hub[0] + 0.02, side * (MAIN['y'] - MAIN['w'] / 2 - 0.05), hub[2] - 0.05), (hub[0], side * (MAIN['y'] - 0.02), hub[2]), 0.06, 10)
        rod(bm, (top[0] - 0.55, side * 1.10, 0.62), (top[0] + 0.0, side * 1.15, 1.25), 0.04, 8)     # drag brace
        outward(bm)
        leg = f'mainLeg{sname}'
        kit.new_object(leg, bm, ['gearWhite'], origin=top, smooth_angle=40,
                       meta=dict(kind='gearLeg', gear=0 if side < 0 else 1, hinge=list(top), axis=[0, 1, 0], fold=90))
        wheel(kit, f'wheel{sname}', hub, MAIN['r'], MAIN['w'], dict(kind='wheel', gear=0 if side < 0 else 1, parent=leg))
    top = (NOSEW['x'] + 0.10, 0, 0.30)
    hub = (NOSEW['x'], 0, NOSEW['z'] - NOSEW['r'])
    bm = bmesh.new()
    rod(bm, top, (hub[0] + 0.05, 0, hub[2] - 0.35), 0.07, 12)
    for s in (-1, 1):
        rod(bm, (hub[0] + 0.05, s * 0.12, hub[2] - 0.38), (hub[0], s * 0.12, hub[2]), 0.035, 8)
    box(bm, (hub[0] + 0.05, 0, hub[2] - 0.38), (0.12, 0.30, 0.06))
    outward(bm)
    kit.new_object('noseLeg', bm, ['gearWhite'], origin=top, smooth_angle=40,
                   meta=dict(kind='gearLeg', gear=2, hinge=list(top), axis=[0, 1, 0], fold=95))
    wheel(kit, 'nosewheel', hub, NOSEW['r'], NOSEW['w'], dict(kind='steerwheel', gear=2, parent='noseLeg'))


# ── build ───────────────────────────────────────────────────────────────────
fuselage()
intakes()
engines()
canopy()
cockpit()
for s in (-1, 1):
    wing(s)
stabilators()
fins()
speedbrake()
hook()
gear()

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
out_json = args[0] if args and not args[0].startswith('--') else 'data/model/f15c.json'
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
    gz = MAIN['z'] - 0.12      # the ground under the static gear (Blender z = -body z)
    views = {
        'front34': ((14, -12, 4.5), (0.5, 0, -0.5), 40),
        'rear34': ((-17, 10, 6), (-1, 0, 0), 40),
        'side': ((1.3, -30, 0.3), (1.3, 0, 0.3), 'ortho', 21),
        'top': ((1.3, 0, 30), (1.3, 0, 0), 'ortho', 21),
        'front': ((30, 0, 0.5), (0, 0, 0.5), 'ortho', 14),
        'cockpit': (V(*EYE), V(xb(2.0), 0, -1.0), 80),
        'cockpitWide': (V(EYE[0] - 0.25, 0, EYE[2] - 0.05), V(6.6, 0, -0.75), 95),
        'canopy': ((xb(5.0), -3.5, 2.3), (xb(5.3), 0, 0.9), 40),
    }
    kit.render(args[args.index('--render') + 1], views, gz)
