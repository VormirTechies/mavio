import assert from "node:assert/strict";
import test from "node:test";
import { validatePlanCapabilities, validateSource } from "../../dist/core/preflight.js";

const video = {
  durationSeconds: 10,
  streams: [
    { index: 0, kind: "video", width: 640, height: 360 },
    { index: 3, kind: "audio" },
  ],
};

const audioOnly = {
  durationSeconds: 10,
  streams: [{ index: 3, kind: "audio" }],
};

function plan(
  transformations = [],
  terminal = {
    type: "export",
    format: "mp4",
    preset: "video-balanced-v1",
  },
) {
  return {
    input: { kind: "bytes", bytes: new Uint8Array([1]) },
    transformations,
    terminal,
    output: { kind: "bytes" },
  };
}

function audioPlan(transformations = []) {
  return plan(transformations, {
    type: "export",
    format: "wav",
    preset: "audio-pcm-v1",
  });
}

function thumbnail(at, transformations = []) {
  return plan(transformations, {
    type: "thumbnail",
    at,
    format: "jpeg",
    preset: "jpeg-balanced-v1",
  });
}

function capabilities() {
  return {
    engineId: "mock",
    engineVersion: "test",
    runtime: "node",
    operations: ["metadata", "trim", "resize", "convert", "compress", "extractAudio", "thumbnail"],
    inputKinds: ["bytes"],
    outputKinds: ["bytes"],
    readableContainers: [],
    decoders: [],
    encodings: [
      {
        container: "mp4",
        preset: "video-balanced-v1",
      },
    ],
    limits: {},
  };
}

function rejects(callback, code, reason) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.stage, "preparing");
    assert.equal(error.details.reason, reason);
    return true;
  });
}

test("advertised input, output, operations, and encoding pass coarse preflight", () => {
  assert.doesNotThrow(() =>
    validatePlanCapabilities(
      plan([{ type: "trim", options: { start: 0, end: 2 } }]),
      capabilities(),
    ),
  );
});

test("missing capabilities reject before execution", () => {
  for (const field of ["inputKinds", "outputKinds"]) {
    rejects(
      () =>
        validatePlanCapabilities(plan(), {
          ...capabilities(),
          [field]: [],
        }),
      "UNSUPPORTED_CAPABILITY",
      "UNSUPPORTED_IO_KIND",
    );
  }

  rejects(
    () =>
      validatePlanCapabilities(plan(), {
        ...capabilities(),
        operations: [],
      }),
    "UNSUPPORTED_CAPABILITY",
    "MISSING_OPERATION",
  );

  rejects(
    () =>
      validatePlanCapabilities(plan(), {
        ...capabilities(),
        encodings: [],
      }),
    "UNSUPPORTED_CAPABILITY",
    "MISSING_ENCODING",
  );
});

test("successive trims use the preceding logical duration", () => {
  const first = { type: "trim", options: { start: 2, end: 6 } };

  assert.doesNotThrow(() =>
    validateSource(plan([first, { type: "trim", options: { start: 1, end: 4 } }]), video),
  );

  rejects(
    () => validateSource(plan([first, { type: "trim", options: { start: 1, end: 5 } }]), video),
    "INVALID_OPTIONS",
    "OUT_OF_RANGE",
  );
});

test("duration is required only when a time-based operation needs it", () => {
  for (const durationSeconds of [undefined, NaN, Infinity, -1]) {
    const source = { ...video, durationSeconds };

    assert.doesNotThrow(() => validateSource(plan(), source));

    rejects(
      () => validateSource(plan([{ type: "trim", options: { start: 0, end: 1 } }]), source),
      "INVALID_MEDIA",
      "UNKNOWN_DURATION",
    );

    rejects(() => validateSource(thumbnail(0), source), "INVALID_MEDIA", "UNKNOWN_DURATION");
  }
});

test("thumbnail timestamps use the trimmed timeline and exclude its endpoint", () => {
  const transformations = [{ type: "trim", options: { start: 4, end: 6 } }];

  assert.doesNotThrow(() => validateSource(thumbnail(1.5, transformations), video));

  rejects(
    () => validateSource(thumbnail(2, transformations), video),
    "INVALID_OPTIONS",
    "OUT_OF_RANGE",
  );
});

test("video export permits missing audio but requires video", () => {
  assert.doesNotThrow(() =>
    validateSource(plan(), {
      ...video,
      streams: [video.streams[0]],
    }),
  );

  rejects(() => validateSource(plan(), audioOnly), "INVALID_MEDIA", "MISSING_VIDEO");
});

test("audio selection uses absolute source indices and rejects missing audio", () => {
  assert.doesNotThrow(() =>
    validateSource(audioPlan([{ type: "extractAudio", options: { streamIndex: 3 } }]), video),
  );

  for (const streamIndex of [0, 1, 99]) {
    rejects(
      () => validateSource(audioPlan([{ type: "extractAudio", options: { streamIndex } }]), video),
      "INVALID_OPTIONS",
      "INVALID_STREAM_INDEX",
    );
  }

  rejects(
    () =>
      validateSource(audioPlan(), {
        ...video,
        streams: [video.streams[0]],
      }),
    "INVALID_MEDIA",
    "MISSING_AUDIO",
  );
});

test("resize still requires source video when followed by audio extraction", () => {
  rejects(
    () =>
      validateSource(
        audioPlan([
          { type: "resize", options: { width: 320, height: 180 } },
          { type: "extractAudio", options: {} },
        ]),
        audioOnly,
      ),
    "INVALID_MEDIA",
    "MISSING_VIDEO",
  );
});

test("source preflight does not mutate metadata or transformations", () => {
  const source = structuredClone(video);
  const processingPlan = plan([{ type: "trim", options: { start: 1, end: 3 } }]);
  const originalSource = structuredClone(source);
  const originalPlan = structuredClone(processingPlan);

  validateSource(processingPlan, source);

  assert.deepEqual(source, originalSource);
  assert.deepEqual(processingPlan, originalPlan);
});
