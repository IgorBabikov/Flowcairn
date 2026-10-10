"""Build our own compact guild scene from free Standard models and original props.

Run from repository root: blender -b --factory-startup --python tools/rpg-assets/render_guild.py
"""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector
sys.path.insert(0,str(Path(__file__).resolve().parent))
from blender_common import BASE, material, assign, cube, cylinder, imported_prop, camera, lights, settings, render, save_inputs
from hero import make_hero, make_animation_source, select_action, retarget, pose_metrics

bpy.ops.wm.read_factory_settings(use_empty=True)
settings(48);lights()
wood=material('Guild walnut',(.18,.095,.048));edge=material('Warm oak edges',(.32,.17,.07))
gold=material('Antique brass',(.57,.34,.10),.6,.4);ink=material('Midnight ink',(.025,.055,.095))
parchment=material('Warm parchment',(.75,.62,.38));teal=material('Guild turquoise',(.025,.25,.25))
stone=material('Dark foundation',(.11,.14,.19));glow=material('Arcane cyan',(.05,.5,.61),.1,.35,1.4)

cube('Cutaway foundation',(0,0,-.2),(10.3,8.3,.38),stone,.12)
for x in [-4,-2,0,2,4]:
    for y in [-3,-1,1,3]:imported_prop('Floor_WoodDark',(x,y,0))
for x in [-4,-2,0,2,4]:imported_prop('Wall_Plaster_Straight',(x,4,0))
for y in [-3,-1,1,3]:imported_prop('Wall_Plaster_Straight',(-5,y,0),math.pi/2)
cube('Front sill',(0,-4,.05),(10,.13,.12),edge)
cube('Right sill',(5,0,.05),(.13,8,.12),edge)

def table(name,x,y,width,depth,height=1.0):
    for dx in [-width*.39,width*.39]:
        for dy in [-depth*.35,depth*.35]:cube(name+' leg',(x+dx,y+dy,height/2),( .12,.12,height),wood,.018)
    cube(name+' cross rail',(x,y,.28),(width*.8,.09,.12),edge)
    for i in range(5):cube(name+' top plank',(x-width/2+width*(i+.5)/5,y,height),(width/5-.015,depth,.13),edge,.022)

# Analyst's map corner, mage workbench, verification ring, mentor's book.
table('Analysis map table',-3,1.9,2.25,1.45)
cube('Map parchment',(-3,1.9,1.087),(1.8,1.12,.012),parchment,.006)
for x,y,s in [(-3.4,1.65,.18),(-2.9,2.1,.23),(-2.5,1.7,.15)]:
    obj=cube('Map region',(x,y,1.1),(s*2,s,.018),teal,.02);obj.rotation_euler.z=.3
for x,y in [(-3.7,2.25),(-2.4,1.65),(-3,1.9)]:cylinder('Map pin',(x,y,1.14),.035,.08,gold,12)

table('Arcane workbench',.25,1.55,2.65,1.15,1.03)
cube('Workbench teal runner',(.25,1.55,1.105),(1.78,1.04,.025),teal,.015)
for x in [-.2,.22]:
    obj=cube('Open spell book pages',(x,1.48,1.17),(.38,.57,.10),parchment,.015);obj.rotation_euler.y=(.12 if x<0 else -.12)
for i in range(5):cube('Book ink line',(-.2,1.30+i*.065,1.225),(.24,.008,.002),ink,0)
for x,y,c in [(1,1.68,glow),(1.2,1.47,gold),(-.8,1.65,teal)]:
    cylinder('Potion bottle',(x,y,1.28),.095,.3,c,16);cylinder('Bottle cork',(x,y,1.46),.047,.07,wood,12)
cylinder('Floating artifact',(.25,1.55,1.60),.15,.07,glow,6)

cylinder('Verification platform',(3,-.55,.035),1.35,.07,stone,64)
for i in range(16):
    t=i*math.tau/16;obj=cube('Verification rune',(3+1.12*math.cos(t),-.55+1.12*math.sin(t),.083),(.15,.055,.012),gold,.007);obj.rotation_euler.z=t
cylinder('Proof artifact stand',(3,-.55,.35),.24,.62,gold,8)
cylinder('Proof crystal',(3,-.55,.82),.13,.32,glow,6)

table('Mentor lectern',-2.8,-1.55,1.0,.7,.86)
book=cube('Mentor book',(-2.8,-1.55,.99),(.8,.58,.15),parchment);book.rotation_euler.z=-.15
cube('Mentor rug',(-2.8,-1.55,.025),(2.4,1.8,.025),teal,.1)
for loc in [(-4,3.1,0),(4,3.1,0)]:imported_prop('Prop_Crate',loc)

# Original wall fixtures and guild crest, deliberately no generated UI text.
for x in [-3.8,3.8]:
    cube('Brass wall bracket',(x,3.68,1.7),(.12,.15,.55),gold)
    cylinder('Lantern glass',(x,3.45,1.98),.15,.42,parchment,12)
    data=bpy.data.lights.new('Warm lantern','POINT');data.energy=35;data.color=(1,.58,.19);data.shadow_soft_size=.3
    obj=bpy.data.objects.new('Warm lantern',data);bpy.context.collection.objects.link(obj);obj.location=(x,3.3,2.1)
crest=cube('Guild crest shield',(0,3.62,2.15),(.87,.08,1.1),teal,.14)
for x in [-.18,.18]:
    obj=cube('Guild crest crossing',(x,3.55,2.15),(.07,.06,.6),gold,.01);obj.rotation_euler.y=(.38 if x>0 else -.38)

mage=make_hero();anim=make_animation_source();select_action(anim,'Spell_Simple_Idle_Loop');retarget(mage,anim,12)
mage.location=(.25,.3,.012);mage.rotation_mode='XYZ';mage.rotation_euler.z=math.pi
cam=camera('Guild orthographic camera',(13,-13,13.8),(0,0,.9),17.3,1440,1080)
bpy.context.view_layer.update()
from bpy_extras.object_utils import world_to_camera_view
stations={}
for name,xyz in {'analyst':(-3,.9,0),'mage':(.25,.3,0),'verifier':(3,-1.5,0),'mentor':(-2.8,-2.4,0)}.items():
    p=world_to_camera_view(bpy.context.scene,cam,Vector(xyz));stations[name]=dict(world=list(xyz),pixel=[round(p.x*1440,3),round((1-p.y)*1080,3)])
contract=dict(kind='art-preview',executorConnected=False,blender=bpy.app.version_string,
              camera=dict(type='orthographic',yawDegrees=45,elevationDegrees=35.04,orthoScale=17.3,resolution=[1440,1080]),
              stations=stations,heroPose=pose_metrics(mage),worldUnits='meters')
(BASE/'scene-contract.json').write_text(json.dumps(contract,indent=2)+'\n')
save_inputs('guild')
bpy.ops.wm.save_as_mainfile(filepath=str(BASE/'guild-art-preview.blend'))
render(BASE/'guild-art-preview.png')
# Preserve a clean room plate; the baked hero remains only in art-preview.
for obj in bpy.data.objects:
    if obj==mage or obj.parent==mage:obj.hide_render=True
render(BASE/'guild-room-plate.png')
print('ART_PREVIEW_COMPLETE',BASE/'guild-art-preview.png')
