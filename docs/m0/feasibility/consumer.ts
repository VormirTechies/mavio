import { createMavio, type MavioError } from './contracts';
async function browser(file: Blob) {
 const client=createMavio();
 const base=client.from({kind:'blob',blob:file});
 const result=await base.trim({start:1.25,end:3.75}).compress({preset:'video-balanced-v1'}).export({format:'mp4',output:{kind:'blob'}});
 const blob: Blob=result.output.blob;
 // @ts-expect-error Blob output must not expose a path.
 result.output.path;
 await client.dispose();return blob;
}
async function node() {
 const client=createMavio();
 const result=await client.from({kind:'path',path:'input.mp4'}).convert({format:'mp4',preset:'video-balanced-v1'}).export({output:{kind:'path',path:'output.mp4'}});
 const path:string=result.output.path;
 // @ts-expect-error Time strings are excluded.
 client.from({kind:'bytes',bytes:new Uint8Array()}).trim({start:'1',end:2});
 // @ts-expect-error Unknown presets are excluded.
 client.from({kind:'path',path:'x'}).compress({preset:'unknown'});
 await client.dispose();return path;
}
void browser;void node;
