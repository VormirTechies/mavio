const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),assert=require('node:assert/strict');
const ffmpeg=require('ffmpeg-static'),ffprobe=require('ffprobe-static').path;
function run(bin,args,encoding){const r=spawnSync(bin,args,{encoding,windowsHide:true,timeout:60000,maxBuffer:32e6});assert.equal(r.status,0,String(r.stderr));return r.stdout;}
function frame(file,n){return run(ffmpeg,['-v','error','-i',file,'-vf',`select=eq(n\\,${n})`,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','-']);}
function psnr(a,b){assert.equal(a.length,b.length);let sum=0;for(let i=0;i<a.length;i++)sum+=(a[i]-b[i])**2;return 10*Math.log10(255**2/(sum/a.length));}
const evidence=[];
for(const file of ['native-trim.mp4','browser-trim.mp4']){
 const p=JSON.parse(run(ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',file],'utf8'));
 const v=p.streams.find(s=>s.codec_type==='video');
 assert.equal(Number(v.nb_read_frames),60);
 assert.ok(Math.abs(Number(v.start_time))<1/24);
 run(ffmpeg,['-v','error','-i',file,'-f','null','-'],'utf8');
 const first=psnr(frame('fixture.mp4',30),frame(file,0));
 const last=psnr(frame('fixture.mp4',89),frame(file,59));
 assert.ok(first>30 && last>30,`Boundary mismatch ${first},${last}`);
 evidence.push({file,frameCount:Number(v.nb_read_frames),startTime:v.start_time,duration:p.format.duration,firstFramePSNR:first,lastFramePSNR:last,decoded:true});
}
fs.writeFileSync('output-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
