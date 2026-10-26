FROM emscripten/emsdk@sha256:c1e807a6e03ac5bd5b37bae2ace3c46c08579e2ddeb951037a3b8dac7067f2cc
COPY x264 /work/x264
COPY initialization.c /work/initialization.c
WORKDIR /work/x264
RUN CC=gcc ./configure --enable-static --disable-shared --disable-cli \
      --disable-asm --disable-opencl --disable-thread --bit-depth=8 \
      --extra-cflags="-O1 -g -fsanitize=address -fno-omit-frame-pointer" \
      --extra-ldflags="-fsanitize=address" && \
    make -j2 && \
    gcc -O1 -g -fsanitize=address -fno-omit-frame-pointer \
      -I. /work/initialization.c ./libx264.a -lm -o /work/initialization
ENV ASAN_OPTIONS=detect_leaks=1:exitcode=23
ENV LSAN_OPTIONS=exitcode=23
ENTRYPOINT ["/work/initialization"]
