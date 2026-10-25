FROM emscripten/emsdk@sha256:c1e807a6e03ac5bd5b37bae2ace3c46c08579e2ddeb951037a3b8dac7067f2cc AS build
ARG BUILD_JOBS=2
ENV INSTALL_DIR=/opt/mavio
ENV FFMPEG_ST=1
ENV CFLAGS="-I/opt/mavio/include -O3 -msimd128"
ENV CXXFLAGS="-I/opt/mavio/include -O3 -msimd128"
ENV LDFLAGS="-L/opt/mavio/lib -O3 -msimd128"
ENV PKG_CONFIG_PATH=/opt/mavio/lib/pkgconfig
ENV EM_PKG_CONFIG_PATH=/opt/mavio/lib/pkgconfig:/emsdk/upstream/emscripten/system/lib/pkgconfig

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config autoconf automake libtool cmake

COPY x264 /deps/x264
COPY x264-initialization-param-cleanup.patch /recipe/x264-initialization-param-cleanup.patch
RUN git -C /deps/x264 apply --check /recipe/x264-initialization-param-cleanup.patch && \
    git -C /deps/x264 apply /recipe/x264-initialization-param-cleanup.patch
COPY lame /deps/lame
COPY zlib /deps/zlib
COPY zlib-CVE-2026-85091.patch /recipe/zlib-CVE-2026-85091.patch
COPY zlib-security-patch.json /recipe/zlib-security-patch.json
RUN git -C /deps/zlib apply --check /recipe/zlib-CVE-2026-85091.patch && \
    git -C /deps/zlib apply /recipe/zlib-CVE-2026-85091.patch
COPY ffmpeg /src
COPY bindings-current/src/bind /src/src/bind
COPY bindings-current/src/fftools /src/src/fftools
COPY bindings-current/build/ffmpeg.sh /recipe/ffmpeg.sh
COPY bindings-current/build/ffmpeg-wasm.sh /recipe/ffmpeg-wasm.sh
COPY build.sh /recipe/build.sh
COPY sources.json /recipe/sources.json
RUN bash /recipe/build.sh

COPY export-stack-runtime.sh /recipe/export-stack-runtime.sh
COPY stack-runtime-exports.json /recipe/stack-runtime-exports.json
RUN bash /recipe/export-stack-runtime.sh

FROM scratch AS export
COPY --from=build /src/dist /dist
COPY --from=build /recipe/sources.json /sources.json
COPY --from=build /recipe/build-packages.txt /build-packages.txt
COPY --from=build /recipe/stack-runtime-exports.json /stack-runtime-exports.json
COPY --from=build /recipe/zlib-CVE-2026-85091.patch /zlib-CVE-2026-85091.patch
COPY --from=build /recipe/zlib-security-patch.json /zlib-security-patch.json
COPY --from=build /deps/zlib/gzwrite.c /review/zlib/gzwrite.c
COPY --from=build /src/config.h /review/ffmpeg/config.h
COPY --from=build /src/ffbuild/config.mak /review/ffmpeg/config.mak
COPY --from=build /recipe/x264-initialization-param-cleanup.patch /x264-initialization-param-cleanup.patch
COPY --from=build /deps/x264/encoder/encoder.c /review/x264/encoder/encoder.c
