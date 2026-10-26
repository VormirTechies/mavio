#!/bin/bash
set -euo pipefail
cd /src

node <<'MAVIO_EXPORTS'
const assert = require("assert").strict;
const fs = require("fs");
const file = "src/bind/ffmpeg/export-runtime.js";
let source = fs.readFileSync(file, "utf8");
const marker = '  "stringToUTF8",';
assert.equal(source.split(marker).length, 2);
assert.ok(!source.includes('"stackSave"'));
assert.ok(!source.includes('"stackRestore"'));
source = source.replace(
  marker,
  marker + '\n  "stackSave",\n  "stackRestore",'
);
fs.writeFileSync(file, source);
MAVIO_EXPORTS

bash /recipe/ffmpeg-wasm.sh \
  -lx264 -lmp3lame -lz \
  -sEXPORT_ES6 \
  -o dist/esm/ffmpeg-core.js
