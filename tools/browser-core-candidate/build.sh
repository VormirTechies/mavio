#!/bin/bash
set -euo pipefail
: "$BUILD_JOBS"
: "$INSTALL_DIR"

mkdir -p "$INSTALL_DIR"
dpkg-query -W > /recipe/build-packages.txt

cd /deps/x264
emconfigure ./configure \
  --prefix="$INSTALL_DIR" --host=x86-gnu \
  --enable-static --disable-cli --disable-asm --disable-thread \
  --extra-cflags="$CFLAGS"
emmake make -j"$BUILD_JOBS" install-lib-static

cd /deps/lame
emconfigure ./configure \
  --prefix="$INSTALL_DIR" --host=i686-linux \
  --disable-shared --disable-frontend --disable-analyzer-hooks \
  --disable-dependency-tracking --disable-gtktest
emmake make -j"$BUILD_JOBS"
emmake make install

cd /deps/zlib
emconfigure ./configure --static --prefix="$INSTALL_DIR"
emmake make -j"$BUILD_JOBS"
emmake make install

cd /src
# Bound upstream make parallelism rather than its unrestricted -j.
sed -i 's/emmake make -j$/emmake make -j"$BUILD_JOBS"/' /recipe/ffmpeg.sh
bash /recipe/ffmpeg.sh \
  --enable-gpl --enable-libx264 --enable-libmp3lame --enable-zlib

embuilder build sdl2
mkdir -p dist/esm
bash /recipe/ffmpeg-wasm.sh \
  -lx264 -lmp3lame -lz \
  -sEXPORT_ES6 \
  -o dist/esm/ffmpeg-core.js
