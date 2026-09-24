const fs=require('node:fs'),assert=require('node:assert/strict');
const number=v=>v===undefined||v===null||v===''||!Number.isFinite(Number(v))?undefined:Number(v);
function normalize(p){return {durationSeconds:number(p.format?.duration),sizeBytes:number(p.format?.size),container:p.format?.format_name,bitrateBitsPerSecond:number(p.format?.bit_rate),streams:(p.streams||[]).map(s=>({index:s.index,kind:['video','audio','subtitle'].includes(s.codec_type)?s.codec_type:'other',codec:s.codec_name,width:number(s.width),height:number(s.height),sampleRate:number(s.sample_rate),channels:number(s.channels)}))};}
const native=JSON.parse(fs.readFileSync('native-results.json')),browser=JSON.parse(fs.readFileSync('browser-results.json'));
const results={input:normalize(native.input),output:normalize(native.output)};
assert.deepEqual(results.input,normalize(browser.input));
assert.deepEqual(results.output.streams,normalize(browser.output).streams);
assert.equal(results.output.durationSeconds,normalize(browser.output).durationSeconds);
assert.equal(normalize({format:{duration:'N/A'},streams:[]}).durationSeconds,undefined);
assert.equal(normalize({streams:[]}).sizeBytes,undefined);
fs.writeFileSync('normalized-results.json',JSON.stringify(results,null,2));console.log('Normalized source metadata matches; output duration and streams match; unknown values remain absent.');
