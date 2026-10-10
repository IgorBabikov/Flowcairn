"""Own cutaway room, clean plate plus aligned furniture-only occlusion layers."""
import bpy,json,sys,math
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE,VERIFIED_INPUTS,camera,render,cube,cylinder,save_inputs
from bpy_extras.object_utils import world_to_camera_view
# Reuse the exact approved room authoring, before hero creation; it writes no
# outputs. Static composition remains one source instead of divergent copies.
room_script=Path(__file__).with_name('render_guild.py').read_text()
exec(compile(room_script.split('\nmage=make_hero()')[0],str(Path(__file__).with_name('render_guild.py')),'exec'))
# Reviewer has a distinct side desk so review is not confused with testing.
table('Review desk',2.8,2.15,1.55,.95,.92)
cube('Review blue folio',(2.8,2.15,1.03),(1.0,.62,.08),ink,.02)
for i in range(3):cube('Review parchment',(2.65+i*.13,2.15,1.09+i*.012),(.5,.54,.016),parchment,.005)
cam=camera('Guild orthographic camera',(13,-13,13.8),(0,0,.9),17.3,1440,1080)
bpy.context.view_layer.update()
def project(xyz):
    p=world_to_camera_view(bpy.context.scene,cam,Vector(xyz));return [round(p.x*1440,4),round((1-p.y)*1080,4)]
groups={
 'analyst':['Analysis map table','Map parchment','Map region','Map pin'],
 'mage':['Arcane workbench','Workbench teal runner','Open spell book','Book ink line','Potion bottle','Bottle cork','Floating artifact'],
 'checker':['Proof artifact stand','Proof crystal'],
 'reviewer':['Review desk','Review blue folio','Review parchment'],
 'mentor':['Mentor lectern','Mentor book'],
}
meshes=[o for o in bpy.data.objects if o.type=='MESH' and not o.hide_render]
selected={role:[o for o in meshes if any(o.name.startswith(n) for n in names)] for role,names in groups.items()}
all_fg={o for objects in selected.values() for o in objects}
# Cycles camera-only visibility preserves direct/indirect shading and shadows
# across layers, while excluding every foreground object from the clean plate.
for o in meshes:o.visible_camera=o not in all_fg
OUT=BASE/'cast';OUT.mkdir(exist_ok=True)
if '--contract-only' not in sys.argv:render(OUT/'guild-room.png')
for role,objects in selected.items():
    for o in meshes:o.visible_camera=o in objects
    if '--contract-only' not in sys.argv:render(OUT/f'guild-foreground-{role}.png')
for o in meshes:o.visible_camera=True
if '--contract-only' not in sys.argv:bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'guild-room-source.blend'))
positions={'analyst':(-3,.9,0),'mage':(.25,.3,0),'checker':(3,-1.5,0),'reviewer':(2.8,1.25,0),'mentor':(-2.8,-2.4,0)}
centers={'analyst':(-3,1.9,0),'mage':(.25,1.55,0),'checker':(3,-.55,0),'reviewer':(2.8,2.15,0),'mentor':(-2.8,-1.55,0)}
record=dict(resolution=[1440,1080],camera=dict(type='orthographic',yawDegrees=45,elevationDegrees=35.04,orthoScale=17.3),room='guild-room.png',spriteScale=(1440/17.3)/100,stations={},foregrounds=[])
for role,xyz in positions.items():
    record['stations'][role]=dict(world=list(xyz),pixel=project(xyz),direction='nw')
    record['foregrounds'].append(dict(role=role,file=f'guild-foreground-{role}.png',depthY=project(centers[role])[1],position=[0,0],size=[1440,1080]))
record['projection']=dict(origin=project((0,0,0)),unitX=project((1,0,0)),unitY=project((0,1,0)),unitZ=project((0,0,1)),worldUnits='meters')
(OUT/'room-contract.json').write_text(json.dumps(record,indent=2)+'\n')
(OUT/'room-inputs.json').write_text(json.dumps(VERIFIED_INPUTS,indent=2)+'\n')
print('ROOM_LAYERS_COMPLETE',flush=True)
