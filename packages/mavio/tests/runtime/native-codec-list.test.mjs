import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeCodecList } from "../../dist/engines/native/codec-list.js";

function table(heading, rows = [], newline = "\n") {
  return [heading, " ------", ...rows, ""].join(newline);
}

test("codec lists retain encoder and decoder implementation names", () => {
  assert.deepEqual(
    parseNativeCodecList(
      "encoders",
      table("Encoders:", [
        " V..... libx264 Example video encoder",
        " A..... aac Example audio encoder",
        " S..... srt Example subtitle encoder",
      ]),
    ),
    ["aac", "libx264", "srt"],
  );

  assert.deepEqual(
    parseNativeCodecList(
      "decoders",
      table("Decoders:", [
        " V..... h264 Example video decoder",
        " A..... aac Example audio decoder",
      ]),
    ),
    ["aac", "h264"],
  );
});

test("codec lists accept capability flags and Windows line endings", () => {
  const text = table(
    "Decoders:",
    [
      " VFSXBD flagged_decoder Example",
      " A....D audio_decoder Example",
      " S..... subtitle_decoder Example",
    ],
    "\r\n",
  );

  assert.deepEqual(parseNativeCodecList("decoders", text), [
    "audio_decoder",
    "flagged_decoder",
    "subtitle_decoder",
  ]);
});

test("codec descriptions and aliases do not become implementation names", () => {
  const text = table("Decoders:", [
    " V..... libdav1d Example decoder (codec av1)",
    " A..... example_audio Description mentions aac and libmp3lame",
  ]);

  assert.deepEqual(parseNativeCodecList("decoders", text), ["example_audio", "libdav1d"]);
});

test("a correctly headed empty codec table is valid", () => {
  assert.deepEqual(parseNativeCodecList("encoders", table("Encoders:")), []);
});

test("malformed codec tables fail with bounded diagnostics", () => {
  const invalidTables = [
    "",
    table("Decoders:", [" V..... h264 Example"]),
    "Encoders:\n V..... libx264 Example\n",
    table("Encoders:", [" V.... libx264 Invalid flags"]),
    table("Encoders:", [" VQ.... libx264 Unknown flag"]),
    table("Encoders:", [" V....."]),
    table("Encoders:", [" V..... ../private/name Invalid name"]),
    table("Encoders:", [
      " V..... libx264 Example",
      "unexpected trailing output containing private data",
    ]),
  ];

  for (const text of invalidTables) {
    assert.throws(
      () => parseNativeCodecList("encoders", text, "inventory-job"),
      (error) => {
        assert.equal(error.code, "ENGINE_INIT_FAILED");
        assert.equal(error.stage, "preparing");
        assert.equal(error.jobId, "inventory-job");
        assert.deepEqual(error.details, {
          reason: "INVALID_CAPABILITY_LIST",
          tool: "ffmpeg",
          list: "encoders",
        });
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

test("codec inventory is sorted, deduplicated, and immutable", () => {
  const result = parseNativeCodecList(
    "encoders",
    table("Encoders:", [
      " V..... z_encoder Example",
      " A..... a_encoder Example",
      " V..... z_encoder Duplicate",
    ]),
  );

  assert.deepEqual(result, ["a_encoder", "z_encoder"]);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => result.push("injected"), TypeError);
});
