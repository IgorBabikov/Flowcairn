"""Assemble a Standard ranger + base head and retarget verified UAL clips."""
import bpy
import bmesh
import math
from mathutils import Matrix, Vector
from blender_common import import_model, source, material, assign, cylinder

def make_hero():
    outfit=import_model(source('Male_Ranger.gltf'))
    rig=next(o for o in outfit if o.type=='ARMATURE')
    rig.name='GuildMageRig'
    plum=material('Mage plum fabric',(.17,.055,.28))
    gold=material('Mage brushed gold',(.67,.38,.09),.5,.38)
    leather=material('Mage chestnut leather',(.095,.048,.035))
    skin=material('Warm skin',(.55,.29,.16),0,.7)
    teal=material('Mage teal lining',(.025,.22,.24))
    for obj in outfit:
        if obj.type!='MESH':continue
        if 'Head_Hood' in obj.name:
            bpy.data.objects.remove(obj,do_unlink=True);continue
        for slot in obj.material_slots:
            n=slot.material.name.lower() if slot.material else ''
            slot.material = skin if ('skin' in n or 'regular_male' in n) else gold if ('metal' in n or 'pauldron' in obj.name.lower()) else leather if ('Boot' in obj.name or 'Belt' in obj.name or 'Bracer' in obj.name) else plum
        if obj.name=='Male_Ranger_Arms':
            # Hands share the ranger clothing texture in the original export.
            # Identify their geometry in the source T pose, before deformation.
            skin_slot=len(obj.data.materials);obj.data.materials.append(skin)
            for polygon in obj.data.polygons:
                center=obj.matrix_world @ polygon.center
                if abs(center.x)>.69:polygon.material_index=skin_slot
    base=import_model(source('Superhero_Male_FullBody.gltf'))
    base_rig=next(o for o in base if o.type=='ARMATURE')
    head=next(o for o in base if o.type=='MESH' and 'SuperHero' in o.name)
    # Keep real Quaternius head/neck topology and weights, discard covered body.
    bm=bmesh.new();bm.from_mesh(head.data)
    bmesh.ops.delete(bm,geom=[v for v in bm.verts if (head.matrix_world @ v.co).z<1.5],context='VERTS')
    bm.to_mesh(head.data);bm.free();assign(head,skin)
    for obj in base:
        if obj.type!='MESH':continue
        if 'Eyes' in obj.name:assign(obj,material('Eyes',(.14,.27,.25)))
        if 'Eyebrows' in obj.name:assign(obj,leather)
        for modifier in obj.modifiers:
            if modifier.type=='ARMATURE':modifier.object=rig
        world=obj.matrix_world.copy();obj.parent=rig;obj.matrix_world=world
    bpy.data.objects.remove(base_rig,do_unlink=True)
    # Original authoring: broad sorcerer hat, gold hatband, teal gem.
    hat_parts=[]
    hat_parts.append(cylinder('Mage hat brim',(0,.065,1.85),.265,.045,plum,32))
    bpy.ops.mesh.primitive_cone_add(vertices=24,radius1=.215,radius2=.055,depth=.43,location=(0,.075,2.065))
    cone=bpy.context.object;cone.name='Mage hat crown';assign(cone,plum);hat_parts.append(cone)
    hat_parts.append(cylinder('Mage hatband',(0,.075,1.905),.21,.07,gold))
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=.054,location=(0,-.136,1.91))
    gem=bpy.context.object;gem.name='Mage hat jewel';assign(gem,teal);hat_parts.append(gem)
    # Bone parenting with matrix preservation keeps a stable hat under animation.
    for obj in hat_parts:
        world=obj.matrix_world.copy();obj.parent=rig;obj.parent_type='BONE';obj.parent_bone='Head'
        bpy.context.view_layer.update();obj.matrix_world=world
    return rig

def make_animation_source():
    objects=import_model(source('UAL1_Standard.glb'))
    rig=next(o for o in objects if o.type=='ARMATURE');rig.name='AnimationSource'
    for obj in objects:
        if obj.type=='MESH':obj.hide_render=True
    return rig

def select_action(source_rig, name):
    action=bpy.data.actions.get(name)
    if action is None:raise RuntimeError('Missing verified clip: '+name)
    source_rig.animation_data_create()
    for track in source_rig.animation_data.nla_tracks:track.mute=True
    source_rig.animation_data.action=action
    source_rig.animation_data.action_slot=action.slots[0]
    return action

def retarget(target, source_rig, frame):
    bpy.context.scene.frame_set(int(frame),subframe=frame%1)
    bpy.context.view_layer.update()
    # Shared named humanoid skeleton, with differing bind pose and proportions.
    # Transfer rest-relative global rotations; pelvis translation scales
    # by target/source pelvis bind height. This is tested only for selected clips.
    ratio=target.data.bones['pelvis'].head_local.z/source_rig.data.bones['pelvis'].head_local.z
    for bone in target.pose.bones:
        src=source_rig.pose.bones.get(bone.name)
        if src is None:raise RuntimeError('Missing animation bone '+bone.name)
        matrix=src.matrix @ source_rig.data.bones[bone.name].matrix_local.inverted() @ target.data.bones[bone.name].matrix_local
        matrix.translation=src.matrix.translation*ratio
        bone.matrix=matrix
        bpy.context.view_layer.update()
    bpy.context.view_layer.update()

def pose_metrics(rig):
    return {n:list(rig.pose.bones[n].head) for n in ['root','pelvis','foot_l','foot_r','ball_l','ball_r','hand_l','hand_r','Head']}
