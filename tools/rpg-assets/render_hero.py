"""Render one direction at 12 fps, fixed camera and untrimmed alpha frames."""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE, camera, lights, settings, render, save_inputs
from hero import make_hero, make_animation_source, select_action, retarget, pose_metrics
from bpy_extras.object_utils import world_to_camera_view

bpy.ops.wm.read_factory_settings(use_empty=True)
settings(24);lights()
rig=make_hero();source=make_animation_source()
cam=camera('Hero orthographic camera',(4,-4,4.9608),(0,0,1),3.2,256,320)
rig.rotation_mode='XYZ'
scene=bpy.context.scene
bpy.context.view_layer.update()
origin=world_to_camera_view(scene,cam,Vector((0,0,0)))
unit=world_to_camera_view(scene,cam,Vector((1,0,0)))
contract=dict(kind='art-preview',executorConnected=False,blender=bpy.app.version_string,
              width=256,height=320,fps=12,sourceFps=24,trimmed=False,alpha='straight RGBA PNG',
              pivot=[origin.x*256,(1-origin.y)*320],anchor=[origin.x,1-origin.y],
              camera=dict(type='orthographic',yawDegrees=45,elevationDegrees=35.0,orthoScale=3.2),
              worldUnits='meters',direction='southeast (character forward -Y)',
              pixelsPerWorldUnitX=math.hypot((unit.x-origin.x)*256,(unit.y-origin.y)*320),states={})
for state,clip in [('idle','Idle_Loop'),('walk','Walk_Loop')]:
    action=select_action(source,clip)
    start,end=action.frame_range
    count=math.ceil((end-start)/2)
    samples=[]
    for index in range(count):
        frame=start+index*2
        retarget(rig,source,frame)
        samples.append(dict(index=index,sourceFrame=frame,bones=pose_metrics(rig)))
        render(BASE/'frames'/state/f'{index:03}.png')
        print('FRAME',state,index,flush=True)
    contract['states'][state]=dict(clip=clip,frames=count,durationSeconds=count/12,
                                  sourceFrameRange=[start,end],rootMotion=False,metrics=samples)
select_action(source,'Idle_Loop');retarget(rig,source,0)
bpy.ops.wm.save_as_mainfile(filepath=str(BASE/'hero-source.blend'))
(BASE/'hero-contract.json').write_text(json.dumps(contract,indent=2)+'\n')
save_inputs('hero')
print('HERO_RENDER_COMPLETE',flush=True)
