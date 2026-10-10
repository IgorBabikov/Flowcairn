"""Inspect actual imported rigs, actions, bounds before selecting render sources."""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector

files = sys.argv[sys.argv.index('--') + 1:]
records = []
for filename in files:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if filename.endswith('.fbx'):
        bpy.ops.import_scene.fbx(filepath=str(Path(filename).resolve()))
    else:
        bpy.ops.import_scene.gltf(filepath=str(Path(filename).resolve()))
    record = dict(file=filename, objects=[], actions=[])
    for obj in bpy.data.objects:
        points = [obj.matrix_world @ Vector(p) for p in obj.bound_box] if obj.type == 'MESH' else []
        item = dict(name=obj.name, type=obj.type, location=list(obj.location), rotation=list(obj.rotation_euler), scale=list(obj.scale))
        if points:
            item['bounds'] = [[min(v[i] for v in points), max(v[i] for v in points)] for i in range(3)]
        if obj.type == 'ARMATURE':
            item['bones'] = [dict(name=b.name, head=list(b.head_local), tail=list(b.tail_local), matrix=[list(row) for row in b.matrix_local]) for b in obj.data.bones]
        record['objects'].append(item)
    for action in bpy.data.actions:
        record['actions'].append(dict(name=action.name, frameRange=list(action.frame_range), slots=[s.identifier for s in action.slots]))
    records.append(record)
out = Path('output/product-completion/rpg/inspection.json')
out.write_text(json.dumps(records, indent=2))
print('Wrote', out, [(r['file'], len(r['objects']), len(r['actions'])) for r in records])
