# extra300l.py — the Extra 300L, modelled in Blender from numbers.
#
#   npm run model     (BPY=<python with the bpy module>, e.g. a venv with `pip install bpy`)
#   python scripts/blender/extra300l.py [out.json] [--glb out.glb] [--blend out.blend] [--render dir]
#
# Built in the flight model's body axes so everything lines up with the sim:
# x forward, y right, z down (metres from the reference point R). Blender is
# z-up, so a body point (x, y, z) is placed at Blender (x, -y, -z).
#
# Parts are separate objects; moving ones (ailerons, elevator, rudder, prop,
# wheels, sticks) have their origin on their hinge. A part with several
# materials is exported as one mesh per material (name, name-material). The
# planform, hinge lines, gear and prop positions are the sim's
# (src/sim/aircraft/extra300l.js, src/render/extraModel.js history).
#
# scripts/bake-model.mjs turns the JSON into src/render/data/extra300lModel.js.

import json
import math
import os
import sys

import bpy   # first: it brings bmesh and mathutils with it
import bmesh
from mathutils import Matrix, Vector

# ── the airplane's numbers (body axes, metres) ──────────────────────────────
TE = -1.014                                     # wing trailing edge (straight)
def chord_at(y): return 1.86 + (0.82 - 1.86) * abs(y) / 4.0
AIL_IN, AIL_OUT, AIL_FRAC = 0.95, 3.95, 0.30
WING_Z = 0.2                                    # chord plane, below R
HT_Z, HT_HINGE = -0.18, -4.18
VT_HINGE = -4.25
PROP_X = 2.05
PROP_R = 0.99
MAIN = dict(x=0.55, y=0.93, z=1.33, r=0.18)     # contact point, tyre radius
TAIL = dict(x=-4.45, z=0.42, r=0.08)
EYE = (-1.0, 0.0, -0.95)

COLORS = {
    'white': '#f3f1ec', 'red': '#c41e2a', 'dark': '#1b1d22', 'tyre': '#151515', 'metal': '#a4a7ab',
    'panel': '#2b2d31', 'gauge': '#0c0d0f', 'seat': '#1d2b52', 'strap': '#7a1a20', 'yellow': '#e9c21b',
    'navRed': '#ff2a2a', 'navGreen': '#22d25a', 'glass': '#4f6678', 'floor': '#3a3c40', 'chrome': '#d9dadc',
}


def V(x, y, z):
    """Body axes → Blender."""
    return Vector((x, -y, -z))


def body(v):
    """Blender → body axes."""
    return (v.x, -v.y, -v.z)


# ── scene ───────────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
PARTS = []   # (object, meta)

mats = {}
def mat(name):
    if name not in mats:
        m = bpy.data.materials.new(name)
        h = COLORS[name].lstrip('#')
        rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
        m.diffuse_color = (*lin, 1)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get('Principled BSDF')
        bsdf.inputs['Base Color'].default_value = (*lin, 1)
        bsdf.inputs['Roughness'].default_value = 0.35
        if name == 'glass':
            bsdf.inputs['Alpha'].default_value = 0.25
            bsdf.inputs['Roughness'].default_value = 0.02
        if name in ('metal', 'chrome'):
            bsdf.inputs['Metallic'].default_value = 1.0
        mats[name] = m
    return mats[name]


def new_object(name, bm, materials, origin=(0, 0, 0), smooth_angle=35, meta=None):
    """bmesh → object; origin given in body axes (the hinge for moving parts)."""
    me = bpy.data.meshes.new(name)
    o = V(*origin)
    bmesh.ops.translate(bm, verts=bm.verts, vec=-o)
    bm.normal_update()
    # smooth shading with sharp creases past smooth_angle
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(smooth_angle):
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(mat(m))
    ob = bpy.data.objects.new(name, me)
    ob.location = o
    scene.collection.objects.link(ob)
    PARTS.append((ob, dict(meta or {}, origin=list(origin))))
    return ob


def loft(bm, rings, close=True, cap=True):
    """Rings of body points → quads (and fan caps). Faces wound outward afterwards."""
    vs = [[bm.verts.new(V(*p)) for p in r] for r in rings]
    m = len(rings[0])
    n_around = m if close else m - 1
    faces = []
    for i in range(len(rings) - 1):
        for j in range(n_around):
            j1 = (j + 1) % m
            faces.append(bm.faces.new((vs[i][j], vs[i + 1][j], vs[i + 1][j1], vs[i][j1])))
    if cap and close:
        for r in (vs[0], vs[-1]):
            if len(set(v.co.to_tuple(5) for v in r)) > 2:
                faces.append(bm.faces.new(r))
    return vs, faces


def outward(bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)


def superellipse(cx, cz_top, cz_bot, hw, e, n):
    """A fuselage section at station x: top/bottom (body z, top negative) and half-width; points around."""
    zc = 0.5 * (cz_top + cz_bot)
    hh = 0.5 * (cz_bot - cz_top)
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        c, s = math.cos(t), math.sin(t)
        y = hw * math.copysign(abs(c) ** (2 / e), c)
        z = zc - hh * math.copysign(abs(s) ** (2 / e), s)
        pts.append((cx, y, z))
    return pts


def smooth_interp(stations, xs):
    """Catmull-Rom through station parameters (each row: x, then values) at the given x's."""
    out = []
    S = stations
    for x in xs:
        i = 0
        while i < len(S) - 2 and x < S[i + 1][0]:
            i += 1
        p0, p1, p2, p3 = S[max(i - 1, 0)], S[i], S[i + 1], S[min(i + 2, len(S) - 1)]
        t = (x - p1[0]) / (p2[0] - p1[0]) if p2[0] != p1[0] else 0
        row = [x]
        for k in range(1, len(p1)):
            a, b, c, d = p0[k], p1[k], p2[k], p3[k]
            row.append(0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3))
        out.append(row)
    return out


def bisect_paint(bm, planes):
    """Cut the mesh with vertical planes (body axes: (point, normal)) so paint edges are straight."""
    for p, nrm in planes:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=V(*p), plane_no=Vector((nrm[0], -nrm[1], -nrm[2])))


# ── fuselage: a shell with the cockpit open, red cowling and cheat line ─────
# x, top z, bottom z, half-width, squareness [est] from the three-view
FUS = [
    (2.07, -0.17, 0.15, 0.17, 2.0),
    (1.99, -0.32, 0.31, 0.32, 2.2),
    (1.82, -0.41, 0.40, 0.41, 2.5),
    (1.50, -0.47, 0.45, 0.46, 2.7),
    (1.20, -0.50, 0.47, 0.48, 2.9),
    (0.95, -0.53, 0.47, 0.49, 3.0),
    (0.40, -0.545, 0.46, 0.50, 3.0),
    (-0.40, -0.545, 0.45, 0.49, 3.0),
    (-1.20, -0.54, 0.41, 0.45, 3.0),
    (-1.95, -0.53, 0.35, 0.39, 2.9),
    (-2.70, -0.46, 0.26, 0.30, 2.7),
    (-3.40, -0.40, 0.15, 0.21, 2.5),
    (-4.05, -0.35, 0.03, 0.12, 2.3),
    (-4.58, -0.33, -0.12, 0.05, 2.0),
]
COCKPIT = dict(x0=0.93, x1=-1.93, y=0.37, z=-0.40)   # the opening in the top: canopy rail height


def fuselage():
    bm = bmesh.new()
    xs = [FUS[0][0] - (FUS[0][0] - FUS[-1][0]) * i / 70 for i in range(71)]
    # stations closer together where the shape changes fast (the cowl)
    xs = sorted(set([round(x, 4) for x in xs] + [2.05, 2.03, 2.01, 1.95, 1.9, 1.86]), reverse=True)
    rows = smooth_interp(FUS, xs)
    rings = [superellipse(x, top, bot, hw, e, 40) for x, top, bot, hw, e in rows]
    loft(bm, rings, cap=True)
    # the cockpit opening: everything above the rail between windscreen and turtle deck
    kill = [f for f in bm.faces if COCKPIT['x1'] < f.calc_center_median().x < COCKPIT['x0']
            and -f.calc_center_median().z < COCKPIT['z'] and abs(f.calc_center_median().y) < COCKPIT['y'] + 0.05]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    outward(bm)
    # paint: red cowl nose, and a red cheat line sweeping down toward the tail on both sides.
    # The mesh is cut along each paint edge first, so the edges are straight lines, not stair steps.
    def zl(x):            # the cheat line's top edge (body z) along the fuselage
        return -0.05 + 0.07 * (1.2 - x)
    W = 0.10              # its depth
    # planes z = zl(x) and z = zl(x) + W: z + 0.07x = const → normal (0.07, 0, 1)
    bisect_paint(bm, [((1.62, 0, 0), (1, 0, 0)), ((-3.9, 0, 0), (1, 0, 0)),
                      ((0, 0, zl(0)), (0.07, 0, 1)), ((0, 0, zl(0) + W), (0.07, 0, 1))])
    for f in bm.faces:
        x, y, z = body(f.calc_center_median())
        red = x > 1.62 or (-3.9 < x < 1.62 and zl(x) < z < zl(x) + W and abs(y) > 0.1)
        f.material_index = 1 if red else 0
    ob = new_object('fuselage', bm, ['white', 'red'], smooth_angle=50)
    sol = ob.modifiers.new('shell', 'SOLIDIFY')
    sol.thickness = 0.012
    sol.offset = -1
    return ob


def fuselage_interior():
    """Floor, bulkheads, and the parts of the cockpit the shell doesn't give."""
    bm = bmesh.new()
    # floor between the seats, below the hips
    for x0, x1 in ((0.9, -1.85),):
        pts = [(x0, -0.36, 0.30), (x1, -0.30, 0.30), (x1, 0.30, 0.30), (x0, 0.36, 0.30)]
        bm.faces.new([bm.verts.new(V(*p)) for p in pts])
    # bulkhead behind the rear seat, and the firewall face ahead of the front panel
    for x, hw, bot in ((-1.88, 0.37, 0.34), (1.05, 0.46, 0.45)):
        # the fuselage section there, below the canopy rail
        sec = [p for p in superellipse(x, -0.53, bot, hw, 3.0, 48) if p[2] >= COCKPIT['z']]
        bm.faces.new([bm.verts.new(V(*p)) for p in sec])
    outward(bm)
    return new_object('cockpitShell', bm, ['floor'], smooth_angle=20)


# ── canopy: one-piece bubble on a frame ──────────────────────────────────────
def canopy():
    bm = bmesh.new()
    xs = [0.93, 0.82, 0.62, 0.30, -0.10, -0.55, -1.0, -1.45, -1.75, -1.93]
    hs = [0.00, 0.12, 0.27, 0.39, 0.44, 0.45, 0.43, 0.35, 0.22, 0.04]
    ws = [0.33, 0.35, 0.37, 0.38, 0.385, 0.385, 0.38, 0.36, 0.31, 0.24]
    base = -COCKPIT['z']   # rail height (body z, negative = up)
    rings = []
    for x, h, w in zip(xs, hs, ws):
        r = []
        for k in range(25):
            t = math.pi * k / 24
            # bubble: rounder at the top, near-vertical sides at the rail
            r.append((x, w * math.cos(t), -base - h * (math.sin(t) ** 0.85)))
        rings.append(r)
    loft(bm, rings, close=False, cap=False)
    outward(bm)
    ob = new_object('canopy', bm, ['glass'], smooth_angle=80, meta=dict(transparent=True))
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.006
    # frame: the rail along both sides and the bow at the front and back
    bm = bmesh.new()
    for side in (-1, 1):
        r0 = [(x, side * (w + 0.008), -base + 0.015) for x, w in zip(xs, ws)]
        r1 = [(x, side * (w + 0.008), -base - 0.035) for x, w in zip(xs, ws)]
        r2 = [(x, side * (w - 0.03), -base - 0.035) for x, w in zip(xs, ws)]
        r3 = [(x, side * (w - 0.03), -base + 0.015) for x, w in zip(xs, ws)]
        loft(bm, list(zip(r0, r1, r2, r3)), close=True, cap=True)
    for x, h, w in ((xs[1], hs[1], ws[1]), (xs[-2], hs[-2], ws[-2])):
        ring = []
        for k in range(17):
            t = math.pi * k / 16
            ring.append((x, w * math.cos(t), -base - h * (math.sin(t) ** 0.85)))
        inner = [(x, p[1] * 0.93, -base - (-(p[2]) - base) * 0.88) for p in ring]
        for (a, b), (c, d) in zip(zip(ring, ring[1:]), zip(inner, inner[1:])):
            q = [bm.verts.new(V(*p)) for p in (a, b, d, c)]
            bm.faces.new(q)
    outward(bm)
    new_object('canopyFrame', bm, ['dark'], smooth_angle=40)


# ── cockpit ─────────────────────────────────────────────────────────────────
def box(bm, c, size, rot=None, local=(0, 0, 0)):
    """Box in body axes, centre c, size (dx, dy, dz); rot: Matrix in Blender space about c, applied after
    shifting by `local` (body axes, in the box's own unrotated frame)."""
    res = bmesh.ops.create_cube(bm, size=1.0)
    vs = res['verts']
    bmesh.ops.scale(bm, vec=Vector((size[0], size[1], size[2])), verts=vs)
    bmesh.ops.translate(bm, vec=V(*local), verts=vs)
    if rot is not None:
        bmesh.ops.rotate(bm, cent=Vector((0, 0, 0)), matrix=rot, verts=vs)
    bmesh.ops.translate(bm, vec=V(*c), verts=vs)
    return vs


def cylinder(bm, c, r, depth, axis='x', segs=20, r2=None):
    res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    vs = res['verts']
    rot = {'x': Matrix.Rotation(math.pi / 2, 3, 'Y'), 'y': Matrix.Rotation(math.pi / 2, 3, 'X'), 'z': Matrix.Identity(3)}[axis]
    bmesh.ops.rotate(bm, cent=Vector((0, 0, 0)), matrix=rot, verts=vs)
    bmesh.ops.translate(bm, vec=V(*c), verts=vs)
    return vs


def bevel(ob, width=0.015, segments=2):
    m = ob.modifiers.new('round', 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    return ob


def seat(x, name, back_h=0.62, headrest=True):
    """Bucket seat reclined ~28°, seat pan at hip height, harness lying on it."""
    bm = bmesh.new()
    pan_z = -0.13
    back_rot = Matrix.Rotation(math.radians(-28), 3, 'Y')   # lean back (top aft)
    back_c = (x - 0.16, 0, pan_z - back_h / 2)
    box(bm, (x + 0.12, 0, pan_z + 0.04), (0.42, 0.40, 0.08))                       # pan
    box(bm, back_c, (0.08, 0.40, back_h), back_rot)                                 # back
    for s_ in (-1, 1):
        box(bm, (x + 0.02, s_ * 0.215, pan_z - 0.05), (0.48, 0.035, 0.18))          # bucket sides
    if headrest:
        box(bm, back_c, (0.08, 0.22, 0.15), back_rot, local=(0, 0, -(back_h / 2 + 0.08)))
    outward(bm)
    bevel(new_object(f'{name}Seat', bm, ['seat'], smooth_angle=30), 0.018)
    # harness: shoulder straps down the back cushion's face, lap straps across the pan, a buckle
    bm = bmesh.new()
    for s_ in (-1, 1):
        box(bm, back_c, (0.008, 0.045, back_h * 0.8), back_rot, local=(0.045, s_ * 0.085, -back_h * 0.05))
        box(bm, (x + 0.15, s_ * 0.1, pan_z - 0.004), (0.24, 0.045, 0.008), Matrix.Rotation(math.radians(s_ * 18), 3, 'Z'))
    outward(bm)
    new_object(f'{name}Harness', bm, ['strap'], smooth_angle=30)
    bm = bmesh.new()
    cylinder(bm, (x + 0.26, 0, pan_z - 0.008), 0.035, 0.012, 'z', 16)
    outward(bm)
    new_object(f'{name}Buckle', bm, ['chrome'], smooth_angle=30)


def stick(x, name):
    """Control stick from the floor; origin at its pivot, rotated by the sim's elevator and aileron."""
    bm = bmesh.new()
    pivot = (x, 0, 0.27)
    cylinder(bm, (x, 0, 0.0), 0.014, 0.55, 'z', 12)          # shaft, up to z -0.27
    cylinder(bm, (x, 0, -0.33), 0.022, 0.13, 'z', 14)       # grip
    box(bm, (x, 0, 0.255), (0.12, 0.12, 0.03))              # boot base
    outward(bm)
    new_object(f'{name}Stick', bm, ['dark'], origin=pivot, smooth_angle=40,
               meta=dict(kind='stick', hinge=list(pivot), axis=[0, 1, 0]))


def pedals(x, name):
    bm = bmesh.new()
    for s in (-1, 1):
        box(bm, (x, s * 0.12, 0.12), (0.03, 0.09, 0.16), Matrix.Rotation(math.radians(-20), 3, 'Y'))
        cylinder(bm, (x - 0.05, s * 0.12, 0.25), 0.008, 0.14, 'x', 8)
    outward(bm)
    new_object(f'{name}Pedals', bm, ['metal'], smooth_angle=30)


def throttle(x, name):
    bm = bmesh.new()
    box(bm, (x, -0.33, -0.12), (0.22, 0.05, 0.06))                      # quadrant on the left wall
    box(bm, (x + 0.02, -0.29, -0.2), (0.015, 0.012, 0.14), Matrix.Rotation(math.radians(-25), 3, 'Y'))
    outward(bm)
    new_object(f'{name}Throttle', bm, ['dark'], smooth_angle=30)
    bm = bmesh.new()
    cylinder(bm, (x + 0.05, -0.29, -0.27), 0.022, 0.03, 'y', 14)
    box(bm, (x - 0.04, -0.29, -0.24), (0.012, 0.012, 0.11), Matrix.Rotation(math.radians(-25), 3, 'Y'))
    outward(bm)
    new_object(f'{name}Knobs', bm, ['red'], smooth_angle=30)


def panel(x, width, top, bottom, name, gauges, tilt=12):
    """Instrument panel face with bezels and dark dials, under a padded coaming."""
    rot = Matrix.Rotation(math.radians(tilt), 3, 'Y')   # top leaning toward the pilot
    zc = 0.5 * (top + bottom)
    bm = bmesh.new()
    box(bm, (x, 0, zc), (0.025, width, bottom - top), rot)
    outward(bm)
    bevel(new_object(f'{name}Panel', bm, ['panel'], smooth_angle=30), 0.008)
    # coaming / glare shield
    bm = bmesh.new()
    sec = []
    for k in range(13):
        t = math.pi * k / 12
        sec.append((0, width * 0.52 * math.cos(t), top - 0.05 * math.sin(t)))
    r0 = [(x + 0.02, y, z) for _, y, z in sec]
    r1 = [(x - 0.14, y * 0.98, z + 0.01) for _, y, z in sec]
    loft(bm, [r0, r1], close=False, cap=False)
    outward(bm)
    ob = new_object(f'{name}Coaming', bm, ['dark'], smooth_angle=60)
    ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.015
    # gauges: (y, z, r) on the panel face
    bm_b, bm_f = bmesh.new(), bmesh.new()
    for gy, gz, r in gauges:
        # place on the tilted face: offset from the panel centre, then rotate
        off = Vector((0, -gy, -(gz - zc)))
        p = rot @ off + V(x, 0, zc)
        px, py, pz = body(p)
        c = (px - 0.016, py, pz)
        vb = cylinder(bm_b, c, r + 0.008, 0.012, 'x', 24)
        vf = cylinder(bm_f, (c[0] - 0.003, py, pz), r, 0.012, 'x', 24)
        for vs in (vb, vf):
            bmesh.ops.rotate(bm_b if vs is vb else bm_f, cent=V(*c), matrix=rot, verts=vs)
    for b in (bm_b, bm_f):
        outward(b)
    new_object(f'{name}Bezels', bm_b, ['chrome'], smooth_angle=40)
    new_object(f'{name}Dials', bm_f, ['gauge'], smooth_angle=40)


def cockpit():
    fuselage_interior()
    # front seat (passenger / instructor) and rear seat (pilot in command when solo)
    # the front seat's back is low and has no headrest: the pilot in the rear looks over it
    seat(0.25, 'front', back_h=0.42, headrest=False)
    seat(-1.05, 'rear')
    stick(0.70, 'front')
    stick(-0.60, 'rear')
    pedals(1.05, 'front')
    pedals(-0.12, 'rear')
    throttle(0.45, 'front')
    throttle(-0.80, 'rear')
    # front panel under the windscreen: six-pack and engine stack
    six = [(-0.22, -0.46, 0.04), (-0.11, -0.46, 0.04), (0.0, -0.46, 0.04),
           (-0.22, -0.36, 0.04), (-0.11, -0.36, 0.04), (0.0, -0.36, 0.04),
           (0.13, -0.44, 0.03), (0.13, -0.37, 0.03), (0.22, -0.44, 0.022), (0.22, -0.38, 0.022), (0.22, -0.32, 0.022)]
    panel(0.90, 0.62, -0.52, -0.27, 'front', six)
    # rear panel on the front seat's back structure, in the pilot's line of sight under the canopy
    rear = [(-0.18, -0.47, 0.035), (-0.08, -0.47, 0.035), (0.02, -0.47, 0.035),
            (-0.13, -0.38, 0.03), (-0.03, -0.38, 0.03), (0.13, -0.45, 0.028), (0.13, -0.37, 0.022)]
    panel(-0.36, 0.52, -0.53, -0.32, 'rear', rear, tilt=18)


# ── lifting surfaces ────────────────────────────────────────────────────────
def naca(t, n=14):
    """Symmetric section points around (upper LE→TE then lower back), chord 0..1 from the LE, thickness ±."""
    up = []
    for k in range(n + 1):
        u = k / n
        xc = 0.5 * (1 - math.cos(math.pi * u))
        th = 5 * t * (0.2969 * math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)
        up.append((xc, th))
    lo = [(x, -h) for x, h in reversed(up[1:-1])]
    return up + lo


def surface(stations, plane_z, t, vertical=False, tip_round=0.0, n=14):
    """Lofted surface through stations [(span, xLE, xTE)]; horizontal: span = body y, chord plane z;
    vertical: span = body z (negative up), thickness along y. Optional rounded tip cap."""
    bm = bmesh.new()
    rings = []
    sec = naca(t, n)
    for s, xle, xte in stations:
        c = xle - xte
        r = []
        for xc, h in sec:
            x = xle - xc * c
            if vertical:
                r.append((x, h * c, s))
            else:
                r.append((x, s, plane_z - h * c))
        rings.append(r)
    if tip_round:
        # a few shrinking sections past the last one: a rounded tip
        s, xle, xte = stations[-1]
        sgn = 1 if s >= 0 else -1
        for k in (1, 2, 3):
            f = k / 3
            shrink = math.cos(f * math.pi / 2)
            ds = sgn * tip_round * math.sin(f * math.pi / 2)
            c = (xle - xte)
            mid = xle - 0.42 * c
            r = []
            for xc, h in sec:
                x = mid + (xle - xc * c - mid) * (0.35 + 0.65 * shrink)
                if vertical:
                    r.append((x, h * c * shrink, s + ds))
                else:
                    r.append((x, s + ds, plane_z - h * c * shrink))
            rings.append(r)
    loft(bm, rings, close=True, cap=True)
    outward(bm)
    return bm


def wing(side):
    st = [(side * y, TE + chord_at(y), TE) for y in (0.3, 0.5, AIL_IN)]
    bm = surface(st, WING_Z, 0.15)
    st2 = []
    for y in (AIL_IN, 1.6, 2.4, 3.2, AIL_OUT):
        c = chord_at(y)
        st2.append((side * y, TE + c, TE + AIL_FRAC * c))
    # past the aileron's end the wing is full chord again, then the rounded tip out to the 8.0 m span
    st2.append((side * (AIL_OUT + 0.003), TE + chord_at(AIL_OUT), TE))
    bm2 = surface(st2, WING_Z, 0.13, tip_round=4.0 - AIL_OUT - 0.003)
    # merge both into one mesh
    me_tmp = bpy.data.meshes.new('tmp')
    bm2.to_mesh(me_tmp)
    bm2.free()
    bm.from_mesh(me_tmp)
    bpy.data.meshes.remove(me_tmp)
    # paint: rays on the upper skin
    paint_rays(bm, side)
    new_object('wingL' if side < 0 else 'wingR', bm, ['white', 'red'], smooth_angle=35)
    # nav light at the tip
    bm = bmesh.new()
    vs = bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.035)['verts']
    bmesh.ops.translate(bm, vec=V(TE + 0.5 * chord_at(4.0), side * 3.975, WING_Z), verts=vs)
    new_object('navL' if side < 0 else 'navR', bm, ['navRed' if side < 0 else 'navGreen'], smooth_angle=80)


def paint_rays(bm, side):
    """Classic Extra sunburst: five red rays on the wing top fanning from the root trailing edge."""
    ox, oy = -0.6, 0.0
    rays = [math.radians(a) for a in (-62, -38, -14, 10, 34)]   # angle from the spanwise axis, + toward the tail
    half = math.radians(5.5)
    planes = []
    for a in rays:
        for e in (a - half, a + half):
            # ray direction in body (x, y): out along the span, swung aft by e
            d = (-math.sin(e), side * math.cos(e))
            planes.append(((ox, oy, 0), (-d[1], d[0], 0)))
    # cut the upper skin into ray strips (planes are vertical; the lower skin is cut too but stays white)
    bisect_paint(bm, planes)
    for f in bm.faces:
        c = f.calc_center_median()
        x, y, z = body(c)
        if f.normal.z <= 0.3 or abs(y) < 0.75:
            continue
        e = math.atan2(-(x - ox), abs(y - oy))
        if any(abs(e - a) < half for a in rays):
            f.material_index = 1


def aileron(side):
    y0, y1 = AIL_IN, AIL_OUT
    h0, h1 = TE + AIL_FRAC * chord_at(y0), TE + AIL_FRAC * chord_at(y1)
    hinge = (0.5 * (h0 + h1), side * 0.5 * (y0 + y1), WING_Z)
    st = [(side * y, TE + AIL_FRAC * chord_at(y) - 0.012, TE) for y in (y0 + 0.01, 2.0, 3.0, y1 - 0.01)]
    bm = surface(st, WING_Z, 0.13 * 0.6 / AIL_FRAC * 0.30)
    new_object('aileronL' if side < 0 else 'aileronR', bm, ['red'], origin=hinge, smooth_angle=35,
               meta=dict(kind='aileron', side=side, hinge=list(hinge), axis=[h1 - h0, side * (y1 - y0), 0]))


def tail():
    for side in (-1, 1):
        # stabiliser; its tip stops short for the elevator's horn balance
        st = [(side * 0.08, -3.55, HT_HINGE), (side * 0.8, -3.62, HT_HINGE), (side * 1.42, -3.74, HT_HINGE)]
        bm = surface(st, HT_Z, 0.12)
        new_object('stabL' if side < 0 else 'stabR', bm, ['white'], smooth_angle=35)
    # elevator: both halves, horn balances at the tips reaching ahead of the hinge
    bm = bmesh.new()
    me_tmp = bpy.data.meshes.new('tmp')
    for side in (-1, 1):
        st = [(side * 0.08, HT_HINGE - 0.01, -4.62), (side * 0.8, HT_HINGE - 0.01, -4.58), (side * 1.42, HT_HINGE - 0.01, -4.47)]
        b = surface(st, HT_Z, 0.12 * 0.7)
        b.to_mesh(me_tmp); b.free(); bm.from_mesh(me_tmp)
        horn = [(side * 1.43, -3.76, -4.47), (side * 1.55, -3.80, -4.43), (side * 1.6, -3.86, -4.40)]
        b = surface(horn, HT_Z, 0.11, tip_round=0.05)
        b.to_mesh(me_tmp); b.free(); bm.from_mesh(me_tmp)
    bpy.data.meshes.remove(me_tmp)
    for f in bm.faces:
        x, y, z = body(f.calc_center_median())
        f.material_index = 1 if abs(y) > 1.0 else 0
    hinge = (HT_HINGE, 0, HT_Z)
    new_object('elevator', bm, ['white', 'red'], origin=hinge, smooth_angle=35,
               meta=dict(kind='elevator', hinge=list(hinge), axis=[0, 1, 0]))
    # fin and rudder (span along body −z), rudder with a horn over the fin's top
    bm = surface([(-0.30, -3.55, VT_HINGE), (-0.8, -3.80, VT_HINGE), (-1.24, -3.98, VT_HINGE)], 0, 0.12, vertical=True)
    new_object('fin', bm, ['white'], smooth_angle=35)
    bm = bmesh.new()
    me_tmp = bpy.data.meshes.new('tmp')
    b = surface([(0.05, VT_HINGE - 0.01, -4.70), (-0.8, VT_HINGE - 0.01, -4.66), (-1.25, VT_HINGE - 0.01, -4.46)], 0, 0.10, vertical=True)
    b.to_mesh(me_tmp); b.free(); bm.from_mesh(me_tmp)
    b = surface([(-1.25, -3.99, -4.46), (-1.33, -4.02, -4.40), (-1.38, -4.08, -4.34)], 0, 0.10, vertical=True, tip_round=0.04)
    b.to_mesh(me_tmp); b.free(); bm.from_mesh(me_tmp)
    bpy.data.meshes.remove(me_tmp)
    for f in bm.faces:
        x, y, z = body(f.calc_center_median())
        f.material_index = 1 if z < -0.75 or x < -4.55 else 0
    hinge = (VT_HINGE, 0, -0.6)
    new_object('rudder', bm, ['white', 'red'], origin=hinge, smooth_angle=35,
               meta=dict(kind='rudder', hinge=list(hinge), axis=[0, 0, -1]))


# ── nose: spinner, prop, inlets, exhaust ────────────────────────────────────
def nose():
    bm = bmesh.new()
    rings = []
    for i in range(13):
        f = i / 12
        r = 0.175 * math.sqrt(max(0.0, 1 - f ** 2.2)) + 0.003
        x = PROP_X + 0.02 + f * 0.40
        rings.append([(x, r * math.cos(2 * math.pi * k / 32), r * math.sin(2 * math.pi * k / 32)) for k in range(32)])
    loft(bm, rings)
    outward(bm)
    new_object('spinner', bm, ['red'], smooth_angle=60)
    # MT 3-blade: paddle planform, twisted, yellow tips; origin on the crank axis at the prop plane
    hub = (PROP_X + 0.05, 0, 0)
    bm_b, bm_t = bmesh.new(), bmesh.new()
    for b in range(3):
        ang = b * 2 * math.pi / 3
        ca, sa = math.cos(ang), math.sin(ang)
        stations = [0.14, 0.22, 0.35, 0.5, 0.65, 0.8, 0.9, 0.93, PROP_R - 0.015, PROP_R]
        rings_b, rings_t = [], []
        for r in stations:
            fr = r / PROP_R
            chord = 0.075 if r < 0.2 else 0.12 + 0.07 * math.sin(math.pi * min(1, (fr - 0.15) / 0.8)) * (1 - 0.6 * max(0, fr - 0.8) / 0.2)
            if r >= PROP_R - 0.001:
                chord *= 0.45
            twist = math.radians(18 + 26 * (0.75 / max(fr, 0.2) - 1) * 0.5)
            th = 0.022 if r < 0.25 else 0.014 * (1 - 0.5 * fr)
            sect = []
            for xc, h in naca(0.12, 6):
                c = (0.35 - xc) * chord
                t = h / 0.12 * th
                xb = math.sin(twist) * c + math.cos(twist) * t       # along the crank axis
                tb = math.cos(twist) * c - math.sin(twist) * t       # tangential
                sect.append((PROP_X + 0.05 + xb, ca * r - sa * tb, sa * r + ca * tb))
            (rings_t if fr >= 0.9 else rings_b).append(sect)
        # blade: hub to 90 % radius in black, the tip in yellow (shared section at 0.9)
        loft(bm_b, rings_b)
        loft(bm_t, [rings_b[-1]] + rings_t)
    for b in (bm_b, bm_t):
        outward(b)
    meta = dict(kind='prop', hinge=list(hub), axis=[1, 0, 0])
    new_object('prop', bm_b, ['dark'], origin=hub, smooth_angle=50, meta=meta)
    new_object('propTips', bm_t, ['yellow'], origin=hub, smooth_angle=50, meta=dict(meta))
    # cooling inlets either side of the spinner, oil cooler scoop below, exhaust
    bm = bmesh.new()
    for s in (-1, 1):
        cylinder(bm, (2.0, s * 0.255, 0.04), 0.075, 0.06, 'x', 20)
    box(bm, (1.55, 0, 0.47), (0.35, 0.18, 0.06))
    outward(bm)
    new_object('inlets', bm, ['gauge'], smooth_angle=40)
    bm = bmesh.new()
    cylinder(bm, (1.25, 0.12, 0.50), 0.045, 0.30, 'x', 16)
    outward(bm)
    new_object('exhaust', bm, ['metal'], smooth_angle=40)


# ── landing gear ────────────────────────────────────────────────────────────
def gear():
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        hub = (MAIN['x'], side * MAIN['y'], MAIN['z'] - MAIN['r'])
        # spring leg: a flat tapered blade from the fuselage side to the axle
        bm = bmesh.new()
        top = (0.62, side * 0.36, 0.40)
        bot = (hub[0], side * (MAIN['y'] - 0.07), hub[2])
        rings = []
        for f in (0.0, 0.25, 0.5, 0.75, 1.0):
            x = top[0] + (bot[0] - top[0]) * f
            y = top[1] + (bot[1] - top[1]) * f
            z = top[2] + (bot[2] - top[2]) * f
            w, t = 0.11 - 0.05 * f, 0.03 - 0.008 * f
            rings.append([(x + w, y, z - t), (x - w, y, z - t * 0.6), (x - w, y, z + t * 0.6), (x + w, y, z + t)])
        loft(bm, rings)
        outward(bm)
        new_object(f'leg{sname}', bm, ['white'], smooth_angle=30)
        # wheel pant: a teardrop around the wheel, red
        bm = bmesh.new()
        xs = [0.44, 0.36, 0.22, 0.05, -0.12, -0.30, -0.44, -0.52]
        hs = [0.02, 0.12, 0.19, 0.22, 0.21, 0.16, 0.08, 0.015]
        ws = [0.02, 0.08, 0.115, 0.125, 0.12, 0.095, 0.05, 0.01]
        rings = [superellipse(hub[0] + x, hub[2] - 0.02 - h, hub[2] - 0.02 + h * 0.75, w, 2.3, 24) for x, h, w in zip(xs, hs, ws)]
        rings = [[(p[0], p[1] + hub[1], p[2]) for p in r] for r in rings]
        loft(bm, rings)
        # open the bottom where the tyre comes through
        kill = [f for f in bm.faces if body(f.calc_center_median())[2] > hub[2] + 0.06 and abs(body(f.calc_center_median())[0] - hub[0]) < 0.2]
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        outward(bm)
        ob = new_object(f'pant{sname}', bm, ['red'], smooth_angle=50)
        ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.008
        # wheel: tyre torus-ish profile and a hub; origin on the axle
        wheel(f'wheel{sname}', hub, MAIN['r'], 0.11, dict(kind='wheel', gear=0 if side < 0 else 1))
    # tailwheel: spring, fork, wheel
    th = (TAIL['x'], 0, TAIL['z'] - TAIL['r'])
    bm = bmesh.new()
    rings = []
    for f in (0.0, 0.5, 1.0):
        x = -4.12 + (th[0] + 0.04 - -4.12) * f
        z = 0.04 + (th[2] - 0.05 - 0.04) * f
        rings.append([(x + 0.02, -0.025, z), (x - 0.02, -0.025, z), (x - 0.02, 0.025, z), (x + 0.02, 0.025, z)])
    loft(bm, rings)
    outward(bm)
    new_object('tailSpring', bm, ['dark'], smooth_angle=30)
    wheel('tailwheel', th, TAIL['r'], 0.05, dict(kind='tailwheel', gear=2))


def wheel(name, hub, r, w, meta):
    bm = bmesh.new()
    prof = [(0.70, -0.5), (0.86, -0.5), (0.97, -0.38), (1.0, 0.0), (0.97, 0.38), (0.86, 0.5), (0.70, 0.5)]
    rings = []
    for rf, yf in prof:
        rings.append([(hub[0] + r * rf * math.cos(2 * math.pi * k / 28), hub[1] + yf * w, hub[2] + r * rf * math.sin(2 * math.pi * k / 28)) for k in range(28)])
    loft(bm, rings)
    outward(bm)
    m = dict(meta, hinge=list(hub), axis=[0, 1, 0])
    new_object(name, bm, ['tyre'], origin=hub, smooth_angle=45, meta=m)
    bm = bmesh.new()
    cylinder(bm, hub, r * 0.7, w * 0.95, 'y', 20)
    cylinder(bm, hub, r * 0.25, w * 1.25, 'y', 12)
    outward(bm)
    new_object(name + 'Hub', bm, ['metal'], origin=hub, smooth_angle=45, meta=dict(m))


# ── build ───────────────────────────────────────────────────────────────────
fuselage()
canopy()
cockpit()
for s in (-1, 1):
    wing(s)
    aileron(s)
tail()
nose()
gear()


# ── export ──────────────────────────────────────────────────────────────────
def export(path):
    deps = bpy.context.evaluated_depsgraph_get()
    out = []
    for ob, meta in PARTS:
        ev = ob.evaluated_get(deps)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        cn = me.corner_normals
        by_mat = {}
        for tri in me.loop_triangles:
            by_mat.setdefault(tri.material_index, []).append(tri)
        for mi, tris in sorted(by_mat.items()):
            mname = me.materials[mi].name if me.materials else 'white'
            verts, index, idx = [], {}, []
            for tri in tris:
                for li in tri.loops:
                    v = me.vertices[me.loops[li].vertex_index].co
                    n = cn[li].vector
                    key = (round(v.x, 4), round(v.y, 4), round(v.z, 4), round(n.x, 2), round(n.y, 2), round(n.z, 2))
                    if key not in index:
                        index[key] = len(verts)
                        verts.append((body(v), body(n)))
                    idx.append(index[key])
            base_mat = ob.data.materials[0].name if ob.data.materials else mname
            name = ob.name if mi == 0 or mname == base_mat else f'{ob.name}-{mname}'
            part = dict(name=name, color=COLORS[mname], material=mname,
                        positions=[round(c, 5) for p, _ in verts for c in p],
                        normals=[round(c, 4) for _, n in verts for c in n],
                        indices=idx)
            for k in ('kind', 'hinge', 'axis', 'side', 'gear', 'transparent'):
                if k in meta:
                    part[k] = meta[k]
            out.append(part)
        ev.to_mesh_clear()
    with open(path, 'w') as f:
        json.dump(dict(eye=EYE, parts=out), f)
    tris = sum(len(p['indices']) // 3 for p in out)
    print(f'exported {len(out)} parts, {tris} triangles → {path}')


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.render.resolution_x, scene.render.resolution_y = 960, 540
    world = bpy.data.worlds.new('sky')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.7, 0.9, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    scene.world = world
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(40), math.radians(15), math.radians(-35))
    scene.collection.objects.link(sun)
    # ground
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    bmesh.ops.translate(bm, vec=Vector((0, 0, -1.33)), verts=bm.verts)
    me = bpy.data.meshes.new('ground'); bm.to_mesh(me)
    g = bpy.data.objects.new('ground', me); scene.collection.objects.link(g)
    me.materials.append(mat('floor'))
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = {
        'front34': ((6.5, -6.5, 1.6), (0, 0, 0.0), 40),
        'rear34': ((-8.0, 5.0, 3.0), (-1, 0, 0), 40),
        'side': ((0.0, -12.0, 0.3), (-1.2, 0, 0.1), 40),
        'top': ((-0.5, 0.0, 14.0), (-0.5, 0, 0), 45),
        'cockpit': (V(*EYE), V(2.0, 0, -0.75), 85),
        'cockpitTop': ((-0.3, -1.6, 2.3), (-0.3, 0, 0.0), 50),
    }
    for name, (eye, at, fov) in views.items():
        cam.location = Vector(eye)
        d = Vector(at) - Vector(eye)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cam.data.angle = math.radians(fov)
        canopy_ob = bpy.data.objects.get('canopy')
        if canopy_ob:
            canopy_ob.hide_render = name.startswith('cockpit')
        scene.render.filepath = os.path.join(outdir, f'{name}.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scene.render.filepath)


args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
out_json = args[0] if args and not args[0].startswith('--') else 'data/model/extra300l.json'
os.makedirs(os.path.dirname(out_json) or '.', exist_ok=True)
export(out_json)
if '--glb' in args:
    p = args[args.index('--glb') + 1]
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', export_apply=True)
    print('glb →', p)
if '--blend' in args:
    p = os.path.abspath(args[args.index('--blend') + 1])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=p)
    print('blend →', p)
if '--render' in args:
    render(args[args.index('--render') + 1])
