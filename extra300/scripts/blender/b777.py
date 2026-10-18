# b777.py — the Boeing 777-300ER, modelled in Blender from numbers.
#
#   npm run model:b777   (BPY=<python with the bpy module>)
#   python scripts/blender/b777.py [out.json] [--glb out.glb] [--blend out.blend] [--render dir]
#
# Published dimensions (73.86 m long, 64.80 m span with the raked tips, 18.5 m high, a 6.20 m
# fuselage, 436.8 m² of wing, 21.5 m tailplane, two GE90-115B, six-wheel main bogies 10.97 m apart,
# a 31.22 m wheelbase) and the proportions of the three-view, in the flight model's body axes: the
# planform, the tails, the gear and the eye point are those of src/sim/aircraft/b777.js (x forward,
# y right, z down, metres from R at the wing's quarter MAC, 35.0 m behind the nose). Moving parts
# have their origin on their hinge; the main legs fold inward, the nose leg forward, the wheels ride
# on them (meta `parent`). Boeing's house colours: white over a grey belly, a blue fin.
#
# scripts/bake-model.mjs turns the JSON into src/render/data/b777Model.js.

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import Kit, V, body, loft, outward, superellipse, smooth_interp, bisect_paint, box, cylinder, rod, surface, merge, wheel  # noqa: E402
import bmesh  # noqa: E402  (after kit, which imports bpy first)
from mathutils import Matrix  # noqa: E402

R_ST = 34.9985828398437                      # R's station (m aft of the nose): the wing's quarter MAC
def xb(st): return R_ST - st                 # station → body x

# ── the airplane's numbers (as src/sim/aircraft/b777.js) ─────────────────────
T335 = math.tan(math.radians(33.5))
SEMI = 32.4
def wing_le(y):
    y = abs(y)
    return 25.0 + y * T335 if y <= 29.5 else 25.0 + 29.5 * T335 + (y - 29.5) * 1.28
def wing_te(y):
    y = abs(y)
    if y <= 10:
        return 39.0 + y * 0.12
    if y <= 29.5:
        return 40.2 + (y - 10) * (7.23 / 19.5)
    return 47.43 + (y - 29.5) * (1.57 / 2.9)
def chord(y): return wing_te(y) - wing_le(y)
WZ0, DIH = 2.2, math.radians(6)
def wing_z(y): return WZ0 - abs(y) * math.tan(DIH)
def wing_t(y): return 0.13 + (0.09 - 0.13) * min(1, abs(y) / 29.5)
FLAP_IN, FLAP_MID, FLAP_OUT, FLAP_FRAC = 3.2, 10.0, 21.0, 0.3
AIL_IN, AIL_OUT, AIL_FRAC = 21.0, 29.5, 0.22

HT = dict(le0=61.8, root=7.6, tip=2.4, semi=10.75, sweep=math.radians(38), z0=-0.6, dih=math.radians(7), frac=0.33)
def ht_le(y): return HT['le0'] + abs(y) * math.tan(HT['sweep'])
def ht_chord(y): return HT['root'] + (HT['tip'] - HT['root']) * abs(y) / HT['semi']
def ht_z(y): return HT['z0'] - abs(y) * math.tan(HT['dih'])

VT = dict(le0=60.5, root=8.0, tip=3.0, z0=-2.9, z1=-13.4, sweep=math.radians(41), frac=0.33)
def vt_le(z): return VT['le0'] + (VT['z0'] - z) * math.tan(VT['sweep'])
def vt_chord(z): return VT['root'] + (VT['tip'] - VT['root']) * (z - VT['z0']) / (VT['z1'] - VT['z0'])

CONTACT_Z = 5.2
MAIN = dict(x=-2.0, y=5.485, axle=1.45, r=0.635, w=0.5, pair=1.40)
NOSEG = dict(x=29.21858283984370, r=0.545, w=0.44, pair=0.86)
ENG = dict(y=9.6, z=2.45)
EYE = (xb(3.55), -0.53, -0.82)

COLORS = {
    'white': '#f2f3f4', 'belly': '#a9afb6', 'blue': '#1d4f9c', 'wingGrey': '#b9bec4', 'metal': '#a7abb0',
    'nacelle': '#eef0f2', 'fan': '#202326', 'spinner': '#9aa0a6', 'black': '#151618', 'glass': '#3d4a55',
    'tyre': '#151515', 'gearGrey': '#bfc3c7', 'navRed': '#ff2a2a', 'navGreen': '#22d25a', 'beacon': '#ff3b30',
    'window': '#20262d', 'door': '#d4d7da', 'cockpit': '#2b2e33', 'panel': '#1a1c1f', 'seat': '#3a3f47',
    'screenBlue': '#1e4c8f', 'screenGreen': '#14522f', 'key': '#6f7276', 'lampAmber': '#ffb238', 'floor': '#3a3c40',
    'exhaust': '#3b3734',
}

kit = Kit(COLORS)


# ── fuselage ────────────────────────────────────────────────────────────────
# station, top z, bottom z, half-width, squareness — the three-view's side and top views
FUS = [
    (0.00, 0.18, 0.32, 0.02, 2.0),
    (0.30, -0.35, 0.95, 0.70, 2.0),
    (0.80, -0.62, 1.55, 1.15, 2.0),
    (1.60, -1.00, 2.15, 1.70, 2.0),
    (2.60, -1.55, 2.65, 2.20, 2.0),
    (3.80, -2.15, 2.95, 2.60, 2.05),
    (5.20, -2.65, 3.10, 2.88, 2.1),
    (7.00, -3.00, 3.18, 3.05, 2.1),
    (9.50, -3.15, 3.20, 3.10, 2.1),
    (52.0, -3.15, 3.20, 3.10, 2.1),
    (56.0, -3.10, 2.80, 3.02, 2.1),
    (60.0, -2.95, 2.05, 2.75, 2.1),
    (64.0, -2.70, 1.20, 2.35, 2.1),
    (68.0, -2.30, 0.30, 1.75, 2.1),
    (71.5, -1.85, -0.50, 1.05, 2.1),
    (73.3, -1.55, -1.00, 0.45, 2.1),
    (73.86, -1.35, -1.15, 0.10, 2.0),
]
LENGTH = 73.86


def fus_at(st):
    rows = [(-r[0],) + r[1:] for r in FUS]
    return smooth_interp(rows, [-st])[0]


def skin_y(st, z):
    """Where the skin is at station st and height z (its half-width there), or None above/below it."""
    _, top, bot, hw, e = fus_at(st)
    zc, hh = 0.5 * (top + bot), 0.5 * (bot - top)
    u = abs((zc - z) / hh)
    if u >= 1:
        return None
    return hw * (1 - u ** e) ** (1 / e)


# ── the windscreen: six flat panes, as the 777 has them [three-view, photographs] ──
# each side: the big front pane against the centre post on the crown, the sliding side window, the
# small rear one whose top slopes down aft. Corners as (station, height z); the outer ones sit on the
# skin, the front pane's inner edge on the crown beside the centre post.
CROWN = 'crown'
PANES = [
    # front: inner-forward (on the crown), inner-aft (on the crown), outer-aft-top, outer-forward-bottom
    [(1.22, CROWN), (2.06, CROWN), (2.27, -1.20), (1.95, -0.40)],
    # the sliding side window
    [(2.37, -0.44), (2.43, -1.24), (3.14, -1.42), (3.08, -0.51)],
    # the rear side window
    [(3.24, -0.52), (3.28, -1.43), (3.98, -1.18), (3.93, -0.58)],
]
POST_HALF = 0.07          # the centre post's half-width on the crown


def pane_points(side):
    """The panes' corners in body axes for one side (side = -1 left, +1 right)."""
    out = []
    for pane in PANES:
        pts = []
        for st, z in pane:
            if z == CROWN:
                _, top, _, _, _ = fus_at(st)
                zz = top + 0.004
                pts.append((xb(st), side * POST_HALF, zz))
            else:
                pts.append((xb(st), side * skin_y(st, z), z))
        out.append(pts)
    return out


def _sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def _dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def _cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def _norm(a):
    l = math.sqrt(_dot(a, a)) or 1
    return (a[0] / l, a[1] / l, a[2] / l)


def pane_frames():
    """Each pane's plane and its corners in its own 2D coordinates (u, v), for the cut and the paint."""
    frames = []
    for side in (-1, 1):
        for pts in pane_points(side):
            o = tuple(sum(p[k] for p in pts) / 4 for k in range(3))
            n = _norm(_cross(_sub(pts[2], pts[0]), _sub(pts[3], pts[1])))
            u = _norm(_sub(pts[1], pts[0]))
            v = _cross(n, u)
            poly = [(_dot(_sub(p, o), u), _dot(_sub(p, o), v)) for p in pts]
            fr = dict(o=o, n=n, u=u, v=v, poly=poly, pts=pts)
            fr['planes'] = edge_planes(fr)
            # the surround's corners chamfered: a plane across each, square to the corner's bisector
            pl = fr['planes']
            fr['corners'] = []
            for k in range(len(pl)):
                c = pl[k][0]
                m = _norm(tuple(pl[k][1][i] + pl[k - 1][1][i] for i in range(3)))
                fr['corners'].append((c, m))
            frames.append(fr)
    return frames


def _poly_dist(poly, x, y):
    """Signed distance to a convex polygon: negative inside."""
    inside, best = True, 1e9
    m = len(poly)
    area = sum(poly[i][0] * poly[(i + 1) % m][1] - poly[(i + 1) % m][0] * poly[i][1] for i in range(m))
    sgn = 1 if area > 0 else -1
    for i in range(m):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % m]
        ex, ey = bx - ax, by - ay
        l2 = ex * ex + ey * ey or 1
        t = max(0, min(1, ((x - ax) * ex + (y - ay) * ey) / l2))
        d = math.hypot(x - ax - t * ex, y - ay - t * ey)
        best = min(best, d)
        if sgn * (ex * (y - ay) - ey * (x - ax)) < 0:
            inside = False
    return -best if inside else best


SURROUND = 0.15          # the black paint round the panes (m)


def edge_planes(f):
    """A pane's edges as planes square to it: (a point on the edge, the normal pointing away from the pane)."""
    pts, out = f['pts'], []
    for a, b in zip(pts, pts[1:] + pts[:1]):
        e = _norm(_sub(b, a))
        n = _norm(_cross(e, f['n']))
        if _dot(_sub(f['o'], a), n) > 0:
            n = (-n[0], -n[1], -n[2])
        out.append((a, n))
    return out


def window_class(p, frames):
    """0: skin, 1: cut away (a pane's opening), 2: the black surround round a pane — by the very planes the
    skin was cut along (cut_along_panes), so every face lies wholly on one side of each."""
    best = 0
    for f in frames:
        if abs(_dot(_sub(p, f['o']), f['n'])) > 1.0:
            continue
        ds = [_dot(_sub(p, a), n) for a, n in f['planes']]
        if max(ds) < 0:
            return 1
        if max(ds) < SURROUND and max(_dot(_sub(p, c), m) for c, m in f['corners']) < SURROUND:
            best = 2
    return best


def cut_along_panes(bm, frames):
    """Split the nose's skin exactly along each pane's edges and the surround's outline round it: planes
    through each edge, square to the pane (only the flight deck's stretch of skin is cut)."""
    for f in frames:
        for a, n in f['planes']:
            for off in (0.0, SURROUND):
                co = (a[0] + n[0] * off, a[1] + n[1] * off, a[2] + n[2] * off)
                near = [g for g in list(bm.verts) + list(bm.edges) + list(bm.faces)
                        if (g.co if hasattr(g, 'co') else g.verts[0].co).x > xb(5.0)]
                bmesh.ops.bisect_plane(bm, geom=near, plane_co=V(*co), plane_no=V(*n))
        for c, m in f['corners']:
            co = (c[0] + m[0] * SURROUND, c[1] + m[1] * SURROUND, c[2] + m[2] * SURROUND)
            near = [g for g in list(bm.verts) + list(bm.edges) + list(bm.faces)
                    if (g.co if hasattr(g, 'co') else g.verts[0].co).x > xb(5.0)]
            bmesh.ops.bisect_plane(bm, geom=near, plane_co=V(*co), plane_no=V(*m))


NOSE_END = 5.6           # the nose's dense stretch (the windscreen cut in it) ends here


def fuselage_rings(around=64, nose=True):
    # dense round the flight deck, so the panes' openings are cut cleanly; plainer behind it
    if nose:
        sts = [i * 0.05 for i in range(13)] + [0.6 + i * 0.2 for i in range(int((NOSE_END - 0.6) / 0.2) + 1)] + [NOSE_END]
    else:
        # the taper behind the flight deck, the long constant barrel, the tail cone's upsweep
        sts = ([NOSE_END + i * 0.5 for i in range(int((9.5 - NOSE_END) / 0.5) + 1)] + [9.5 + i * 2.5 for i in range(18)]
               + [52.0 + i * 0.6 for i in range(int((LENGTH - 52.0) / 0.6) + 1)] + [LENGTH])
    sts = sorted(set(round(s, 4) for s in sts if s <= LENGTH))
    rings = []
    for st in sts:
        _, top, bot, hw, e = fus_at(st)
        rings.append([(xb(st), y, z) for _, y, z in superellipse(0, top, bot, max(hw, 0.004), e, around)])
    return rings


def fuselage():
    frames = pane_frames()
    # the cabin behind the flight deck: 64 round (every other one of the nose's 128 points, so they meet)
    bm = bmesh.new()
    loft(bm, fuselage_rings(64, nose=False), cap=True)
    bisect_paint(bm, [((0, 0, 1.55), (0, 0, 1))])
    outward(bm)
    for f in bm.faces:
        f.material_index = 1 if body(f.calc_center_median())[2] > 1.55 else 0
    kit.new_object('fuselage', bm, ['white', 'belly'], smooth_angle=60)
    bm = bmesh.new()
    loft(bm, fuselage_rings(128, nose=True), cap=True)
    # (its open end at NOSE_END has a cap: drop it, the cabin carries on there)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if len(f.verts) > 4 and abs(body(f.calc_center_median())[0] - xb(NOSE_END)) < 0.01], context='FACES')
    bisect_paint(bm, [((0, 0, 1.55), (0, 0, 1))])
    cut_along_panes(bm, frames)
    cls = {f: window_class(body(f.calc_center_median()), frames) for f in bm.faces}
    bmesh.ops.delete(bm, geom=[f for f, c in cls.items() if c == 1], context='FACES')
    outward(bm)
    for f in bm.faces:
        x, y, z = body(f.calc_center_median())
        f.material_index = 2 if cls.get(f) == 2 else 1 if z > 1.55 else 0
    kit.new_object('fuselageNose', bm, ['white', 'belly', 'black'], smooth_angle=60)
    # the glass: flat panes on their corners (hidden from the flight deck's own eye)
    bm = bmesh.new()
    for f in frames:
        vs = [bm.verts.new(V(*p)) for p in f['pts']]
        bm.faces.new(vs)
    outward(bm)
    ob = kit.new_object('windscreen', bm, ['glass'], smooth_angle=10, meta=dict(transparent=True))
    ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.02
    # the frames: straight round each pane, and the centre post along the crown
    bm = bmesh.new()
    for f in frames:
        pts = f['pts']
        for a, b in zip(pts, pts[1:] + pts[:1]):
            rod(bm, a, b, 0.055, 8)
    post = []
    for k in range(9):
        st = 1.22 + (2.12 - 1.22) * k / 8
        post.append((xb(st), 0, fus_at(st)[1] + 0.01))
    for a, b in zip(post, post[1:]):
        box(bm, ((a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2), (abs(a[0] - b[0]) + 0.02, 2 * POST_HALF, 0.06),
            Matrix.Rotation(math.atan2(b[2] - a[2], a[0] - b[0]), 3, 'Y'))
    outward(bm)
    kit.new_object('windscreenFrame', bm, ['black'], smooth_angle=40)
    # wipers parked at the front panes' foot
    bm = bmesh.new()
    for side in (-1, 1):
        a = pane_points(side)[0][3]
        b = pane_points(side)[0][0]
        m = tuple(a[k] + (b[k] - a[k]) * 0.35 for k in range(3))
        rod(bm, a, (m[0] + 0.05, m[1], m[2] - 0.03), 0.018, 6)
    outward(bm)
    kit.new_object('wipers', bm, ['black'], smooth_angle=40)


def cabin_windows():
    """The passenger windows down both sides, gaps at the five doors; the doors' outlines."""
    doors = [(7.6, 'L1'), (19.4, 'L2'), (34.5, 'L3'), (47.6, 'L4'), (63.2, 'L5')]
    zc = -0.65
    bm = bmesh.new()
    st = 9.0
    while st < 66.5:
        if all(abs(st - d) > 1.2 for d, _ in doors):
            for side in (-1, 1):
                y = skin_y(st, zc)
                if y is None or y < 1.0:
                    continue
                box(bm, (xb(st), side * (y + 0.004), zc), (0.26, 0.03, 0.38))
        st += 0.535
    outward(bm)
    kit.new_object('cabinWindows', bm, ['window'], smooth_angle=30)
    # the doors: a thin outline a shade off white, a little window in each
    bm, bw = bmesh.new(), bmesh.new()
    for d, _ in doors:
        for side in (-1, 1):
            for x0, x1, z0, z1 in ((d - 0.55, d + 0.55, -1.25, -1.20), (d - 0.55, d + 0.55, 0.62, 0.67), (d - 0.57, d - 0.52, -1.25, 0.67), (d + 0.52, d + 0.57, -1.25, 0.67)):
                zm = 0.5 * (z0 + z1)
                y = skin_y(0.5 * (x0 + x1), zm)
                if y is None:
                    continue
                box(bm, (xb(0.5 * (x0 + x1)), side * (y + 0.004), zm), (x1 - x0, 0.03, z1 - z0))
            y = skin_y(d, zc)
            box(bw, (xb(d), side * (y + 0.006), zc), (0.22, 0.03, 0.30))
    outward(bm); outward(bw)
    kit.new_object('doorOutlines', bm, ['door'], smooth_angle=30)
    kit.new_object('doorWindows', bw, ['window'], smooth_angle=30)


def belly_fairing():
    """The wing-to-body fairing under the centre section, the wheel wells in it."""
    bm = bmesh.new()
    rings = []
    for st, depth, hw in ((21.0, 0.0, 1.0), (24.0, 0.35, 2.4), (28.0, 0.55, 3.2), (34.0, 0.62, 3.35), (40.0, 0.58, 3.3), (45.0, 0.40, 2.8), (49.0, 0.0, 1.6)):
        _, top, bot, _, _ = fus_at(st)
        rings.append(superellipse(xb(st), bot - 1.6, bot + depth, hw, 2.6, 32))
    loft(bm, rings, cap=True)
    outward(bm)
    kit.new_object('bellyFairing', bm, ['belly'], smooth_angle=50)


# ── the flight deck ─────────────────────────────────────────────────────────
def flight_deck():
    """Glareshield over the six big displays, the pedestal with the thrust levers, two seats, two control
    columns, the overhead panel; a dark tub round it all."""
    fz = 0.30                                             # the floor
    bm = bmesh.new()
    box(bm, (xb(2.3), 0, fz + 0.03), (3.2, 2.6, 0.06))    # floor
    box(bm, (xb(5.0), 0, -1.0), (0.06, 3.0, 2.3))         # the bulkhead behind the seats
    for s in (-1, 1):
        box(bm, (xb(3.4), s * 1.6, -0.06), (3.0, 0.06, 0.72))   # side walls up to the windows' sill
    outward(bm)
    kit.new_object('deckTub', bm, ['cockpit'], smooth_angle=30)
    # the main panel and the glareshield over it
    tilt = Matrix.Rotation(math.radians(-12), 3, 'Y')
    bm = bmesh.new()
    box(bm, (xb(1.80), 0, -0.05), (0.10, 2.2, 0.62), tilt)
    box(bm, (xb(1.62), 0, -0.40), (0.45, 1.9, 0.08))
    outward(bm)
    kit.new_object('mainPanel', bm, ['panel'], smooth_angle=30)
    bm, bg = bmesh.new(), bmesh.new()
    for i, yc in enumerate((-0.95, -0.55, -0.16, 0.16, 0.55, 0.95)):
        box(bm if i in (0, 1, 4, 5) else bg, (xb(1.86), yc, -0.07), (0.01, 0.30, 0.30), tilt)
    outward(bm); outward(bg)
    kit.new_object('screenPrimary', bm, ['screenBlue'], smooth_angle=30)
    kit.new_object('screenEicas', bg, ['screenGreen'], smooth_angle=30)
    # the pedestal, its thrust levers (origin on their pivot), its keypads
    bm = bmesh.new()
    box(bm, (xb(2.55), 0, 0.12), (1.1, 0.42, 0.34))
    outward(bm)
    kit.new_object('pedestal', bm, ['panel'], smooth_angle=30)
    pivot = (xb(2.3), 0, -0.06)
    bm = bmesh.new()
    for dy in (-0.07, 0.07):
        box(bm, (pivot[0], dy, pivot[2] - 0.12), (0.04, 0.03, 0.24), Matrix.Rotation(math.radians(-15), 3, 'Y'))
        box(bm, (pivot[0] + 0.03, dy, pivot[2] - 0.25), (0.08, 0.06, 0.045))
    outward(bm)
    kit.new_object('thrustLevers', bm, ['black'], origin=pivot, smooth_angle=30, meta=dict(kind='throttle', hinge=list(pivot), axis=[0, 1, 0]))
    bm = bmesh.new()
    for s in (-1, 1):
        for r in range(3):
            for c in range(4):
                box(bm, (xb(2.85) + r * 0.05, s * (0.08 + c * 0.04), -0.055), (0.03, 0.03, 0.01))
    outward(bm)
    kit.new_object('pedestalKeys', bm, ['key'], smooth_angle=30)
    # the overhead panel
    bm = bmesh.new()
    box(bm, (xb(3.95), 0, -1.86), (1.3, 0.9, 0.08), Matrix.Rotation(math.radians(8), 3, 'Y'))
    outward(bm)
    kit.new_object('overhead', bm, ['panel'], smooth_angle=30)
    bm = bmesh.new()
    for r in range(8):
        for c in range(7):
            box(bm, (xb(3.42 + r * 0.14), -0.36 + c * 0.12, -1.81 + r * 0.02), (0.03, 0.05, 0.012))
    outward(bm)
    kit.new_object('overheadLamps', bm, ['lampAmber'], smooth_angle=30)
    # two seats
    for s in (-1, 1):
        sx = xb(4.0)
        bm = bmesh.new()
        box(bm, (sx, s * 0.53, fz - 0.42), (0.55, 0.55, 0.12))
        box(bm, (sx - 0.30, s * 0.53, fz - 0.95), (0.12, 0.55, 0.95), Matrix.Rotation(math.radians(-10), 3, 'Y'))
        box(bm, (sx - 0.34, s * 0.53, fz - 1.52), (0.14, 0.30, 0.26), Matrix.Rotation(math.radians(-10), 3, 'Y'))
        box(bm, (sx, s * 0.53, fz - 0.18), (0.3, 0.3, 0.36))
        outward(bm)
        kit.new_object('seatL' if s < 0 else 'seatR', bm, ['seat'], smooth_angle=30)
    # the control columns and their wheels, moving with the controls (origin at their foot)
    for s in (-1, 1):
        pivot = (xb(2.75), s * 0.53, fz)
        bm = bmesh.new()
        rod(bm, pivot, (pivot[0] + 0.05, s * 0.53, -0.62), 0.035, 10)
        box(bm, (pivot[0] + 0.03, s * 0.53, -0.66), (0.05, 0.36, 0.05))
        for dy in (-0.17, 0.17):
            box(bm, (pivot[0] + 0.03, s * 0.53 + dy, -0.74), (0.05, 0.04, 0.16))
        outward(bm)
        kit.new_object('yokeL' if s < 0 else 'yokeR', bm, ['black'], origin=pivot, smooth_angle=30, meta=dict(kind='stick', hinge=list(pivot), axis=[0, 1, 0]))


# ── wings ───────────────────────────────────────────────────────────────────
def wing(side):
    sname = 'L' if side < 0 else 'R'
    st = lambda y, te=None: (side * y, xb(wing_le(y)), xb(wing_te(y)) if te is None else te, wing_t(y), wing_z(y) - WZ0)
    tex = lambda y, frac: xb(wing_te(y) - frac * chord(y))     # body x of a hinge line at this chord fraction from the TE
    sts = [st(2.9), st(FLAP_IN)]
    bm = surface(sts, WZ0, 0.13)
    merge(bm, surface([st(y, tex(y, FLAP_FRAC)) for y in (FLAP_IN, 6.5, FLAP_MID, 15.5, FLAP_OUT)], WZ0, 0.12))
    merge(bm, surface([st(y, tex(y, AIL_FRAC)) for y in (AIL_IN, 25.0, AIL_OUT)], WZ0, 0.1))
    # the raked tip
    merge(bm, surface([st(AIL_OUT), st(31.0), st(SEMI - 0.02)], WZ0, 0.09))
    # the slats' leading edge a bright metal band
    bisect_paint(bm, [((xb(wing_le(10) + 0.5), 0, 0), (1, 0, 0))])
    kit.new_object(f'wing{sname}', bm, ['wingGrey'], smooth_angle=40)
    # nav light at the tip
    bm = bmesh.new()
    vs = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.09)['verts']
    bmesh.ops.translate(bm, vec=V(xb(wing_le(SEMI)) - 0.4, side * (SEMI - 0.05), wing_z(SEMI)), verts=vs)
    kit.new_object(f'nav{sname}', bm, ['navRed' if side < 0 else 'navGreen'], smooth_angle=80)
    # flaps (inboard and outboard) and the aileron, origin on their hinge lines
    for kind, nm, y0, y1, frac in (('flap', 'flapIn', FLAP_IN, FLAP_MID, FLAP_FRAC), ('flap', 'flapOut', FLAP_MID, FLAP_OUT, FLAP_FRAC),
                                   ('aileron', 'aileron', AIL_IN, AIL_OUT, AIL_FRAC)):
        h0, h1 = tex(y0, frac), tex(y1, frac)
        hinge = (0.5 * (h0 + h1), side * 0.5 * (y0 + y1), 0.5 * (wing_z(y0) + wing_z(y1)))
        sts = [(side * y, tex(y, frac) - 0.02, xb(wing_te(y)), wing_t(y) * 0.6, wing_z(y) - WZ0) for y in (y0 + 0.02, 0.5 * (y0 + y1), y1 - 0.02)]
        bm = surface(sts, WZ0, 0.08)
        kit.new_object(f'{nm}{sname}', bm, ['wingGrey'], origin=hinge, smooth_angle=40,
                       meta=dict(kind=kind, side=side, hinge=list(hinge), axis=[h1 - h0, side * (y1 - y0), wing_z(y1) - wing_z(y0)]))
    # spoilers: panels on the upper surface ahead of the flaps, up with the speed brake
    for i, (y0, y1) in enumerate(((4.5, 7.5), (7.6, 10.0), (11.0, 14.0), (14.1, 17.0), (17.1, 20.0))):
        f0, f1 = 0.30 + 0.16, 0.30 + 0.01                  # chord fractions from the TE: front and rear edges
        p = lambda y, f: (xb(wing_te(y) - f * chord(y)), side * y, wing_z(y) - wing_t(y) * chord(y) * 0.32)
        a0, a1, b1, b0 = p(y0, f0), p(y1, f0), p(y1, f1), p(y0, f1)
        bm = bmesh.new()
        q = [bm.verts.new(V(*v)) for v in (a0, a1, b1, b0)]
        bm.faces.new(q)
        outward(bm)
        hinge = tuple(0.5 * (u + w) for u, w in zip(a0, a1))
        ax = [a1[k] - a0[k] for k in range(3)]
        if ax[1] < 0:
            ax = [-v for v in ax]
        ob = kit.new_object(f'spoiler{sname}{i}', bm, ['wingGrey'], origin=hinge, smooth_angle=40, meta=dict(kind='speedbrake', hinge=list(hinge), axis=ax))
        ob.modifiers.new('thick', 'SOLIDIFY').thickness = 0.04


# ── engines: GE90-115B under the wing ───────────────────────────────────────
def engine(side):
    sname = 'L' if side < 0 else 'R'
    y, zc = side * ENG['y'], ENG['z']
    n = 40
    ring = lambda st, r: [(xb(st), y + r * math.cos(2 * math.pi * k / n), zc + r * math.sin(2 * math.pi * k / n)) for k in range(n)]
    # the fan cowl: inlet lip in, round the outside, the fan duct's exit
    bm = bmesh.new()
    rings = [ring(24.25, 1.62), ring(23.2, 1.68), ring(23.0, 1.85), ring(23.2, 2.02), ring(24.0, 2.12), ring(25.5, 2.13),
             ring(27.3, 2.03), ring(29.0, 1.78), ring(30.3, 1.50), ring(30.25, 1.36)]
    loft(bm, rings, cap=False)
    bisect_paint(bm, [((xb(23.3), 0, 0), (1, 0, 0))])
    outward(bm)
    for f in bm.faces:
        x, _, _ = body(f.calc_center_median())
        f.material_index = 1 if R_ST - x < 23.3 else 0
    kit.new_object(f'nacelle{sname}', bm, ['nacelle', 'metal'], smooth_angle=45)
    # the fan face and its spinner
    bm = bmesh.new()
    bm.faces.new([bm.verts.new(V(*p)) for p in ring(24.3, 1.62)])
    outward(bm)
    kit.new_object(f'fan{sname}', bm, ['fan'], smooth_angle=10)
    bm = bmesh.new()
    loft(bm, [ring(24.28, 0.55), ring(23.95, 0.42), ring(23.65, 0.2), ring(23.5, 0.01)], cap=True)
    outward(bm)
    kit.new_object(f'spinner{sname}', bm, ['spinner'], smooth_angle=60)
    # the core cowl, its nozzle and the plug
    bm = bmesh.new()
    loft(bm, [ring(29.6, 1.30), ring(30.4, 1.18), ring(31.6, 0.92), ring(32.2, 0.78)], cap=False)
    outward(bm)
    kit.new_object(f'core{sname}', bm, ['metal'], smooth_angle=45)
    bm = bmesh.new()
    loft(bm, [ring(31.9, 0.62), ring(32.6, 0.45), ring(33.3, 0.15), ring(33.5, 0.01)], cap=True)
    outward(bm)
    kit.new_object(f'plug{sname}', bm, ['exhaust'], smooth_angle=50)
    # the pylon up to the wing
    bm = bmesh.new()
    wz = wing_z(ENG['y'])
    rings = []
    for st, zt, zb_ in ((25.0, zc - 2.05, zc - 1.9), (27.0, zc - 2.0, zc - 1.6), (30.0, wz - 0.05, zc - 1.0), (33.5, wz - 0.1, zc - 0.7), (36.5, wz + 0.05, wz + 0.45)):
        rings.append(superellipse(xb(st), zt, zb_, 0.38, 3.0, 16, yc=y))
    loft(bm, rings, cap=True)
    outward(bm)
    kit.new_object(f'pylon{sname}', bm, ['wingGrey'], smooth_angle=45)


# ── tails ───────────────────────────────────────────────────────────────────
def tailplane():
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        st = lambda y, te=None: (side * y, xb(ht_le(y)), xb(ht_le(y) + ht_chord(y)) if te is None else te, 0.10, ht_z(y) - HT['z0'])
        hx = lambda y: xb(ht_le(y) + (1 - HT['frac']) * ht_chord(y))
        bm = surface([st(y, hx(y)) for y in (0.5, 3.0, 6.0, 9.0, HT['semi'] - 0.3)], HT['z0'], 0.10)
        merge(bm, surface([st(HT['semi'] - 0.3), st(HT['semi'])], HT['z0'], 0.09))
        kit.new_object(f'tailplane{sname}', bm, ['white'], smooth_angle=40)
        y0, y1 = 1.6, HT['semi'] - 0.3
        a = (hx(y0), side * y0, ht_z(y0))
        b = (hx(y1), side * y1, ht_z(y1))
        hinge = tuple(0.5 * (p + q) for p, q in zip(a, b))
        sts = [(side * y, hx(y) - 0.02, xb(ht_le(y) + ht_chord(y)), 0.07, ht_z(y) - HT['z0']) for y in (y0 + 0.02, 0.5 * (y0 + y1), y1 - 0.02)]
        bm = surface(sts, HT['z0'], 0.07)
        ax = [b[k] - a[k] for k in range(3)]
        if ax[1] < 0:
            ax = [-v for v in ax]
        kit.new_object(f'elevator{sname}', bm, ['white'], origin=hinge, smooth_angle=40,
                       meta=dict(kind='elevator', side=side, hinge=list(hinge), axis=ax))


def fin():
    st = lambda z, te=None: (z, xb(vt_le(z)), xb(vt_le(z) + vt_chord(z)) if te is None else te)
    hx = lambda z: xb(vt_le(z) + (1 - VT['frac']) * vt_chord(z))
    z0, z1 = VT['z0'] + 0.9, VT['z1']
    rz0, rz1 = VT['z0'] - 0.3, VT['z1'] + 0.5
    bm = surface([st(z0), st(rz0)], 0, 0.10, vertical=True)
    merge(bm, surface([st(z, hx(z)) for z in (rz0, 0.5 * (rz0 + rz1), rz1)], 0, 0.10, vertical=True))
    merge(bm, surface([st(rz1), st(z1)], 0, 0.09, vertical=True))
    kit.new_object('fin', bm, ['blue'], smooth_angle=40)
    a, b = (hx(rz0), 0, rz0), (hx(rz1), 0, rz1)
    hinge = tuple(0.5 * (p + q) for p, q in zip(a, b))
    sts = [(z, hx(z) - 0.02, xb(vt_le(z) + vt_chord(z)), 0.07) for z in (rz0 - 0.02, 0.5 * (rz0 + rz1), rz1 + 0.02)]
    bm = surface(sts, 0, 0.07, vertical=True)
    kit.new_object('rudder', bm, ['blue'], origin=hinge, smooth_angle=40,
                   meta=dict(kind='rudder', hinge=list(hinge), axis=[b[0] - a[0], 0, b[2] - a[2]]))
    # the APU's exhaust at the tail's tip, the white tail light, the beacons top and bottom
    bm = bmesh.new()
    cylinder(bm, (xb(LENGTH - 0.15), 0, -1.25), 0.22, 0.3, 'x', 16)
    outward(bm)
    kit.new_object('apuExhaust', bm, ['exhaust'], smooth_angle=40)
    bm = bmesh.new()
    for c in ((xb(25.0), 0, -3.18), (xb(30.0), 0, 3.85)):
        vs = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=0.12)['verts']
        bmesh.ops.translate(bm, vec=V(*c), verts=vs)
    kit.new_object('beacons', bm, ['beacon'], smooth_angle=80)


# ── landing gear ────────────────────────────────────────────────────────────
def gear():
    hz = CONTACT_Z - MAIN['r']                        # the axles' height
    for side in (-1, 1):
        sname = 'L' if side < 0 else 'R'
        top = (MAIN['x'] + 0.2, side * 4.6, 2.55)
        bogie = (MAIN['x'], side * MAIN['y'], hz - 0.30)
        bm = bmesh.new()
        rod(bm, top, (bogie[0] + 0.1, bogie[1], bogie[2] - 0.15), 0.2, 14)            # the oleo
        rod(bm, (bogie[0] + 0.1, bogie[1], bogie[2] - 0.15), (bogie[0], bogie[1], bogie[2]), 0.14, 12)
        rod(bm, (top[0] - 1.6, side * 3.9, 2.6), (bogie[0] + 0.15, side * 5.2, bogie[2] - 0.9), 0.08, 8)   # side brace
        rod(bm, (bogie[0] + MAIN['axle'] + 0.2, bogie[1], bogie[2] + 0.02), (bogie[0] - MAIN['axle'] - 0.2, bogie[1], bogie[2] + 0.02), 0.13, 10)   # the bogie beam
        for k in (-1, 0, 1):
            ax = bogie[0] + k * MAIN['axle']
            rod(bm, (ax, side * (MAIN['y'] - MAIN['pair'] / 2), hz), (ax, side * (MAIN['y'] + MAIN['pair'] / 2), hz), 0.08, 8)   # axles
        outward(bm)
        leg = f'mainLeg{sname}'
        kit.new_object(leg, bm, ['gearGrey'], origin=top, smooth_angle=40,
                       meta=dict(kind='gearLeg', hinge=list(top), axis=[-1 if side < 0 else 1, 0, 0], fold=88))
        front, rear = (0, 1) if side < 0 else (2, 3)
        for k, unit in ((1, front), (0, front), (-1, rear)):
            for p in (-1, 1):
                hub = (MAIN['x'] + k * MAIN['axle'], side * MAIN['y'] + p * MAIN['pair'] / 2, hz)
                wheel(kit, f'wheel{sname}{k + 1}{"a" if p < 0 else "b"}', hub, MAIN['r'], MAIN['w'], dict(kind='wheel', gear=unit, parent=leg))
    # the nose leg: folds forward
    hz = CONTACT_Z - NOSEG['r']
    top = (NOSEG['x'] + 0.25, 0, 2.6)
    bm = bmesh.new()
    rod(bm, top, (NOSEG['x'] + 0.05, 0, hz - 0.25), 0.13, 12)
    rod(bm, (NOSEG['x'] + 0.05, 0, hz - 0.25), (NOSEG['x'], 0, hz), 0.09, 10)
    rod(bm, (NOSEG['x'], -NOSEG['pair'] / 2, hz), (NOSEG['x'], NOSEG['pair'] / 2, hz), 0.07, 8)
    rod(bm, (top[0] + 1.3, 0, 2.7), (NOSEG['x'] + 0.1, 0, hz - 0.9), 0.06, 8)       # drag brace
    outward(bm)
    kit.new_object('noseLeg', bm, ['gearGrey'], origin=top, smooth_angle=40,
                   meta=dict(kind='gearLeg', gear=4, hinge=list(top), axis=[0, 1, 0], fold=100))
    for p in (-1, 1):
        wheel(kit, f'nosewheel{"a" if p < 0 else "b"}', (NOSEG['x'], p * NOSEG['pair'] / 2, hz), NOSEG['r'], NOSEG['w'], dict(kind='steerwheel', gear=4, parent='noseLeg'))


# ── build ───────────────────────────────────────────────────────────────────
fuselage()
cabin_windows()
belly_fairing()
flight_deck()
for s in (-1, 1):
    wing(s)
    engine(s)
tailplane()
fin()
gear()

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
out_json = args[0] if args and not args[0].startswith('--') else 'data/model/b777.json'
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
    gz = CONTACT_Z - 0.12      # the ground under the static gear (Blender z = -body z)
    views = {
        'front34': ((60, -48, 14), (0, 0, -2), 40),
        'rear34': ((-75, 42, 18), (-6, 0, -2), 40),
        'side': ((-1, -120, -1), (-1, 0, -1), 'ortho', 80),
        'top': ((-1, 0, 120), (-1, 0, 0), 'ortho', 80),
        'front': ((120, 0, -2), (0, 0, -2), 'ortho', 70),
        'nose': ((xb(-12), -9, 2.5), (xb(4), 0, 0.5), 40),
        'noseFront': ((xb(-14), -2.5, 3.0), (xb(2.5), 0, 0.9), 30),
        'noseSide': ((xb(2.6), -12, 1.2), (xb(2.6), 0, 0.9), 30),
        'paneClose': ((xb(-2.5), 2.6, 1.6), (xb(1.6), 0.9, 0.6), 30),
        'cockpit': (V(*EYE), V(xb(-20), -0.53, 1.5), 80),
        'gear': ((-2, -16, -2.0), (-2, -5, -4.0), 45),
    }
    kit.render(args[args.index('--render') + 1], views, gz)
