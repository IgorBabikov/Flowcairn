"""Small fantasy rework ART PREVIEW only; never packs active production assets."""
import bpy,json,math,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE,VERIFIED_INPUTS,camera,lights,settings,render
from hero import make_animation_source,select_action,retarget
from cast import ROLES,author_gesture,mute_gesture
from fantasy_cast import make_fantasy
OUT=BASE/'cast/fantasy-v2';OUT.mkdir(parents=True,exist_ok=True)
roles=[a for a in sys.argv if a in ROLES] or ROLES
for role in roles:
    bpy.ops.wm.read_factory_settings(use_empty=True);settings(32);lights()
    rig=make_fantasy(role);source=make_animation_source()
    camera('Fantasy review camera',(4,-4,4.9608),(0,0,1),3.2,512,640)
    rig.rotation_mode='XYZ';select_action(source,'Idle_Loop')
    for state,direction,yaw in [('idle','se',0),('work','nw',math.pi)]:
        rig.rotation_euler.z=yaw;mute_gesture(rig);retarget(rig,source,0)
        if state=='work':
            author_gesture(rig,state,0,12)
            for side in ['l','r']:
                t=bpy.data.objects['GestureTarget_'+side];t.location=rig.matrix_world@t.location
            bpy.context.view_layer.update()
        render(OUT/f'{role}-{state}-{direction}.png')
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(role+'-fantasy-preview.blend')))
(OUT/'inputs.json').write_text(json.dumps(VERIFIED_INPUTS,indent=2)+'\n')
print('FANTASY_ART_PREVIEW_ONLY_COMPLETE')
