import {createMavio} from "./contracts";
createMavio({engine:"auto",native:{ffmpegPath:"D:/Tools/ffmpeg.exe",ffprobePath:"D:/Tools/ffprobe.exe"},initTimeoutMs:30000});
createMavio({browser:{assets:{coreURL:"/engine/core.js",wasmURL:"/engine/core.wasm"}}});
// @ts-expect-error WASM URL required.
createMavio({browser:{assets:{coreURL:"/engine/core.js"}}});
// @ts-expect-error Numeric deadline required.
createMavio({initTimeoutMs:"30000"});
