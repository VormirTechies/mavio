import { createMavioError } from "../../core/errors.js";

export type NativeCodecListKind = "encoders" | "decoders";

export function parseNativeCodecList(
  kind: NativeCodecListKind,
  text: string,
  jobId?: string,
): readonly string[] {
  function invalid(): never {
    throw createMavioError("ENGINE_INIT_FAILED", `FFmpeg returned an invalid ${kind} list.`, {
      stage: "preparing",
      jobId,
      details: {
        reason: "INVALID_CAPABILITY_LIST",
        tool: "ffmpeg",
        list: kind,
      },
    });
  }

  const lines = text.split(/\r?\n/);
  const heading = kind === "encoders" ? "Encoders:" : "Decoders:";
  const first = lines.findIndex((line) => line.trim().length > 0);

  if (first === -1 || lines[first].trim() !== heading) {
    invalid();
  }

  let separator = -1;

  for (let index = first + 1; index < lines.length; index += 1) {
    if (/^-{6}$/.test(lines[index].trim())) {
      separator = index;
      break;
    }
  }

  if (separator === -1) {
    invalid();
  }

  const names = new Set<string>();

  for (const line of lines.slice(separator + 1)) {
    if (line.trim().length === 0) continue;

    // Match the implementation-name column only.
    // A trailing "(codec ...)" describes an alias, not another implementation.
    const match =
      /^[ \t]+[VAS][F.][S.][X.][B.][D.][ \t]+([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:[ \t]+.*)?$/.exec(
        line,
      );

    if (match === null) {
      invalid();
    }

    names.add(match[1]);
  }

  return Object.freeze([...names].sort());
}
