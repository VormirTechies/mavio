const fs = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16e6 });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  return r.stdout;
}
function probe(file) { return JSON.parse(run(ffprobe, ['-v','error','-show_format','-show_streams','-of','json',file])); }
const trimArgs = input => ['-i',input,'-ss','1.25','-t','2.5','-map','0:v:0','-map','0:a:0','-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart'];
async function main() {
  run(ffmpeg, ['-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest','fixture.mp4']);
  const input = probe('fixture.mp4');
  const progress = run(ffmpeg, ['-y',...trimArgs('fixture.mp4'),'-progress','pipe:1','native-trim.mp4']);
  const output = probe('native-trim.mp4');
  assert.equal(input.streams[0].width,320); assert.equal(input.streams[0].height,180);
  assert.ok(Math.abs(Number(input.format.duration)-6)<0.05);
  assert.ok(Math.abs(Number(output.format.duration)-2.5)<=1/24);
  assert.ok(Math.abs(Number(output.streams[0].start_time))<=1/24);
  run(ffmpeg,['-v','error','-i','native-trim.mp4','-f','null','-']);
  fs.writeFileSync('invalid.bin','not media');
  const invalid = spawnSync(ffprobe,['-v','error','-show_format','-of','json','invalid.bin'],{encoding:'utf8',windowsHide:true});
  assert.notEqual(invalid.status,0);
  const cancel = await new Promise((resolve,reject)=>{
    const p=spawn(ffmpeg,['-y','-re','-stream_loop','-1','-i','fixture.mp4','-c:v','libx264','-preset','veryslow','cancelled.mp4'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let started=false, killedAt;
    const watchdog=setTimeout(()=>{p.kill(); reject(new Error('Cancellation watchdog'));},15000);
    p.stderr.on('data',chunk=>{ if(!started && chunk.toString().includes('frame=')){started=true;killedAt=Date.now();p.kill();} });
    p.on('error',reject);
    p.on('close',(code,signal)=>{clearTimeout(watchdog);resolve({started,code,signal,latencyMs:Date.now()-killedAt});});
  });
  assert.ok(cancel.started);
  if(fs.existsSync('cancelled.mp4'))fs.unlinkSync('cancelled.mp4');
  assert.equal(fs.existsSync('cancelled.mp4'),false);
  const afterCancel=probe('fixture.mp4');
  const result={node:process.version,platform:process.platform,ffmpeg:run(ffmpeg,['-version']).split('\n')[0],ffprobe:run(ffprobe,['-version']).split('\n')[0],input,output,progress,invalidExit:invalid.status,cancel,reuseDuration:afterCancel.format.duration};
  fs.writeFileSync('native-results.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({duration:output.format.duration,streams:output.streams.map(s=>s.codec_name),cancel,passed:true}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
