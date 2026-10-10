"""Pack untrimmed frames and report alpha/clipping/root/pivot quality checks."""
import hashlib
import json
import math
import statistics
from pathlib import Path
from PIL import Image, ImageDraw

BASE=Path('output/product-completion/rpg')
contract=json.loads((BASE/'hero-contract.json').read_text())
checks={}
for state,record in contract['states'].items():
    images=[Image.open(BASE/'frames'/state/f'{i:03}.png').convert('RGBA') for i in range(record['frames'])]
    width,height=contract['width'],contract['height']
    columns=min(6,len(images));rows=math.ceil(len(images)/columns)
    atlas=Image.new('RGBA',(columns*width,rows*height))
    data=dict(frames={},animations={state:[]},meta=dict(image=state+'.png',size=dict(w=atlas.width,h=atlas.height),scale='1'))
    bounds=[]
    for i,img in enumerate(images):
        if img.size!=(width,height):raise RuntimeError('Frame size mismatch')
        bound=img.getchannel('A').getbbox()
        if bound is None:raise RuntimeError('Empty render')
        if bound[0]<2 or bound[1]<2 or bound[2]>width-2 or bound[3]>height-2:raise RuntimeError('Clipped frame')
        bounds.append(bound)
        x=i%columns*width;y=i//columns*height
        atlas.paste(img,(x,y))
        name=f'{state}_{i:03}.png'
        data['frames'][name]=dict(frame=dict(x=x,y=y,w=width,h=height),rotated=False,trimmed=False,
            spriteSourceSize=dict(x=0,y=0,w=width,h=height),sourceSize=dict(w=width,h=height),
            anchor=dict(x=contract['anchor'][0],y=contract['anchor'][1]))
        data['animations'][state].append(name)
    if max(atlas.size)>2048:raise RuntimeError('Atlas exceeds 2048 limit')
    destination=BASE/'atlases';destination.mkdir(exist_ok=True)
    atlas.save(destination/(state+'.png'),optimize=True)
    (destination/(state+'.json')).write_text(json.dumps(data,indent=2)+'\n')
    # A visual timeline, with a fixed floor baseline and stable origin marker.
    previews=[]
    for i in range(min(6,len(images))):
        img=Image.new('RGBA',(width,height),(27,33,48,255));draw=ImageDraw.Draw(img)
        px,py=contract['pivot'];draw.line((0,py,width,py),fill=(67,83,101),width=1)
        img.alpha_composite(images[round(i*(len(images)-1)/5)])
        draw=ImageDraw.Draw(img);draw.ellipse((px-3,py-3,px+3,py+3),fill=(240,184,77))
        previews.append(img)
    strip=Image.new('RGBA',(width*len(previews),height))
    for i,img in enumerate(previews):strip.paste(img,(i*width,0))
    strip.save(BASE/(state+'-contact-sheet.png'))
    # Animated previews, baseline 12 fps, are art animation rather than live work.
    gif=[]
    for img in images:
        bg=Image.new('RGBA',img.size,(27,33,48,255));bg.alpha_composite(img);gif.append(bg.convert('RGB'))
    gif[0].save(BASE/(state+'-preview.gif'),save_all=True,append_images=gif[1:],duration=round(1000/12),loop=0)
    roots=[s['bones']['root'] for s in record['metrics']]
    root_span=max(max(v[j] for v in roots)-min(v[j] for v in roots) for j in range(3))
    checks[state]=dict(frames=len(images),size=list(atlas.size),bounds=bounds,rootSpanMeters=root_span,
                       fixedPivot=contract['pivot'],clipping=False,sha256=hashlib.sha256((destination/(state+'.png')).read_bytes()).hexdigest())
    if root_span>1e-4:raise RuntimeError('Unexpected root motion')
    if state=='idle':
        movement=max(max(s['bones'][bone][axis] for s in record['metrics'])-min(s['bones'][bone][axis] for s in record['metrics'])
                     for bone in ['ball_l','ball_r'] for axis in range(3))
        checks[state]['toeDriftMeters']=movement
        if movement>.001:raise RuntimeError('Idle feet drift exceeds 1 mm')
    if state=='walk':
        # Exclude lifted feet and landing/toe-off transitions from planted phase.
        velocities=[]
        for bone in ['ball_l','ball_r']:
            for a,b in zip(record['metrics'],record['metrics'][1:]):
                p=a['bones'][bone];q=b['bones'][bone];v=(q[1]-p[1])*contract['fps']
                if max(p[2],q[2])<.025 and v>.8:velocities.append(v)
        speed=statistics.median(velocities)
        checks[state]['calibration']=dict(forwardLocal=[0,-1,0],metersPerSecondAt12Fps=speed,
            plantedSegments=len(velocities),maxPlantResidualMetersPerFrame=max(abs(v-speed)/contract['fps'] for v in velocities),
            verifiedScope='offline selected clip; runtime navigation/turning not verified')
(BASE/'atlas-checks.json').write_text(json.dumps(checks,indent=2)+'\n')
print(json.dumps(checks,indent=2))
