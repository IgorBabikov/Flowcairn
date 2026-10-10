"""Reproducible two-facing cast; raw files outside npm, PNG/JSON bundled only."""
import bpy,json,math,sys
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE,VERIFIED_INPUTS,camera,lights,settings,render
from hero import make_animation_source,select_action,retarget,pose_metrics
from cast import ROLES,author_gesture,mute_gesture
from fantasy_cast import make_fantasy as make_cast
from bpy_extras.object_utils import world_to_camera_view
OUT=BASE/'cast';OUT.mkdir(exist_ok=True)
acceptance=json.loads((OUT/'fantasy-v2/ROOT-ART-ACCEPTANCE.json').read_text())
if acceptance.get('status')!='ROOT_ACCEPTED_AS_INTEGRATION_BASIS':raise RuntimeError('Fantasy visual basis not accepted')
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
roles=[a for a in args if a in ROLES] or ROLES
qa='--qa' in args
extra='--walk-extra' in args
for role in roles:
    bpy.ops.wm.read_factory_settings(use_empty=True);settings(24);lights()
    rig=make_cast(role);source=make_animation_source()
    cam=camera('Cast orthographic camera',(4,-4,4.9608),(0,0,1),3.2,256,320)
    rig.rotation_mode='XYZ';bpy.context.view_layer.update()
    p=world_to_camera_view(bpy.context.scene,cam,Vector((0,0,0)))
    record=dict(role=role,visualRevision='fantasy-v2',blender=bpy.app.version_string,frameSize=[256,320],fps=12,pivot=[p.x*256,(1-p.y)*320],anchor=[p.x,1-p.y],states={})
    if extra:record=json.loads((OUT/(role+'-contract.json')).read_text())
    directions=[('ne',math.pi/2),('sw',math.pi*1.5)] if extra else [('se',0),('nw',math.pi)]
    for direction,angle in directions:
        rig.rotation_euler.z=angle
        states=[('walk','Walk_Loop',16)] if extra else [('idle','Idle_Loop',30),('walk','Walk_Loop',16),('work','Idle_Loop',12),('handoff','Idle_Loop',12)]
        for state,clip,count in states:
            select_action(source,clip);metrics=[]
            for i in range(1 if qa else count):
                mute_gesture(rig);retarget(rig,source,(i*2 if state in ['idle','walk'] else 0))
                if state in ['work','handoff']:
                    # Targets are local to rig; rotate them for opposite facing.
                    author_gesture(rig,state,i,count)
                    for side in ['l','r']:
                        target=bpy.data.objects['GestureTarget_'+side];target.location=rig.matrix_world@target.location
                    bpy.context.view_layer.update()
                metrics.append(dict(index=i,bones=pose_metrics(rig)))
                render(OUT/'frames'/role/direction/state/f'{i:03}.png')
            record['states'][state+'-'+direction]=dict(clip=clip if state in ['idle','walk'] else None,basePoseClip=clip,authored=state in ['work','handoff'],frames=len(metrics),rootMotion=False,metrics=metrics)
    (OUT/(role+'-contract.json')).write_text(json.dumps(record,indent=2)+'\n')
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(role+'-source.blend')))
(OUT/'inputs.json').write_text(json.dumps(VERIFIED_INPUTS,indent=2)+'\n')
print('CAST_RENDER_COMPLETE',flush=True)
