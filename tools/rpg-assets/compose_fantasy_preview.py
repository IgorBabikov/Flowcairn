"""Offline visual acceptance sheet and room; no production asset packing."""
from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib
BASE=Path('output/product-completion/rpg/cast');OUT=BASE/'fantasy-v2';ASSETS=Path('tools/ai-graph-viewer/assets/rpg')
roles=['analyst','mage','checker','reviewer','mentor']
labels=['Cartographer / runewriter','Sorcerer','Ranger','Guardian','Sage mentor']
sheet=Image.new('RGBA',(2560,1280),(27,33,48,255))
for i,role in enumerate(roles):
 for j,key in enumerate(['idle-se','work-nw']):
  img=Image.open(OUT/f'{role}-{key}.png').convert('RGBA')
  sheet.alpha_composite(img,(512*i,640*j))
  ImageDraw.Draw(sheet).text((512*i+14,640*j+12),labels[i]+' / '+key,fill='white')
sheet.save(OUT/'fantasy-cast-contact-sheet.png')
room=json.loads((BASE/'room-contract.json').read_text());preview=Image.open(ASSETS/'guild-room.png').convert('RGBA')
layers=[(f['depthY'],Image.open(ASSETS/f['file']),[0,0]) for f in room['foregrounds']]
scale=room['spriteScale']/2;pivot=[256.0001831,483.8330078]
for role in roles:
 img=Image.open(OUT/f'{role}-work-nw.png').convert('RGBA');img=img.resize((round(512*scale),round(640*scale)),Image.Resampling.LANCZOS)
 px,py=room['stations'][role]['pixel'];layers.append((py,img,[round(px-pivot[0]*scale),round(py-pivot[1]*scale)]))
for _,img,loc in sorted(layers,key=lambda x:x[0]):preview.alpha_composite(img,loc)
preview.save(OUT/'fantasy-guild-room-preview.png')
record=dict(status='ART_PREVIEW_AWAITING_EXPLICIT_ROOT_ACCEPTANCE',executorConnected=False,productionPacked=False,oldCastStatus='REJECTED_BY_USER',roles=roles,originalFantasyWardrobe=True,
    images={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.glob('*.png')},
    limitations=['single idle SE and working NW frames only','rigging/walk/hood face clearance still need animation QA after visual acceptance','all five working in room is visual QA, not runtime activity'])
(OUT/'ART-PREVIEW.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
