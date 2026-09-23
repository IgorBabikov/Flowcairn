import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const local=name=>new URL(name,import.meta.url);
const files=new Map([
 ['/',[local('index.html'),'text/html; charset=utf-8']],
 ['/index.html',[local('index.html'),'text/html; charset=utf-8']],
 ['/style.css',[local('style.css'),'text/css; charset=utf-8']],
 ['/app.js',[local('app.js'),'text/javascript; charset=utf-8']],
 ['/fonts/Manrope-Cyrillic-Variable.woff2',[local('../../../tools/ai-graph-viewer/src/assets/Manrope-Cyrillic-Variable.woff2'),'font/woff2']],
 ['/fonts/Manrope-Latin-Variable.woff2',[local('../../../tools/ai-graph-viewer/src/assets/Manrope-Latin-Variable.woff2'),'font/woff2']],
]);
const server=createServer((req,res)=>{
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
 const file=files.get(new URL(req.url,'http://127.0.0.1').pathname);
 if(!file){res.writeHead(404).end();return;}
 try{const data=readFileSync(file[0]);res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:data);}catch{res.writeHead(500).end('Preview asset unavailable');}
});
server.listen(4351,'127.0.0.1',()=>console.log('Flowcairn wide-screen prototype: http://127.0.0.1:4351/'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
