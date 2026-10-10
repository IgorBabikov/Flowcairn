"""Full-room reference for independent alpha-layer reconstruction QA."""
import bpy,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE,render
bpy.ops.wm.open_mainfile(filepath=str(BASE/'cast/guild-room-source.blend'))
for obj in bpy.data.objects:
    if obj.type=='MESH':obj.visible_camera=True
render(BASE/'cast/full-room-reference.png')
