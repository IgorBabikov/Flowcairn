"""Offline asset authoring helpers; never imported by the Flowcairn runtime."""
import bpy
import math
import json
import hashlib
from pathlib import Path
from mathutils import Vector

BASE = Path(__file__).resolve().parents[2] / 'output/product-completion/rpg'
EXTRACTED = BASE / 'extracted'
VERIFIED_INPUTS = {}

def source(name, contains=None):
    matches = sorted(p for p in EXTRACTED.rglob(name) if contains is None or contains in str(p))
    if len(matches) != 1:
        raise RuntimeError(f'Ambiguous source {name}: {matches}')
    path=matches[0]
    pack=path.relative_to(EXTRACTED).parts[0]
    inventory=json.loads((BASE/'sources'/(pack+'-inventory.json')).read_text())
    expected={record['path']:record['sha256'] for record in inventory}
    dependencies=[path]
    if path.suffix=='.gltf':
        gltf=json.loads(path.read_text())
        from urllib.parse import unquote
        dependencies += [path.parent/unquote(item['uri']) for group in ['buffers','images'] for item in gltf.get(group,[]) if 'uri' in item and not item['uri'].startswith('data:')]
    for dependency in dependencies:
        relative=dependency.relative_to(EXTRACTED/pack).as_posix()
        key=(Path(pack)/relative).as_posix()
        if key in VERIFIED_INPUTS:continue
        if not dependency.exists():
            # The base glTF has two broken normal-map references; the hero
            # replaces those materials explicitly rather than claiming them loaded.
            if dependency.name not in ['T_Hair_1_Normal_png.png','T_Eye_Normal_png.png']:
                raise RuntimeError('Missing dependency '+key)
            VERIFIED_INPUTS[key]={'missing':True,'usedForFinalMaterial':False}
            continue
        digest=hashlib.sha256(dependency.read_bytes()).hexdigest()
        if expected.get(relative)!=digest:raise RuntimeError('Source input hash mismatch '+key)
        VERIFIED_INPUTS[key]={'sha256':digest}
    return path

def save_inputs(name):
    (BASE/(name+'-inputs.json')).write_text(json.dumps(VERIFIED_INPUTS,indent=2)+'\n')

def import_model(path):
    previous = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True, bone_heuristic='BLENDER')
    return [o for o in bpy.data.objects if o not in previous and not o.hide_render]

def material(name, color, metallic=0, roughness=.65, emission=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metallic
    shader.inputs['Roughness'].default_value = roughness
    if emission:
        shader.inputs['Emission Color'].default_value = (*color, 1)
        shader.inputs['Emission Strength'].default_value = emission
    return m

def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)

def cube(name, location, size, mat, bevel=.04):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(obj, mat)
    if bevel:
        b = obj.modifiers.new('Soft edges', 'BEVEL'); b.width = bevel; b.segments = 2
        obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    return obj

def cylinder(name, location, radius, depth, mat, vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    obj=bpy.context.object; obj.name=name;assign(obj,mat)
    b=obj.modifiers.new('Soft edges','BEVEL');b.width=.018;b.segments=2
    obj.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return obj

def aim(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()

def camera(name, point, target, scale, width, height):
    data=bpy.data.cameras.new(name);data.type='ORTHO';data.ortho_scale=scale
    obj=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(obj)
    obj.location=point;aim(obj,target);bpy.context.scene.camera=obj
    bpy.context.scene.render.resolution_x=width;bpy.context.scene.render.resolution_y=height
    return obj

def lights():
    for name, point, energy, size, color in [
        ('Warm window key',(0,-3,9),1400,7,(1,.82,.62)),
        ('Cool ambient fill',(4,1,7),900,5,(.52,.7,1)),
        ('Golden wall bounce',(-4,3,6),750,4,(1,.65,.35)),
    ]:
        data=bpy.data.lights.new(name,'AREA');data.energy=energy;data.shape='DISK';data.size=size;data.color=color
        obj=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(obj);obj.location=point;aim(obj,(0,0,0))
    world=bpy.data.worlds.new('Soft blue ambient');world.use_nodes=True
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.25,.33,.5,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value=.35
    bpy.context.scene.world=world

def settings(samples=48):
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.device='CPU'
    scene.cycles.samples=samples;scene.cycles.use_denoising=True
    scene.render.film_transparent=True;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
    scene.render.image_settings.color_depth='8';scene.view_settings.view_transform='AgX'
    scene.render.fps=24

def render(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    bpy.context.scene.render.filepath=str(path)
    bpy.ops.render.render(write_still=True)

def imported_prop(name, location, rotation=0):
    objects=import_model(source(name+'.gltf', '/glTF/'))
    for obj in objects:
        obj.rotation_mode='XYZ'
        obj.location+=Vector(location);obj.rotation_euler.z+=rotation
    return objects
