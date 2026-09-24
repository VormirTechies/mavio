const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const base=__dirname;
http.createServer((req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/delayed-core.js'){res.setHeader('Content-Type','text/javascript');const timer=setTimeout(()=>res.end('// deliberately delayed test asset'),15000);res.on('close',()=>clearTimeout(timer));return;}
 const presetUploads=require('./presets.json').map(p=>'/save/preset-browser-'+p.id+'.'+p.format);
 if(req.method==='POST' && ['/save/browser-trim.mp4','/save/browser-results.json','/save/preset-browser-results.json','/save/init-browser-results.json',...presetUploads].includes(url.pathname)){
  const target=path.join(base,path.basename(url.pathname));const out=fs.createWriteStream(target);req.pipe(out);out.on('finish',()=>res.end('saved'));return;
 }
 const file=path.resolve(base,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
 if(!file.startsWith(base+path.sep)){res.writeHead(403);res.end();return;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.mp4':'video/mp4','.json':'application/json'})[path.extname(file)]||'application/octet-stream');
 const s=fs.createReadStream(file);s.on('error',()=>{res.writeHead(404);res.end();});s.pipe(res);
}).listen(4387,'127.0.0.1',()=>console.log('Mavio feasibility at http://127.0.0.1:4387'));
