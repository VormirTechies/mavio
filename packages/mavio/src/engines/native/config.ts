import { posix, win32 } from "node:path";
import { cwd, env, platform } from "node:process";
import type { NativeEngineOptions } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

interface NativeEnvironment {
  cwd: string;
  path: string;
  platform: "win32" | "posix";
}

export interface NativeConfiguration {
  readonly cwd: string;
  readonly platform: "win32" | "posix";
  readonly searchDirectories: readonly string[];
  readonly ffmpegCandidates: readonly string[];
  readonly ffprobeCandidates: readonly string[];
}

export function captureNativeConfiguration(
  options: NativeEngineOptions = {},
  environment: NativeEnvironment = {
    cwd: cwd(),
    path: env.PATH ?? "",
    platform: platform === "win32" ? "win32" : "posix",
  },
): NativeConfiguration {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw createMavioError("INVALID_OPTIONS", "Native engine options must be an object.");
  }

  const windows = environment.platform === "win32";
  const paths = windows ? win32 : posix;

  function absolute(value: string): boolean {
    if (!paths.isAbsolute(value)) return false;

    // Windows root-relative paths still depend on the current drive.
    return !windows || paths.parse(value).root.length > 1;
  }

  function override(value: unknown, tool: "ffmpeg" | "ffprobe"): string | undefined {
    if (value === undefined) return undefined;

    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      !absolute(value) ||
      (windows && [".cmd", ".bat"].includes(paths.extname(value).toLowerCase()))
    ) {
      throw createMavioError(
        "INVALID_OPTIONS",
        `${tool}Path must be an absolute binary path, without shell wrappers.`,
        { details: { reason: "INVALID_BINARY_PATH", tool } },
      );
    }

    return value;
  }

  const ffmpegPath = override(options.ffmpegPath, "ffmpeg");
  const ffprobePath = override(options.ffprobePath, "ffprobe");

  const searchDirectories = Object.freeze(
    environment.path
      .split(windows ? ";" : ":")
      .filter(
        (directory) => directory.length > 0 && !directory.includes("\0") && absolute(directory),
      ),
  );

  function candidates(tool: "ffmpeg" | "ffprobe", explicit: string | undefined): readonly string[] {
    if (explicit !== undefined) {
      // A bad explicit installation must never fall back to PATH.
      return Object.freeze([explicit]);
    }

    const executable = windows ? `${tool}.exe` : tool;

    return Object.freeze(searchDirectories.map((directory) => paths.join(directory, executable)));
  }

  return Object.freeze({
    cwd: environment.cwd,
    platform: environment.platform,
    searchDirectories,
    ffmpegCandidates: candidates("ffmpeg", ffmpegPath),
    ffprobeCandidates: candidates("ffprobe", ffprobePath),
  });
}
