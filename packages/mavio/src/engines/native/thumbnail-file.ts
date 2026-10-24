import { NATIVE_INPUT_ARGUMENTS } from "./input-policy.js";
import type {
  EngineContext,
  MediaMetadata as MavioMediaMetadata,
  ProcessingPlan,
} from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";
import type { NativeInventory } from "./inventory.js";
import type { PreparedNativeTools } from "./prepare.js";
import type { NativeWorkspace } from "./workspace.js";
import { probeNativeFileDetails } from "./probe.js";
import { NativeProcessError, runNativeProcess } from "./process.js";
import { parseNativeTrimCount } from "./trim-counts.js";
import { buildNativeThumbnailCommand } from "./thumbnail-command.js";
import { buildNativeThumbnailFilters } from "./thumbnail-filters.js";
import { resolveNativeThumbnailTime } from "./thumbnail-time.js";
import { validateNativeThumbnailSource } from "./thumbnail-source.js";
import { executeNativeThumbnailFile } from "./thumbnail-execution.js";
import { validateNativeThumbnailOutput } from "./thumbnail-output.js";
import { buildNativeThumbnailResize } from "./thumbnail-resize.js";

interface Options {
  configuration: NativeConfiguration;
  tools: PreparedNativeTools;
  inventory: NativeInventory;
  plan: ProcessingPlan;
  workspace: NativeWorkspace;
  context: Pick<EngineContext, "jobId" | "signal">;
}

interface Dependencies {
  probe?: typeof probeNativeFileDetails;
  execute?: typeof executeNativeThumbnailFile;
  run?: typeof runNativeProcess;
}

/** The caller owns cleanup, byte readback, and publication. */
export async function prepareNativeThumbnailFile(
  { configuration, tools, inventory, plan, workspace, context }: Options,
  dependencies: Dependencies = {},
): Promise<{ path: string; metadata: MavioMediaMetadata }> {
  const probe = dependencies.probe ?? probeNativeFileDetails;
  const execute = dependencies.execute ?? executeNativeThumbnailFile;
  const run = dependencies.run ?? runNativeProcess;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Thumbnail preparation was cancelled.", {
        stage: "preparing",
        operation: "thumbnail",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();

  if (
    (plan.input.kind !== "path" && plan.input.kind !== "bytes") ||
    (plan.output.kind !== "path" && plan.output.kind !== "bytes")
  ) {
    throw createMavioError("UNSUPPORTED_CAPABILITY", "Unsupported native thumbnail input/output.", {
      stage: "preparing",
      operation: "thumbnail",
      jobId: context.jobId,
      details: { reason: "UNSUPPORTED_NATIVE_IO" },
    });
  }

  const terminal = plan.terminal;

  if (
    terminal.type !== "thumbnail" ||
    (terminal.preset !== "jpeg-balanced-v1" && terminal.preset !== "png-lossless-v1")
  ) {
    throw createMavioError("UNSUPPORTED_CAPABILITY", "A thumbnail preset is required.", {
      stage: "preparing",
      operation: "thumbnail",
      jobId: context.jobId,
      details: { reason: "UNSUPPORTED_NATIVE_ENCODING" },
    });
  }

  for (const feature of ["framemd5", "rawvideo"]) {
    const available =
      feature === "framemd5"
        ? inventory.muxers.includes(feature)
        : inventory.encoders.includes(feature);

    if (!available) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "Thumbnail selection analysis is unavailable.",
        {
          stage: "preparing",
          operation: "thumbnail",
          jobId: context.jobId,
          details: { reason: "MISSING_THUMBNAIL_ANALYSIS_FEATURE", feature },
        },
      );
    }
  }

  const inputPath =
    plan.input.kind === "path"
      ? plan.input.path
      : await workspace.writeInput(plan.input.bytes, context);

  checkAbort();

  const source = await probe(configuration, tools, inputPath, context);
  checkAbort();

  const outputPath = workspace.getOutputPath();
  const commandOptions = { plan, source, inventory, inputPath, outputPath };

  // Validate the entire command before running selection analysis.
  buildNativeThumbnailCommand(commandOptions);

  const selected = validateNativeThumbnailSource(source);

  const resize = buildNativeThumbnailResize(
    selected,
    plan.transformations,
    terminal.preset,
    inventory,
  );

  const time = resolveNativeThumbnailTime(
    plan.transformations,
    source.metadata.durationSeconds,
    terminal.at,
  );
  const filters = buildNativeThumbnailFilters(time, source.formatStartTimeSeconds, inventory);

  let analysis;

  try {
    analysis = await run({
      executable: tools.ffmpeg.path,
      cwd: configuration.cwd,
      signal: context.signal,
      maxOutputBytes: 1_048_576,
      args: [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-xerror",
        ...filters.inputArgs,
        "-noautorotate",
        ...NATIVE_INPUT_ARGUMENTS,
        "-i",
        inputPath,
        "-map",
        `0:${selected.videoStreamIndex}`,
        "-an",
        "-sn",
        "-dn",
        "-vf",
        filters.video,
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "+yuv420p",
        "-fps_mode:v",
        "passthrough",
        "-frames:v",
        "1",
        "-f",
        "framemd5",
        "pipe:1",
      ],
    });
  } catch (cause) {
    checkAbort();
    const reason = cause instanceof NativeProcessError ? cause.reason : "PROCESS_FAILED";

    throw createMavioError(
      reason === "CANCELLED"
        ? "CANCELLED"
        : reason === "OUTPUT_LIMIT"
          ? "RESOURCE_LIMIT"
          : "EXECUTION_FAILED",
      "Thumbnail frame analysis failed.",
      {
        stage: "preparing",
        operation: "thumbnail",
        jobId: context.jobId,
        details: { reason, tool: "ffmpeg" },
        cause,
      },
    );
  }

  checkAbort();

  if (analysis.stderr.trim() !== "") {
    throw createMavioError("EXECUTION_FAILED", "Thumbnail analysis reported an error.", {
      stage: "preparing",
      operation: "thumbnail",
      jobId: context.jobId,
      details: { reason: "THUMBNAIL_ANALYSIS_DIAGNOSTIC" },
    });
  }

  const frames = parseNativeTrimCount(analysis.stdout, { kind: "video" }, context.jobId);

  if (frames === 0) {
    throw createMavioError("INVALID_OPTIONS", "No video frame exists in the requested interval.", {
      stage: "preparing",
      operation: "thumbnail",
      jobId: context.jobId,
      details: { reason: "RANGE_TOO_SHORT", streamKind: "video" },
    });
  }

  if (frames !== 1) {
    throw createMavioError(
      "EXECUTION_FAILED",
      "Thumbnail analysis returned an invalid frame count.",
      {
        stage: "preparing",
        operation: "thumbnail",
        jobId: context.jobId,
        details: { reason: "INVALID_THUMBNAIL_SELECTION" },
      },
    );
  }

  checkAbort();
  await execute(configuration, tools, commandOptions, context);
  checkAbort();

  const encoded = await probe(configuration, tools, outputPath, context);
  checkAbort();

  validateNativeThumbnailOutput(
    encoded,
    {
      preset: terminal.preset,
      width: resize.dimensions.width,
      height: resize.dimensions.height,
    },
    context.jobId,
  );

  return { path: outputPath, metadata: encoded.metadata };
}
