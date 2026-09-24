const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ffmpeg=require('ffmpeg-static'),ffprobe=require('ffprobe-static').path;
function resolveTool(name,explicit,searchPath){
 const exe=name+'.exe';
 if(explicit){if(!path.isAbsolute(explicit))throw Error('INVALID_OPTIONS');if(!fs.statSync(explicit,{throwIfNoEntry:false})?.isFile())throw Error('ENGINE_UNAVAILABLE');return explicit;}
 for(const dir of searchPath.split(path.delimiter).filter(Boolean)){if(!path.isAbsolute(dir))continue;const candidate=path.join(dir,exe);if(fs.statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;}
 throw Error('ENGINE_UNAVAILABLE');
}
function version(exe,timeoutMs=5000,signal,args=['-version']){
 return new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(Error('CANCELLED'));
 const p=spawn(exe,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output='',failure;
 const stop=code=>{failure=code;p.kill();};const timer=setTimeout(()=>stop('ENGINE_INIT_FAILED:TIMEOUT'),timeoutMs);
 const abort=()=>stop('CANCELLED');signal?.addEventListener('abort',abort,{once:true});
 const append=chunk=>{output+=chunk.toString();if(output.length>65536)stop('ENGINE_INIT_FAILED:OUTPUT_LIMIT');};p.stdout.on('data',append);p.stderr.on('data',append);
 p.once('error',e=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);});
 p.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure)return reject(Error(failure));if(code!==0)return reject(Error('ENGINE_INIT_FAILED'));resolve(output.split(/\r?\n/)[0]);});
 });
}
(async()=>{
 const checks=[];
 const explicit=resolveTool('ffmpeg',ffmpeg,'');assert.equal(explicit,ffmpeg);checks.push('explicit absolute binary path');
 assert.equal(resolveTool('ffmpeg',undefined,path.dirname(ffmpeg)),ffmpeg);checks.push('controlled PATH discovery');
 assert.throws(()=>resolveTool('ffmpeg',path.resolve('does-not-exist.exe'),path.dirname(ffmpeg)),/ENGINE_UNAVAILABLE/);checks.push('invalid explicit path does not fall back');
 assert.throws(()=>resolveTool('ffmpeg',undefined,''),/ENGINE_UNAVAILABLE/);checks.push('missing PATH candidate');
 assert.throws(()=>resolveTool('ffmpeg','relative.exe',''),/INVALID_OPTIONS/);checks.push('relative override rejected');
 const versions={ffmpeg:await version(explicit),ffprobe:await version(ffprobe)};
 await assert.rejects(version(process.execPath,100,undefined,['-e','setInterval(()=>{},1000)']),/TIMEOUT/);checks.push('timeout kills helper process');
 const ac=new AbortController();ac.abort();await assert.rejects(version(ffmpeg,5000,ac.signal),/CANCELLED/);checks.push('pre-aborted signal');
 const live=new AbortController();const pending=version(process.execPath,5000,live.signal,['-e','setInterval(()=>{},1000)']);setTimeout(()=>live.abort(),100);await assert.rejects(pending,/CANCELLED/);checks.push('active initialization abort kills helper');
 await version(ffmpeg);checks.push('successful retry after timeout/abort');
 fs.writeFileSync('init-native-results.json',JSON.stringify({platform:process.platform,node:process.version,checks,versions,passed:true},null,2));console.log(checks.join('\n'));
})().catch(e=>{console.error(e);process.exitCode=1;});
