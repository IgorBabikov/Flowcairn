"""Close-up QA of the assembled hero, materials, and facing direction."""
import bpy
import json
import math
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE, camera, lights, settings, render
from hero import make_hero, make_animation_source, select_action, retarget
bpy.ops.wm.read_factory_settings(use_empty=True)
settings(32);lights();rig=make_hero();source=make_animation_source()
select_action(source,'Idle_Loop');retarget(rig,source,0)
camera('QA camera',(4,-4,4.9608),(0,0,1),3.2,768,960)
record=[]
for obj in bpy.data.objects:
    if obj.type=='MESH' and not obj.hide_render:
        record.append(dict(name=obj.name,materials=[s.material.name if s.material else None for s in obj.material_slots]))
(BASE/'hero-materials.json').write_text(json.dumps(record,indent=2)+'\n')
render(BASE/'hero-portrait.png')
