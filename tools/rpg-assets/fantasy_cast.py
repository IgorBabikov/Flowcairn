"""Original fantasy wardrobe; new silhouettes over verified CC0 bodies, not recolors."""
import bpy,math
from mathutils import Vector
from blender_common import material,assign,cube,cylinder
from cast import make_cast,bone_parent

def weight_object(obj,rig,bone):
    world=obj.matrix_world.copy();obj.parent=rig;obj.matrix_world=world
    group=obj.vertex_groups.new(name=bone);group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
    mod=obj.modifiers.new('Fantasy fitting rig','ARMATURE');mod.object=rig

def ring_garment(name,rig,rings,mat,segments=16,split_legs=False):
    """Faceted cloth profile with spine/pelvis skin weights, thigh hems for gait."""
    vertices=[];faces=[]
    for z,rx,ry,cy in rings:
        for i in range(segments):
            t=i*math.tau/segments
            pleat=1+(.032 if i%2 else -.012)
            vertices.append((rx*math.cos(t)*pleat,cy+ry*math.sin(t)*pleat,z))
    for j in range(len(rings)-1):
        for i in range(segments):
            a=j*segments+i;b=j*segments+(i+1)%segments
            faces.append((a,b,b+segments,a+segments))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);assign(obj,mat)
    groups={n:obj.vertex_groups.new(name=n) for n in ['pelvis','spine_01','spine_02','spine_03','thigh_l','thigh_r']}
    for v in mesh.vertices:
        z=v.co.z
        if z>1.35:bone='spine_03'
        elif z>1.16:bone='spine_02'
        elif z>1.04:bone='spine_01'
        elif z<.7 and split_legs:
            # Cloth folds inherit a restrained share of leg swing. Hard thigh
            # weights ballooned the skirt in mid-stride and were rejected by QA.
            bone='thigh_l' if v.co.x>0 else 'thigh_r'
            groups[bone].add([v.index],.12,'REPLACE')
            groups['pelvis'].add([v.index],.88,'REPLACE')
            continue
        else:bone='pelvis'
        groups[bone].add([v.index],1,'REPLACE')
    mod=obj.modifiers.new('Fantasy cloth rig','ARMATURE');mod.object=rig
    obj.parent=rig
    solid=obj.modifiers.new('Tailored thickness','SOLIDIFY');solid.thickness=.015
    return obj

def cloak(name,rig,mat,length=.42,width=.5):
    # Back (+Y) curved drape, never a peasant vest: real broad mantle silhouette.
    verts=[];faces=[];rings=[(1.51,.40,.12),(1.3,.48,.25),(.95,width,.34),(length,width+.04,.39)]
    for z,w,y in rings:
        for i in range(9):
            x=(i/8*2-1)*w;verts.append((x,y-.12*(x/w)**2,z+(.03 if i%2 else 0)))
    for j in range(3):
        for i in range(8):a=j*9+i;faces.append((a,a+1,a+10,a+9))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);assign(obj,mat)
    g=obj.vertex_groups.new(name='spine_03');g.add(list(range(18)),1,'REPLACE')
    g=obj.vertex_groups.new(name='pelvis');g.add(list(range(18,len(verts))),1,'REPLACE')
    obj.parent=rig;m=obj.modifiers.new('Mantle rig','ARMATURE');m.object=rig
    m=obj.modifiers.new('Cloak thickness','SOLIDIFY');m.thickness=.025
    return obj

def hood(name,rig,mat,trim):
    # A volumetric pointed cowl with a real face opening, not a disk/flat cap.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=16,radius=1,location=(0,.045,1.82))
    obj=bpy.context.object;obj.name=name;obj.scale=(.245,.225,.31)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    import bmesh
    bm=bmesh.new();bm.from_mesh(obj.data)
    # local coords after apply; face opening toward -Y, chin to forehead.
    bmesh.ops.delete(bm,geom=[v for v in bm.verts if v.co.y<-.075 and -.205<v.co.z<.13],context='VERTS')
    for v in bm.verts:
        if v.co.z>.24:v.co.z+=.075;v.co.y+=.025
    bm.to_mesh(obj.data);bm.free();assign(obj,mat)
    m=obj.modifiers.new('Cowl shell thickness','SOLIDIFY');m.thickness=.022
    bone_parent(obj,rig)
    # Neck mantle and pointed collar broaden the hood silhouette.
    collar=ring_garment(name+' shoulder cowl',rig,[(1.36,.40,.22,.04),(1.56,.22,.17,.04)],mat)
    for side in [-1,1]:
        tab=cube(name+' gilt collar clasp',(side*.15,-.18,1.48),(.07,.04,.10),trim,.012);weight_object(tab,rig,'spine_03')

def belt(name,rig,mat,z=.98):
    return ring_garment(name,rig,[(z-.045,.29,.185,0),(z+.045,.29,.185,0)],mat)

def gem(name,rig,loc,mat,bone='spine_03',size=.075):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=size,location=loc)
    obj=bpy.context.object;obj.name=name;obj.scale=(.75,.45,1.2);assign(obj,mat);weight_object(obj,rig,bone);return obj

def make_fantasy(role):
    rig=make_cast(role)
    if role=='mage':return rig
    # Remove the rejected caps/headgear and ordinary visible clothing surfaces.
    prefixes={'analyst':['Analyst linen beret','Analyst green hatband'],
              'checker':['Checker leather cap','Checker brass visor'],
              'reviewer':['Reviewer blue skullcap','Reviewer pale crest'],
              'mentor':['Mentor soft cap']}[role]
    for obj in list(bpy.data.objects):
        if any(obj.name.startswith(p) for p in prefixes):bpy.data.objects.remove(obj,do_unlink=True)
    for obj in bpy.data.objects:
        if obj.type!='MESH' or obj.parent!=rig:continue
        if role in ['analyst','mentor'] and any(s in obj.name for s in ['_Body','_Legs']):obj.hide_render=True
        if role=='reviewer' and '_Body' in obj.name:obj.hide_render=True
        # Own tunic/surcoat hides the underlying trouser shell. Keeping both
        # intersected at the knee during stride; boots remain fully rendered.
        if role in ['checker','reviewer'] and '_Legs' in obj.name:obj.hide_render=True
    gold=material(role+' old gold',(.59,.35,.08),.65,.38)
    dark=material(role+' charcoal leather',(.034,.045,.05))
    ivory=material(role+' parchment silk',(.66,.58,.39))
    silver=material(role+' tempered silver',(.38,.46,.55),.78,.32)
    cyan=material(role+' luminous rune',(.02,.37,.52),.1,.32,.35)
    if role=='analyst':
        cloth=material('Cartographer petrol velvet',(.025,.22,.25));deep=material('Cartographer midnight mantle',(.022,.075,.13))
        ring_garment('Cartographer full pleated robes',rig,[(.28,.36,.27,0),(.64,.34,.25,0),(.96,.27,.17,0),(1.08,.28,.18,0),(1.32,.37,.19,0),(1.45,.35,.16,.02)],cloth,split_legs=True)
        cloak('Cartographer asymmetric mantle',rig,deep,length=.52,width=.48);hood('Cartographer pointed hood',rig,deep,gold);belt('Cartographer scroll belt',rig,gold)
        # Scroll rack and satchel read as a runewriter/cartographer, not a villager.
        bag=cube('Cartographer map satchel',(-.27,.12,.92),(.29,.15,.31),dark,.035);weight_object(bag,rig,'pelvis')
        for x in [-.32,-.19]:
            scroll=cylinder('Cartographer bound scroll',(x,.14,1.01),.049,.36,ivory,12);weight_object(scroll,rig,'pelvis')
            cap=cylinder('Cartographer scroll gold end',(x,.14,1.20),.055,.03,gold,12);weight_object(cap,rig,'pelvis')
        gem('Cartographer rune amulet',rig,(0,-.20,1.32),cyan,size=.06)
    elif role=='checker':
        cloth=material('Ranger forest mantle',(.045,.17,.08));edge=material('Ranger moss green cowl',(.13,.29,.12))
        cloak('Ranger broad travelling cloak',rig,cloth,length=.32,width=.54);hood('Ranger pointed forest hood',rig,edge,gold)
        # Long quilted tunic replaces the modern-looking short vest silhouette.
        ring_garment('Ranger leather long tunic',rig,[(.64,.29,.22,0),(.93,.29,.19,0),(1.12,.29,.18,0),(1.42,.34,.17,0)],dark,split_legs=True);belt('Ranger belt',rig,gold)
        quiver=cylinder('Ranger rear quiver',(.22,.32,1.14),.1,.62,dark,12);quiver.rotation_euler.y=-.22;weight_object(quiver,rig,'spine_01')
        for i in range(3):
            arrow=cylinder('Ranger arrow shaft',(.17+i*.044,.32,1.64),.009,.49,gold,8);weight_object(arrow,rig,'spine_03')
            feather=cube('Ranger arrow fletching',(.17+i*.044,.32,1.88),(.025,.065,.08),ivory,.005);weight_object(feather,rig,'spine_03')
        gem('Ranger bronze trail sigil',rig,(0,-.22,1.40),gold,size=.065)
    elif role=='reviewer':
        blue=material('Guardian royal surcoat',(.025,.075,.23))
        ring_garment('Guardian plated chest',rig,[(.99,.29,.20,0),(1.14,.32,.23,0),(1.33,.38,.23,0),(1.49,.35,.17,0)],silver)
        ring_garment('Guardian split heraldic surcoat',rig,[(.50,.30,.20,0),(.86,.31,.23,0),(1.0,.29,.20,0)],blue,split_legs=True)
        cloak('Guardian gold-lined short cape',rig,blue,length=.66,width=.45);hood('Guardian pointed great helm',rig,silver,gold);belt('Guardian brass cuirass belt',rig,gold)
        for side in [-1,1]:
            pauldron=cube('Guardian winged pauldron',(side*.43,.01,1.42),(.25,.35,.16),silver,.06);weight_object(pauldron,rig,'clavicle_l' if side>0 else 'clavicle_r')
        # Heraldic shield stowed on the back does not constrain handoff gestures.
        verts=[(-.27,.46,1.38),(.27,.46,1.38),(.30,.46,1.12),(0,.46,.74),(-.30,.46,1.12)]
        mesh=bpy.data.meshes.new('Guardian kite shield');mesh.from_pydata(verts,[],[(0,1,2,3,4)]);mesh.update()
        shield=bpy.data.objects.new('Guardian kite shield',mesh);bpy.context.collection.objects.link(shield);assign(shield,gold);weight_object(shield,rig,'spine_01');solid=shield.modifiers.new('Forged shield thickness','SOLIDIFY');solid.thickness=.05
        gem('Guardian breastplate proof seal',rig,(0,-.25,1.30),cyan,size=.09)
    else:
        blue=material('Sage deep sapphire robe',(.035,.10,.22));cream=material('Sage warm ivory outer robe',(.62,.56,.41))
        ring_garment('Sage floor length flowing robes',rig,[(.12,.40,.29,0),(.48,.37,.27,0),(.95,.29,.19,0),(1.12,.30,.20,0),(1.42,.38,.20,.01)],blue,split_legs=True)
        cloak('Sage broad ivory mantle',rig,cream,length=.20,width=.53);hood('Sage high ivory cowl',rig,cream,gold);belt('Sage ceremonial golden sash',rig,gold)
        # Long front stole, rune amulet, floating crystal staff, leather spellbook.
        stole=cube('Sage gold-bordered stole',(0,-.235,.90),(.15,.045,.78),gold,.012);weight_object(stole,rig,'pelvis')
        inset=cube('Sage ivory stole inset',(0,-.264,.90),(.105,.012,.73),cream,.006);weight_object(inset,rig,'pelvis')
        for z in [.65,.85,1.05]:gem('Sage stole rune',rig,(0,-.28,z),cyan,'pelvis',.025)
        staff=cylinder('Sage rune staff',(-.42,.18,1.14),.025,2.16,dark,16);weight_object(staff,rig,'spine_01')
        gem('Sage staff luminous crystal',rig,(-.42,.18,2.26),cyan,'spine_01',.105)
        orb=cylinder('Sage staff gold crown',(-.42,.18,2.17),.08,.055,gold,12);weight_object(orb,rig,'spine_01')
        book=cube('Sage brass bound grimoire',(.31,-.05,.99),(.22,.17,.35),gold,.015);weight_object(book,rig,'pelvis')
        pages=cube('Sage grimoire parchment',(.31,-.146,.99),(.18,.025,.28),ivory,.006);weight_object(pages,rig,'pelvis')
        gem('Sage grimoire seal',rig,(.31,-.165,.99),cyan,'pelvis',.055)
    return rig
