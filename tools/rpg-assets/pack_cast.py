"""Pack verified frames into bounded Pixi atlases and exact bundled provenance."""
import json,math,hashlib,statistics,shutil,subprocess,sys
from pathlib import Path
from PIL import Image,ImageDraw
BASE=Path('output/product-completion/rpg');OUT=BASE/'cast';FINAL=Path('tools/ai-graph-viewer/assets/rpg');DEST=OUT/'bundle-staging';DEST.mkdir(exist_ok=True)
ROLES=['analyst','mage','checker','reviewer','mentor']
def read(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def apply_foreground_alpha_frames(manifest, assets):
    """PIL bounding box uses exclusive maximums; no PNG pixels are changed."""
    for foreground in manifest['foregrounds']:
        image=Image.open(assets/foreground['file'])
        bbox=image.getchannel('A').getbbox()
        if image.mode!='RGBA' or image.size!=(1440,1080) or bbox is None:
            raise RuntimeError('Invalid foreground alpha '+foreground['file'])
        foreground['alphaFrame']=list(bbox)

if '--metadata-only' in sys.argv:
    previous=read(FINAL/'guild-provenance.json')
    for name,record in previous['files'].items():
        if sha(FINAL/name)!=record['sha256']:raise RuntimeError('Existing asset changed '+name)
        shutil.copyfile(FINAL/name,DEST/name)
    manifest=read(DEST/'guild-cast.json')
    apply_foreground_alpha_frames(manifest,DEST)
    (DEST/'guild-cast.json').write_text(json.dumps(manifest,indent=2)+'\n')
    previous['files']['guild-cast.json']=dict(sha256=sha(DEST/'guild-cast.json'),bytes=(DEST/'guild-cast.json').stat().st_size)
    previous['tools']={name:sha(Path('tools/rpg-assets')/name) for name in previous['tools']}
    (DEST/'guild-provenance.json').write_text(json.dumps(previous,indent=2)+'\n')
    gate=subprocess.run([sys.executable,'tools/rpg-assets/check_cast.py','--assets',str(DEST)],capture_output=True,text=True)
    (OUT/'metadata-staging-check.log').write_text(gate.stdout+gate.stderr)
    if gate.returncode:raise RuntimeError('Metadata staging gate failed; active assets unchanged')
    for name,record in previous['files'].items():
        if name.endswith('.png') and sha(DEST/name)!=record['sha256']:
            raise RuntimeError('Metadata-only operation changed PNG '+name)
    for name in ['guild-cast.json','guild-provenance.json']:shutil.copyfile(DEST/name,FINAL/name)
    print(json.dumps(dict(metadataOnly=True,pngsUnchanged=sum(n.endswith('.png') for n in previous['files']),foregrounds=manifest['foregrounds'],manifestSha256=sha(FINAL/'guild-cast.json'),provenanceSha256=sha(FINAL/'guild-provenance.json')),indent=2))
    sys.exit(0)
room=read(OUT/'room-contract.json')
acceptance=read(OUT/'fantasy-v2/ROOT-ART-ACCEPTANCE.json')
geometry=read(OUT/'fantasy-v2/geometry-qa/checks.json')
if geometry.get('status')!='PASS' or geometry.get('visualInspection',{}).get('status')!='PASS':raise RuntimeError('Fantasy geometry gate not passed')
if acceptance.get('status')!='ROOT_ACCEPTED_AS_INTEGRATION_BASIS':raise RuntimeError('Fantasy visual basis not accepted')
projection=room['projection'];origin=projection['origin']
bx=[projection['unitX'][i]-origin[i] for i in range(2)];by=[projection['unitY'][i]-origin[i] for i in range(2)]
directions={}
for name,yaw,forward,screen in [('se',0,[0,-1,0],[-v for v in by]),('nw',math.pi,[0,1,0],by),('ne',math.pi/2,[1,0,0],bx),('sw',math.pi*1.5,[-1,0,0],[-v for v in bx])]:
    directions[name]=dict(yawRadians=yaw,forwardLocal=[0,-1,0],forwardWorld=forward,screenVector=screen)
manifest=dict(schemaVersion=1,visualRevision='fantasy-v2',rootApprovedBasis=True,alpha='straight RGBA PNG',trimmed=False,sourceFps=24,frameSize=[256,320],fps=12,pivot=[128.00009155,241.91650391],anchor=[.5000003576,.7559890747],spriteScale=room['spriteScale'],resolution=room['resolution'],camera=room['camera'],projection=projection,room=room['room'],directions=directions,roles={},foregrounds=room['foregrounds'])
checks={};files=[]
for role in ROLES:
    c=read(OUT/(role+'-contract.json'))
    if role!='mage' and c.get('visualRevision')!='fantasy-v2':raise RuntimeError('Unaccepted old role contract '+role)
    entry=dict(station=room['stations'][role],states={})
    for key,s in c['states'].items():
        state,direction=key.split('-');name=f'guild-{role}-{state}-{direction}'
        imgs=[Image.open(OUT/'frames'/role/direction/state/f'{i:03}.png').convert('RGBA') for i in range(s['frames'])]
        expected=30 if state=='idle' else 16 if state=='walk' else 12
        if len(imgs)!=expected:raise RuntimeError('Incomplete render '+name)
        cols=min(6,len(imgs));rows=math.ceil(len(imgs)/cols);atlas=Image.new('RGBA',(cols*256,rows*320))
        if max(atlas.size)>2048:raise RuntimeError('Atlas over budget')
        data=dict(frames={},animations={state:[]},meta=dict(image=name+'.png',size=dict(w=atlas.width,h=atlas.height),scale='1'))
        bounds=[]
        for i,img in enumerate(imgs):
            if img.size!=(256,320):raise RuntimeError('Frame shape')
            box=img.getchannel('A').getbbox()
            if box is None or box[0]<2 or box[1]<2 or box[2]>254 or box[3]>318:raise RuntimeError('Alpha/clipping '+name+str(box))
            bounds.append(box);x=i%cols*256;y=i//cols*320;atlas.paste(img,(x,y));n=f'{state}_{i:03}.png'
            data['frames'][n]=dict(frame=dict(x=x,y=y,w=256,h=320),rotated=False,trimmed=False,spriteSourceSize=dict(x=0,y=0,w=256,h=320),sourceSize=dict(w=256,h=320),anchor=dict(x=c['anchor'][0],y=c['anchor'][1]))
            data['animations'][state].append(n)
        atlas.save(DEST/(name+'.png'),optimize=True);(DEST/(name+'.json')).write_text(json.dumps(data,separators=(',',':'))+'\n')
        if role=='mage':
            approved=read(OUT/'rejected-peasant/guild-provenance.json')['files']
            for suffix in ['.png','.json']:
                if sha(DEST/(name+suffix))!=approved[name+suffix]['sha256']:raise RuntimeError('Approved immutable mage changed '+name+suffix)
        files += [name+'.png',name+'.json']
        roots=[m['bones']['root'] for m in s['metrics']]
        span=max(max(v[j] for v in roots)-min(v[j] for v in roots) for j in range(3))
        if span>1e-4:raise RuntimeError('Root motion '+name)
        feet=max(max(m['bones'][b][a] for m in s['metrics'])-min(m['bones'][b][a] for m in s['metrics']) for b in ['ball_l','ball_r'] for a in range(3))
        if state!='walk' and feet>.001:raise RuntimeError('Planted foot drift '+name)
        check=dict(frames=len(imgs),atlasSize=list(atlas.size),bounds=bounds,rootSpanMeters=span,toeSpanMeters=feet,clipping=False)
        speed=None
        if state=='walk':
            velocities=[]
            for bone in ['ball_l','ball_r']:
                for a,b in zip(s['metrics'],s['metrics'][1:]):
                    p=a['bones'][bone];q=b['bones'][bone];v=(q[1]-p[1])*12
                    if max(p[2],q[2])<.025 and v>.8:velocities.append(v)
            speed=statistics.median(velocities)
            check['walkCalibration']=dict(metersPerSecond=speed,plantResidualMetersPerFrame=max(abs(v-speed)/12 for v in velocities),segments=len(velocities),scope='selected offline clip; runtime traversal not verified')
        checks[name]=check
        entry['states'].setdefault(state,{})[direction]=dict(image=name+'.png',atlas=name+'.json',frames=len(imgs),durationSeconds=len(imgs)/12,atlasSize=list(atlas.size),rootMotion=False,clip=s['clip'],authored=s['authored'],loop=state!='handoff',metersPerSecond=speed)
    for state,directions in entry['states'].items():
        expectedDirections={'se','nw','ne','sw'} if state=='walk' else {'se','nw'}
        if set(directions)!=expectedDirections:raise RuntimeError('Missing direction '+role+' '+state)
    manifest['roles'][role]=entry
for name in [room['room']]+[r['file'] for r in room['foregrounds']]:
    img=Image.open(OUT/name)
    if img.size!=(1440,1080) or img.mode!='RGBA':raise RuntimeError('Layer mismatch '+name)
    img.save(DEST/name,optimize=True);files.append(name)
apply_foreground_alpha_frames(manifest,DEST)
portrait='guild-mentor-portrait.png';shutil.copyfile(OUT/'frames/mentor/se/idle/000.png',DEST/portrait);files.append(portrait)
manifest['mentorPortrait']=portrait
(DEST/'guild-cast.json').write_text(json.dumps(manifest,indent=2)+'\n');files.append('guild-cast.json')
inputs={**read(OUT/'inputs.json'),**read(OUT/'room-inputs.json')}
packs=read(Path('tools/rpg-assets/standard-sources.lock.json'))['packs']
licenses=[]
for p in sorted((BASE/'extracted').rglob('*')):
    if p.name in ['License.txt','License_Standard.txt']:
        text=p.read_text();assert 'CC0' in text
        licenses.append(dict(path=p.relative_to(BASE/'extracted').as_posix(),sha256=sha(p),text=text))
provenance=dict(schemaVersion=1,visualRevision='fantasy-v2',rootApprovedBasis=True,visualPreviewProofs=acceptance['previewHashes'],geometryProofs={n:sha(OUT/'fantasy-v2/geometry-qa'/n) for n in ['checks.json','walk-clearance-sheet.png','light-clearance-sheet.png','dark-clearance-sheet.png']},license='CC0-1.0',author='Quaternius',sources=packs,licenses=licenses,inputs=inputs,
    originalAuthoring=dict(assemblies='Original fantasy cartographer layered robe/cowl/mantle/scrolls; ranger cowl/cloak/quiver; guardian cuirass/pauldrons/surcoat/helm/shield; sage floor-length robes/cowl/stole/rune staff/grimoire; approved unchanged mage conical hat. Original room props and stable-foot work/handoff IK gestures over static Idle_Loop base pose',license='MIT (Flowcairn original additions); CC0-1.0 (Quaternius models and animation)' ,workClipClaim=False,handoffClipClaim=False),
    renderer=dict(blender='5.1.2',engine='Cycles CPU',samples=24,roomSamples=48,fps=12,transparent=True,rootMotion=False),
    tools={p.name:sha(p) for p in [Path('tools/rpg-assets/'+n) for n in ['cast.py','render_cast.py','render_cast_room.py','pack_cast.py','blender_common.py','hero.py','render_guild.py','check_cast.py','render_room_reference.py','fantasy_cast.py','render_fantasy_preview.py','render_fantasy_geometry_qa.py','compose_fantasy_preview.py','compose_fantasy_geometry_qa.py']]},
    files={n:dict(sha256=sha(DEST/n),bytes=(DEST/n).stat().st_size) for n in files})
(DEST/'guild-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
(OUT/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
# Human inspection sheet across genuinely different assemblies, not colors only.
sheet=Image.new('RGBA',(1280,1280),(27,33,48,255))
for x,role in enumerate(ROLES):
    for y,state in enumerate(['idle','walk','work','handoff']):
        sheet.alpha_composite(Image.open(OUT/'frames'/role/'se'/state/'000.png'),(x*256,y*320))
        ImageDraw.Draw(sheet).text((x*256+8,y*320+8),role+' / '+state,fill='white')
sheet.save(OUT/'contact-sheet.png')
# Restore all room layers before z-sorting cast, using foreground foot depths.
preview=Image.open(DEST/room['room']).convert('RGBA')
layers=[(f['depthY'],Image.open(DEST/f['file']),[0,0]) for f in room['foregrounds']]
for role in ROLES:
    e=manifest['roles'][role];img=Image.open(OUT/'frames'/role/'nw'/'work'/'000.png').convert('RGBA');scale=manifest['spriteScale']
    img=img.resize((round(256*scale),round(320*scale)),Image.Resampling.LANCZOS)
    px,py=e['station']['pixel'];pivot=manifest['pivot'];loc=[round(px-pivot[0]*scale),round(py-pivot[1]*scale)]
    layers.append((py,img,loc))
for _,img,loc in sorted(layers,key=lambda x:x[0]):preview.alpha_composite(img,loc)
preview.save(OUT/'guild-cast-preview.png')
gate=subprocess.run([sys.executable,'tools/rpg-assets/check_cast.py','--assets',str(DEST)],capture_output=True,text=True)
(OUT/'staging-check.log').write_text(gate.stdout+gate.stderr)
if gate.returncode:raise RuntimeError('Staged bundle gate failed; active assets were not replaced')
for name in files+['guild-provenance.json']:
    shutil.copyfile(DEST/name,FINAL/name)
print(json.dumps(dict(atlases=len(checks),frames=sum(v['frames'] for v in checks.values()),bundledBytes=sum((DEST/n).stat().st_size for n in files),roles=ROLES),indent=2))
