"""Read-only gate for bundled hash integrity, atlas bounds, pivots and provenance."""
import argparse,hashlib,json
from pathlib import Path
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('--assets',type=Path,default=Path('tools/ai-graph-viewer/assets/rpg'));args=p.parse_args();base=args.assets
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
provenance=json.loads((base/'guild-provenance.json').read_text());manifest=json.loads((base/'guild-cast.json').read_text())
for name,record in provenance['files'].items():
    assert '/' not in name and '\\' not in name,'Unsafe filename'
    path=base/name
    assert path.is_file() and sha(path)==record['sha256'],'Bundled hash mismatch: '+name
    assert path.stat().st_size==record['bytes'],'Size mismatch'
assert provenance['license']=='CC0-1.0'
assert provenance['visualRevision']==manifest['visualRevision']=='fantasy-v2'
assert provenance['rootApprovedBasis'] and manifest['rootApprovedBasis']
assert len(provenance['visualPreviewProofs'])>=10
assert len(provenance['sources'])==4 and len(provenance['licenses'])==4
assert all('CC0' in item['text'] for item in provenance['licenses'])
assert 'workClipClaim' in provenance['originalAuthoring'] and not provenance['originalAuthoring']['workClipClaim']
assert not provenance['originalAuthoring']['handoffClipClaim']
assert manifest['frameSize']==[256,320] and manifest['fps']==12
assert set(manifest['roles'])=={'analyst','mage','checker','reviewer','mentor'}
assert len(manifest['foregrounds'])==5
assert len(manifest['directions'])==4
frames=0;atlases=0
for role,entry in manifest['roles'].items():
    assert set(entry['states'])=={'idle','walk','work','handoff'}
    for state,directions in entry['states'].items():
        assert set(directions)==({'se','nw','ne','sw'} if state=='walk' else {'se','nw'})
        for direction,s in directions.items():
            atlas=json.loads((base/s['atlas']).read_text());image=Image.open(base/s['image'])
            assert image.mode=='RGBA' and max(image.size)<=2048
            assert atlas['meta']['image']==s['image'] and len(atlas['frames'])==s['frames']
            assert set(atlas['animations'])=={state} and len(atlas['animations'][state])==s['frames']
            assert s['authored']==(state in ['work','handoff'])
            assert s['clip']==({'idle':'Idle_Loop','walk':'Walk_Loop'}.get(state))
            if state=='walk':assert .9<s['metersPerSecond']<1.1
            rectangles=[]
            for name in atlas['animations'][state]:
                f=atlas['frames'][name];r=f['frame'];x,y,w,h=[r[v] for v in ['x','y','w','h']]
                assert (w,h)==(256,320) and not f['trimmed'] and not f['rotated']
                assert abs(f['anchor']['x']-manifest['anchor'][0])<1e-7 and abs(f['anchor']['y']-manifest['anchor'][1])<1e-7
                assert 0<=x<=image.width-w and 0<=y<=image.height-h
                assert (x,y) not in rectangles;rectangles.append((x,y))
                bounds=image.crop((x,y,x+w,y+h)).getchannel('A').getbbox()
                assert bounds and bounds[0]>=2 and bounds[1]>=2 and bounds[2]<=254 and bounds[3]<=318,'Empty/clipped alpha frame'
            frames+=s['frames'];atlases+=1
assert atlases==50 and frames==860
for f in manifest['foregrounds']:
    img=Image.open(base/f['file']);assert img.mode=='RGBA' and img.size==(1440,1080)
    bbox=img.getchannel('A').getbbox()
    assert bbox and isinstance(f['depthY'],(int,float))
    assert f['alphaFrame']==list(bbox),'Foreground alphaFrame does not match actual PNG alpha'
    assert all(isinstance(v,int) for v in f['alphaFrame'])
assert Image.open(base/manifest['room']).size==(1440,1080)
assert Image.open(base/manifest['mentorPortrait']).size==(256,320)
text=(base/'guild-provenance.json').read_text()
assert '/Users/' not in text and 'projectRoot' not in text and 'executorConnected' not in text
print(json.dumps(dict(status='PASS',atlases=atlases,frames=frames,files=len(provenance['files']),hashes='all exact',directions='4 walk / 2 other states',originalGestures=True),indent=2))
