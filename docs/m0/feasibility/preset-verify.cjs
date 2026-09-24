const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ffmpeg=require('ffmpeg-static'),ffprobe=require('ffprobe-static').path;
const presets=require('./presets.json');const expected=['h264','h264','mp3','pcm_s16le','mjpeg','png'];
function run(bin,args){const r=spawnSync(bin,args,{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8e6});assert.equal(r.status,0,r.stderr);return r;}
const result=[];
for(const runtime of ['native','browser'])for(const [i,p] of presets.entries()){
 const file=`preset-${runtime}-${p.id}.${p.format}`;
 const metadata=JSON.parse(run(ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',file]).stdout);
 assert.equal(metadata.streams[0].codec_name,expected[i]);
 run(ffmpeg,['-v','error','-i',file,'-f','null','-']);
 let psnr;
 if(i<2){
 const v=metadata.streams[0];assert.equal(v.width,320);assert.equal(v.height,180);assert.equal(v.r_frame_rate,'24/1');assert.equal(Number(v.nb_read_frames),144);
 const metric=run(ffmpeg,['-i',file,'-i','fixture.mp4','-lavfi','[0:v][1:v]psnr','-an','-f','null','-']).stderr;
 psnr=Number(metric.match(/average:([\d.]+)/)[1]);assert.ok(Number.isFinite(psnr));
 }
 result.push({runtime,preset:p.id,codec:metadata.streams[0].codec_name,duration:metadata.format.duration,psnr,bytes:fs.statSync(file).size,decoded:true});
}
fs.writeFileSync('preset-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
