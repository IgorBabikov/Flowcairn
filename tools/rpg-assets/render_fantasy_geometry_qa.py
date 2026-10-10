"""Small geometry gate before full render: stride phases, hands and face opening."""
import bpy,json,math,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE,camera,lights,settings,render
from hero import make_animation_source,select_action,retarget,pose_metrics
from cast import author_gesture,mute_gesture
from fantasy_cast import make_fantasy
OUT=BASE/'cast/fantasy-v2/geometry-qa';OUT.mkdir(parents=True,exist_ok=True)
record={}
for role in ['analyst','checker','reviewer','mentor']:
    bpy.ops.wm.read_factory_settings(use_empty=True);settings(24);lights()
    rig=make_fantasy(role);source=make_animation_source();camera('Geometry QA',(4,-4,4.9608),(0,0,1),3.2,256,320);rig.rotation_mode='XYZ';record[role]=[]
    for state,direction,yaw,phases in [('walk','se',0,[0,8,16,24]),('walk','nw',math.pi,[0,8,16,24]),('handoff','se',0,[0,3,6]),('work','nw',math.pi,[0])]:
        rig.rotation_euler.z=yaw;select_action(source,'Walk_Loop' if state=='walk' else 'Idle_Loop')
        for i in phases:
            mute_gesture(rig);retarget(rig,source,i if state=='walk' else 0)
            if state in ['work','handoff']:
                author_gesture(rig,state,i,12)
                for side in ['l','r']:
                    t=bpy.data.objects['GestureTarget_'+side];t.location=rig.matrix_world@t.location
                bpy.context.view_layer.update()
            name=f'{role}-{state}-{direction}-{i:02}.png';render(OUT/name);record[role].append(dict(file=name,bones=pose_metrics(rig)))
(OUT/'metrics.json').write_text(json.dumps(record,indent=2)+'\n')
print('GEOMETRY_QA_RENDER_COMPLETE')
