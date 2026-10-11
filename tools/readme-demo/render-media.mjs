import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Capture on macOS, where the project UI was verified. ffmpeg must be installed.
const output=path.resolve('output/readme-demo/plates');mkdirSync(output,{recursive:true});
const data=JSON.parse(readFileSync('.github/media/demo/recording.json','utf8'));
const ids=['request','plan','work','repair','result','code'];
for(const [i,id] of ids.entries()){
 const f=data.frames.find(f=>f.id===id);
 const label=`${i+1} / ${ids.length}   ${f.title}`.replaceAll('&','&amp;').replaceAll('<','&lt;');
 const image=readFileSync(`.github/media/demo/${f.image}`).toString('base64');
 const svg=path.join(output,`${i}.svg`);
 writeFileSync(svg,`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="660"><rect width="960" height="660" fill="#14241e"/><text x="24" y="38" font-family="Arial,sans-serif" font-size="24" fill="#faf0d8">${label}</text><image x="0" y="60" width="960" height="600" href="data:image/jpeg;base64,${image}"/></svg>`);
 execFileSync('rsvg-convert',[svg,'-o',path.join(output,`${i}.png`)]);
}
writeFileSync(path.join(output,'frames.txt'),ids.map((_,i)=>`file '${i}.png'\nduration 3`).join('\n')+`\nfile '5.png'\n`);
execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',path.join(output,'frames.txt'),'-vf','fps=2,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3','-loop','0','.github/media/flowcairn-walkthrough.gif']);
execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i','output/readme-demo/session.webm','-an','-c:v','libx264','-preset','fast','-crf','26','-pix_fmt','yuv420p','-movflags','+faststart','.github/media/demo/session.mp4']);
