"""Original guild cast assemblies and authored two-arm gestures over CC0 rigs."""
import bpy
import bmesh
import math
from mathutils import Vector
from blender_common import import_model, source, material, assign, cylinder, cube
from hero import make_hero

ROLES=['analyst','mage','checker','reviewer','mentor']

def bone_parent(obj,rig,bone='Head'):
    world=obj.matrix_world.copy();obj.parent=rig;obj.parent_type='BONE';obj.parent_bone=bone
    bpy.context.view_layer.update();obj.matrix_world=world

def make_cast(role):
    if role=='mage':return make_hero()
    female=role in ['analyst','checker'];gender='Female' if female else 'Male'
    ranger=role in ['checker','reviewer']
    outfit=import_model(source(f'{gender}_{"Ranger" if ranger else "Peasant"}.gltf'))
    rig=next(o for o in outfit if o.type=='ARMATURE');rig.name=f'Guild_{role}'
    colors={'analyst':(.12,.36,.30),'checker':(.62,.24,.065),'reviewer':(.09,.19,.39),'mentor':(.43,.16,.09)}
    cloth=material(role+' fabric',colors[role]);leather=material(role+' leather',(.10,.055,.035))
    skin=material(role+' skin',(.48,.255,.14) if role=='checker' else (.64,.39,.225))
    metal=material(role+' metal',(.45,.48,.52),.7,.4);gold=material(role+' brass',(.65,.4,.13),.6,.4)
    cream=material(role+' cream',(.77,.67,.46));hair=material(role+' hair',(.08,.045,.03) if role!='mentor' else (.58,.59,.56))
    for obj in outfit:
        if obj.type!='MESH':continue
        if 'Head_Hood' in obj.name:bpy.data.objects.remove(obj,do_unlink=True);continue
        for slot in obj.material_slots:
            n=slot.material.name.lower() if slot.material else ''
            slot.material=skin if 'regular_' in n else metal if 'Pauldron' in obj.name else leather if any(v in obj.name for v in ['Feet','Belt','Bracer']) else cream if 'Legs' in obj.name and not ranger else cloth
        # Different author exports put hands on clothing slots; geometric bound
        # in rest T-pose selects hands only, keeps sleeves intact.
        if '_Arms' in obj.name:
            i=len(obj.data.materials);obj.data.materials.append(skin)
            for p in obj.data.polygons:
                if abs((obj.matrix_world@p.center).x)>.69:p.material_index=i
    base=import_model(source(f'Superhero_{gender}_FullBody.gltf'))
    base_rig=next(o for o in base if o.type=='ARMATURE')
    head=next(o for o in base if o.type=='MESH' and 'superhero' in o.name.lower())
    bm=bmesh.new();bm.from_mesh(head.data)
    bmesh.ops.delete(bm,geom=[v for v in bm.verts if (head.matrix_world@v.co).z<1.5],context='VERTS')
    bm.to_mesh(head.data);bm.free();assign(head,skin)
    for obj in base:
        if obj.type!='MESH':continue
        if 'Eyes' in obj.name:assign(obj,material(role+' eyes',(.12,.18,.22)))
        if 'Eyebrows' in obj.name:assign(obj,hair)
        for m in obj.modifiers:
            if m.type=='ARMATURE':m.object=rig
        world=obj.matrix_world.copy();obj.parent=rig;obj.matrix_world=world
    bpy.data.objects.remove(base_rig,do_unlink=True)
    # Headgear and visible equipment are original primitives, not pack claims.
    if role=='analyst':
        cap=cylinder('Analyst linen beret',(0,.04,1.875),.245,.14,cream,24);bone_parent(cap,rig)
        band=cylinder('Analyst green hatband',(0,.04,1.818),.22,.045,cloth,24);bone_parent(band,rig)
    elif role=='checker':
        cap=cylinder('Checker leather cap',(0,.04,1.88),.218,.13,leather,24);bone_parent(cap,rig)
        visor=cube('Checker brass visor',(0,-.17,1.785),(.31,.07,.095),gold,.025);bone_parent(visor,rig)
    elif role=='reviewer':
        hood=cylinder('Reviewer blue skullcap',(0,.04,1.88),.218,.1,cloth,24);bone_parent(hood,rig)
        plume=cube('Reviewer pale crest',(.06,.04,2.0),(.055,.19,.16),cream,.025);bone_parent(plume,rig)
    else:
        cap=cylinder('Mentor soft cap',(0,.055,1.88),.235,.12,cloth,24);bone_parent(cap,rig)
        bpy.ops.mesh.primitive_cone_add(vertices=12,radius1=.025,radius2=.15,depth=.3,location=(0,-.12,1.62))
        beard=bpy.context.object;assign(beard,hair);bone_parent(beard,rig)
        for x in [-.078,.078]:
            bpy.ops.mesh.primitive_torus_add(major_segments=16,minor_segments=6,location=(x,-.162,1.785),major_radius=.066,minor_radius=.01,rotation=(math.pi/2,0,0))
            glasses=bpy.context.object;assign(glasses,gold);bone_parent(glasses,rig)
    return rig

def author_gesture(rig,state,index,count):
    """Own stable-foot working/presenting pose, IK wrists; no library clip claim."""
    wave=math.sin(index/count*math.tau)
    for side,sign in [('l',1),('r',-1)]:
        bone=rig.pose.bones['lowerarm_'+side]
        target=bpy.data.objects.get('GestureTarget_'+side)
        if target is None:
            target=bpy.data.objects.new('GestureTarget_'+side,None);bpy.context.collection.objects.link(target)
            c=bone.constraints.new('IK');c.name='AuthoredGesture';c.target=target;c.chain_count=2;c.use_stretch=False
        if state=='work':target.location=(sign*.22,-.38,1.16+(.018*wave if side=='r' else -.012*wave))
        else:target.location=(sign*(.24 if side=='l' else .18),-.38-(.04*(wave+1) if side=='r' else 0),1.21+(.045*(wave+1) if side=='r' else 0))
        bone.constraints['AuthoredGesture'].mute=False
    bpy.context.view_layer.update()

def mute_gesture(rig):
    for side in ['l','r']:
        c=rig.pose.bones['lowerarm_'+side].constraints.get('AuthoredGesture')
        if c:c.mute=True
