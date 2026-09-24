const fs=require('node:fs'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
const ffmpeg=require('ffmpeg-static');const presets=require('./presets.json');
const results=[];
for(const p of presets){
 const output=`preset-native-${p.id}.${p.format}`;const before=performance.now();
 const r=spawnSync(ffmpeg,['-y','-i','fixture.mp4',...p.args,output],{encoding:'utf8',windowsHide:true,timeout:60000});
 assert.equal(r.status,0,r.stderr);
 results.push({id:p.id,file:output,elapsedMs:performance.now()-before,bytes:fs.statSync(output).size});
}
fs.writeFileSync('preset-native-results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
