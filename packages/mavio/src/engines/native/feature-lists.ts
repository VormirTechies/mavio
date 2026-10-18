import { createMavioError } from "../../core/errors.js";

type FormatListKind = "muxers" | "demuxers";
type ListKind = FormatListKind | "filters";

function invalidList(kind: ListKind, jobId?: string): never {
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

function freezeNames(names: Set<string>): readonly string[] {
  return Object.freeze([...names].sort());
}

export function parseNativeFormatList(
  kind: FormatListKind,
  text: string,
  jobId?: string,
): readonly string[] {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().length > 0);

  if (first === -1 || !["File formats:", "Formats:"].includes(lines[first].trim())) {
    invalidList(kind, jobId);
  }

  let separator = -1;

  for (let index = first + 1; index < lines.length; index += 1) {
    if (/^-{2,3}$/.test(lines[index].trim())) {
      separator = index;
      break;
    }
  }

  if (separator === -1) {
    invalidList(kind, jobId);
  }

  // Newer tables add a third flag identifying devices.
  const hasDeviceColumn = lines[separator].trim().length === 3;
  const rowPattern = hasDeviceColumn
    ? /^ ([D ])([E ])[d ] +(\S+)(?:[ \t]+.*)?$/
    : /^ ([D ])([E ]) +(\S+)(?:[ \t]+.*)?$/;

  const names = new Set<string>();

  for (const line of lines.slice(separator + 1)) {
    if (line.trim().length === 0) continue;

    const match = rowPattern.exec(line);

    if (match === null) {
      invalidList(kind, jobId);
    }

    const isExpectedDirection =
      kind === "muxers"
        ? match[1] === " " && match[2] === "E"
        : match[1] === "D" && match[2] === " ";

    if (!isExpectedDirection) {
      invalidList(kind, jobId);
    }

    const aliases = match[3].split(",");

    if (aliases.some((name) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name))) {
      invalidList(kind, jobId);
    }

    for (const alias of aliases) {
      names.add(alias);
    }
  }

  // Raw inventory only: older tables do not identify device entries.
  // Public support must be restricted separately to implemented routes.
  return freezeNames(names);
}

export function parseNativeFilterList(text: string, jobId?: string): readonly string[] {
  if (text.trim() === "No filters available: libavfilter disabled") {
    return Object.freeze([]);
  }

  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().length > 0);

  if (first === -1 || lines[first].trim() !== "Filters:") {
    invalidList("filters", jobId);
  }

  const names = new Set<string>();
  let bodyStarted = false;
  let sawLegend = false;

  for (const line of lines.slice(first + 1)) {
    if (line.trim().length === 0) continue;

    if (!bodyStarted) {
      if (/^[ \t]+(?:[T.][S.][C.]?|[AVN|])[ \t]+=[ \t]+\S.*$/.test(line)) {
        sawLegend = true;
        continue;
      }

      if (/^-{6}$/.test(line.trim())) {
        bodyStarted = true;
        continue;
      }
    }

    // Older builds include a command-support flag; newer ones omit it.
    const match =
      /^[ \t]+[T.][S.][C.]?[ \t]+([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]+[AVN|]+->[AVN|]+(?:[ \t]+.*)?$/.exec(
        line,
      );

    if (match === null) {
      invalidList("filters", jobId);
    }

    bodyStarted = true;
    names.add(match[1]);
  }

  if (!bodyStarted && !sawLegend) {
    invalidList("filters", jobId);
  }

  return freezeNames(names);
}
