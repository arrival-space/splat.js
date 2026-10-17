# kit.py — the modelling kit the airplane scripts share (f15c.py; extra300l.py
# keeps its own copy of the same few helpers): body axes ↔ Blender, materials,
# objects with their hinge as origin, lofts, NACA surfaces, wheels, and the
# JSON export scripts/bake-model.mjs packs.
#
# Body axes as the flight model: x forward, y right, z down (metres from the
# reference point R). Blender is z-up: a body point (x, y, z) is Blender
# (x, -y, -z).

import json
import math
import os

import bpy   # first: it brings bmesh and mathutils with it
import bmesh
from mathutils import Matrix, Vector


def V(x, y, z):
    """Body axes → Blender."""
    return Vector((x, -y, -z))


def body(v):
    """Blender → body axes."""
    return (v.x, -v.y, -v.z)


class Kit:
    def __init__(self, colors):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.colors = colors
        self.parts = []      # (object, meta)
        self.mats = {}

    def mat(self, name):
        if name not in self.mats:
            m = bpy.data.materials.new(name)
            h = self.colors[name].lstrip('#')
            rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
            lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
            m.diffuse_color = (*lin, 1)
            m.use_nodes = True
            bsdf = m.node_tree.nodes.get('Principled BSDF')
            bsdf.inputs['Base Color'].default_value = (*lin, 1)
            bsdf.inputs['Roughness'].default_value = 0.45
            if name == 'glass':
                bsdf.inputs['Alpha'].default_value = 0.25
                bsdf.inputs['Roughness'].default_value = 0.02
            if name in ('metal', 'chrome', 'nozzle'):
                bsdf.inputs['Metallic'].default_value = 1.0
            self.mats[name] = m
        return self.mats[name]

    def new_object(self, name, bm, materials, origin=(0, 0, 0), smooth_angle=35, meta=None):
        """bmesh → object; origin given in body axes (the hinge for moving parts)."""
        me = bpy.data.meshes.new(name)
        o = V(*origin)
        bmesh.ops.translate(bm, verts=bm.verts, vec=-o)
        bm.normal_update()
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(smooth_angle):
                e.smooth = False
        bm.to_mesh(me)
        bm.free()
        for m in materials:
            me.materials.append(self.mat(m))
        ob = bpy.data.objects.new(name, me)
        ob.location = o
        self.scene.collection.objects.link(ob)
        self.parts.append((ob, dict(meta or {}, origin=list(origin))))
        return ob

    # ── export ──────────────────────────────────────────────────────────────
    def export(self, path, eye):
        deps = bpy.context.evaluated_depsgraph_get()
        out = []
        for ob, meta in self.parts:
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
                part = dict(name=name, color=self.colors[mname], material=mname,
                            positions=[round(c, 5) for p, _ in verts for c in p],
                            normals=[round(c, 4) for _, n in verts for c in n],
                            indices=idx)
                for k in ('kind', 'hinge', 'axis', 'side', 'gear', 'transparent', 'parent', 'fold'):
                    if k in meta:
                        part[k] = meta[k]
                out.append(part)
            ev.to_mesh_clear()
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w') as f:
            json.dump(dict(eye=list(eye), parts=out), f)
        tris = sum(len(p['indices']) // 3 for p in out)
        print(f'exported {len(out)} parts, {tris} triangles → {path}')

    def render(self, outdir, views, ground_z, floor='floor'):
        scene = self.scene
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
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
        bmesh.ops.translate(bm, vec=Vector((0, 0, -ground_z)), verts=bm.verts)
        me = bpy.data.meshes.new('ground'); bm.to_mesh(me)
        g = bpy.data.objects.new('ground', me); scene.collection.objects.link(g)
        me.materials.append(self.mat(floor))
        cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
        scene.collection.objects.link(cam)
        scene.camera = cam
        only = os.environ.get('VIEWS')
        for name, (eye, at, fov, *rest) in views.items():
            if only and name not in only.split(','):
                continue
            cam.location = Vector(eye)
            d = Vector(at) - Vector(eye)
            cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
            if fov == 'ortho':
                cam.data.type = 'ORTHO'
                cam.data.ortho_scale = rest[0] if rest else 8.6
            else:
                cam.data.type = 'PERSP'
                cam.data.angle = math.radians(fov)
            canopy_ob = bpy.data.objects.get('canopy')
            if canopy_ob:
                canopy_ob.hide_render = name.startswith('cockpit')
            scene.render.filepath = os.path.join(outdir, f'{name}.png')
            bpy.ops.render.render(write_still=True)
            print('rendered', scene.render.filepath)


# ── geometry ────────────────────────────────────────────────────────────────
def loft(bm, rings, close=True, cap=True):
    """Rings of body points → quads (and n-gon caps). Wind them outward afterwards (outward())."""
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


def superellipse(cx, cz_top, cz_bot, hw, e, n, yc=0.0):
    """A section at station x: top/bottom (body z, top negative) and half-width; n points around."""
    zc = 0.5 * (cz_top + cz_bot)
    hh = 0.5 * (cz_bot - cz_top)
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n
        c, s = math.cos(t), math.sin(t)
        y = yc + hw * math.copysign(abs(c) ** (2 / e), c)
        z = zc - hh * math.copysign(abs(s) ** (2 / e), s)
        pts.append((cx, y, z))
    return pts


def smooth_interp(stations, xs):
    """Catmull-Rom through station rows (x first, then values; x descending) at the given x's."""
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
    """Cut the mesh with planes (body axes: (point, normal)) so paint edges are straight."""
    for p, nrm in planes:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=V(*p), plane_no=Vector((nrm[0], -nrm[1], -nrm[2])))


def box(bm, c, size, rot=None):
    res = bmesh.ops.create_cube(bm, size=1.0)
    vs = res['verts']
    bmesh.ops.scale(bm, vec=Vector((size[0], size[1], size[2])), verts=vs)
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


def rod(bm, a, b, r, segs=10):
    """A round strut between two body points."""
    va, vb = V(*a), V(*b)
    d = vb - va
    res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r, depth=d.length)
    vs = res['verts']
    q = d.to_track_quat('Z', 'Y')
    bmesh.ops.rotate(bm, cent=Vector((0, 0, 0)), matrix=q.to_matrix(), verts=vs)
    bmesh.ops.translate(bm, vec=(va + vb) / 2, verts=vs)
    return vs


def naca(t, n=14, camber=0.0):
    """Section points around (upper LE→TE then lower back), chord 0..1 from the LE, thickness ±."""
    up = []
    for k in range(n + 1):
        u = k / n
        xc = 0.5 * (1 - math.cos(math.pi * u))
        th = 5 * t * (0.2969 * math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4)
        up.append((xc, th))
    lo = [(x, -h) for x, h in reversed(up[1:-1])]
    return up + lo


def surface(stations, plane_z, t, vertical=False, n=14, plane_y=0.0):
    """Lofted surface through stations [(span, xLE, xTE[, t, z_or_y offset])]; horizontal: span = body y, chord
    plane z (per station offset adds to it: anhedral); vertical: span = body z (negative up), thickness along y."""
    bm = bmesh.new()
    rings = []
    for st in stations:
        s, xle, xte = st[:3]
        tt = st[3] if len(st) > 3 else t
        off = st[4] if len(st) > 4 else 0.0
        sec = naca(tt, n)
        c = xle - xte
        r = []
        for xc, h in sec:
            x = xle - xc * c
            if vertical:
                r.append((x, plane_y + off + h * c, s))
            else:
                r.append((x, s, plane_z + off - h * c))
        rings.append(r)
    loft(bm, rings, close=True, cap=True)
    outward(bm)
    return bm


def merge(bm, other):
    """Append another bmesh's geometry into bm (other is freed)."""
    me_tmp = bpy.data.meshes.new('tmp')
    other.to_mesh(me_tmp)
    other.free()
    bm.from_mesh(me_tmp)
    bpy.data.meshes.remove(me_tmp)
    return bm


def wheel(kit, name, hub, r, w, meta, segs=28):
    bm = bmesh.new()
    prof = [(0.62, -0.5), (0.84, -0.5), (0.96, -0.40), (1.0, 0.0), (0.96, 0.40), (0.84, 0.5), (0.62, 0.5)]
    rings = []
    for rf, yf in prof:
        rings.append([(hub[0] + r * rf * math.cos(2 * math.pi * k / segs), hub[1] + yf * w, hub[2] + r * rf * math.sin(2 * math.pi * k / segs)) for k in range(segs)])
    loft(bm, rings)
    outward(bm)
    m = dict(meta, hinge=list(hub), axis=[0, 1, 0])
    kit.new_object(name, bm, ['tyre'], origin=hub, smooth_angle=45, meta=m)
    bm = bmesh.new()
    cylinder(bm, hub, r * 0.62, w * 0.95, 'y', 20)
    cylinder(bm, hub, r * 0.22, w * 1.2, 'y', 12)
    outward(bm)
    kit.new_object(name + 'Hub', bm, ['metal'], origin=hub, smooth_angle=45, meta=dict(m))
