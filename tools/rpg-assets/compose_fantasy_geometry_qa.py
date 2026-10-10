"""Repeatable dark/light/stride inspection and selected-frame alpha gate."""
from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib
b=Path('output/product-completion/rpg/cast/fantasy-v2/geometry-qa');rows=[]
out=Image.new('RGBA',(2048,1280),(27,33,48,255));roles=['analyst','checker','reviewer','mentor']
for r,role in enumerate(roles):
 for c,phase in enumerate([0,8,16,24]):
  for d,direction in enumerate(['se','nw']):
   img=Image.open(b/f'{role}-walk-{direction}-{phase:02}.png');out.alpha_composite(img,(c*256+d*1024,r*320))
   ImageDraw.Draw(out).text((c*256+d*1024+5,r*320+5),role+' '+direction+' '+str(phase),fill='white')
out.save(b/'walk-clearance-sheet.png')
for p in sorted(b.glob('*.png')):
 if p.name.endswith('sheet.png'):continue
 img=Image.open(p);box=img.getchannel('A').getbbox();assert img.size==(256,320) and box and box[0]>=2 and box[1]>=2 and box[2]<=254 and box[3]<=318
 rows.append(dict(file=p.name,bounds=box,sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
light=Image.new('RGBA',(1024,640),(234,228,211,255));dark=Image.new('RGBA',light.size,(18,24,38,255))
for i,role in enumerate(roles):
 for j,state in enumerate(['handoff-se-03','work-nw-00']):
  img=Image.open(b/f'{role}-{state}.png');light.alpha_composite(img,(i*256,j*320));dark.alpha_composite(img,(i*256,j*320))
light.save(b/'light-clearance-sheet.png');dark.save(b/'dark-clearance-sheet.png')
record=dict(status='PASS',frames=len(rows),alphaBounds=True,framesChecked=rows,scope='selected stride phases and authored poses; visual cloth/face checks separate')
(b/'checks.json').write_text(json.dumps(record,indent=2)+'\n');print('Alpha PASS',len(rows))
