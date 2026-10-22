import assert from "node:assert/strict";
import test from "node:test";
import {
  parseNativeFilterList,
  parseNativeFormatList,
} from "../../dist/engines/shared/feature-lists.js";

test("older format tables expand aliases and return immutable unique names", () => {
  const result = parseNativeFormatList(
    "demuxers",
    [
      "File formats:",
      " --",
      " D  mov,mp4,m4a Example container family",
      " D  matroska,webm Example container family",
      " D  mp4 Duplicate alias",
      "",
    ].join("\r\n"),
  );

  assert.deepEqual(result, ["m4a", "matroska", "mov", "mp4", "webm"]);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => result.push("injected"), TypeError);

  assert.deepEqual(
    parseNativeFormatList("muxers", "File formats:\n --\n  E mp4 Example output\n"),
    ["mp4"],
  );
});

test("newer format tables accept the additional device column", () => {
  assert.deepEqual(
    parseNativeFormatList(
      "demuxers",
      [
        "Formats:",
        " ---",
        " D   mov,mp4 Example file input",
        " D d lavfi Example device input",
      ].join("\n"),
    ),
    ["lavfi", "mov", "mp4"],
  );

  assert.deepEqual(parseNativeFormatList("muxers", "Formats:\n ---\n  E  mp4 Example output\n"), [
    "mp4",
  ]);
});

test("valid empty format tables remain empty", () => {
  assert.deepEqual(parseNativeFormatList("muxers", "File formats:\n --\n"), []);

  assert.deepEqual(parseNativeFormatList("demuxers", "Formats:\n ---\n"), []);
});

test("malformed format tables and opposite directions fail", () => {
  const invalidTables = [
    "",
    "Devices:\n ---\n",
    "Formats:\n D   mp4 Missing separator",
    "File formats:\n --\n D  mp4 Wrong direction",
    "File formats:\n --\n DE mp4 Mixed directions",
    "File formats:\n --\n  E mov,,mp4 Empty alias",
    "File formats:\n --\n  E ../private Invalid name",
    "Formats:\n ---\n  Ex mp4 Unknown device flag",
    "Formats:\n ---\n  E  mp4 Valid\nprivate trailing output",
  ];

  for (const text of invalidTables) {
    assert.throws(
      () => parseNativeFormatList("muxers", text, "format-job"),
      (error) => {
        assert.equal(error.code, "ENGINE_INIT_FAILED");
        assert.equal(error.stage, "preparing");
        assert.equal(error.jobId, "format-job");
        assert.deepEqual(error.details, {
          reason: "INVALID_CAPABILITY_LIST",
          tool: "ffmpeg",
          list: "muxers",
        });
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

test("older filter tables support three flags without a separator", () => {
  const text = [
    "Filters:",
    "  T.. = Example legend",
    "  ..C = Example legend",
    "  | = Example legend",
    " ... trim V->V Example",
    " TSC scale V->V Example",
    " ... atrim A->A Example",
    " ... split V->N Example",
    " ... nullsrc |->V Example",
    " ... nullsink V->| Example",
  ].join("\n");

  assert.deepEqual(parseNativeFilterList(text), [
    "atrim",
    "nullsink",
    "nullsrc",
    "scale",
    "split",
    "trim",
  ]);
});

test("newer filter tables support two flags and immutable unique names", () => {
  const result = parseNativeFilterList(
    [
      "Filters:",
      " ------",
      " TS scale V->V Description mentions trim",
      " .. trim V->V Example",
      " .. trim V->V Duplicate",
      " .. amix N->A Example",
      "",
    ].join("\r\n"),
  );

  assert.deepEqual(result, ["amix", "scale", "trim"]);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => result.push("injected"), TypeError);
});

test("disabled filters and valid empty filter tables return empty inventories", () => {
  for (const text of [
    "No filters available: libavfilter disabled\n",
    "Filters:\n ------\n",
    "Filters:\n  | = Example legend\n",
  ]) {
    const result = parseNativeFilterList(text);
    assert.deepEqual(result, []);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("malformed filter output fails without exposing its contents", () => {
  const invalidTables = [
    "",
    "Filters:",
    "Encoders:\n ------\n",
    "Filters:\n ------\n XX trim V->V Invalid flags",
    "Filters:\n ------\n .. trim Invalid connections",
    "Filters:\n ------\n .. ../private V->V Invalid name",
    "Filters:\n ------\n .. trim V->V Example\nprivate trailing output",
    "No filters available: libavfilter disabled\nprivate trailing output",
  ];

  for (const text of invalidTables) {
    assert.throws(
      () => parseNativeFilterList(text, "filter-job"),
      (error) => {
        assert.equal(error.code, "ENGINE_INIT_FAILED");
        assert.equal(error.stage, "preparing");
        assert.equal(error.jobId, "filter-job");
        assert.deepEqual(error.details, {
          reason: "INVALID_CAPABILITY_LIST",
          tool: "ffmpeg",
          list: "filters",
        });
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});
