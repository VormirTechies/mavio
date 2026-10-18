import type {
  EngineContext,
  MediaMetadata as MavioMediaMetadata,
  ProcessingPlan,
} from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import type { NativeConfiguration } from "./config.js";
import type { NativeInventory } from "./inventory.js";
import { buildNativeMp4Command } from "./mp4-command.js";
import { executeNativeMp4File } from "./mp4-execution.js";
import { validateNativeMp4Output, type NativeMp4OutputExpectation } from "./mp4-output.js";
import { selectNativeMp4Streams } from "./mp4-streams.js";
import type { PreparedNativeTools } from "./prepare.js";
import { probeNativeFileDetails } from "./probe.js";
import type { NativeWorkspace } from "./workspace.js";
import { analyzeNativeTrimSelection } from "./trim-analysis.js";
import { buildNativeTrimFilters } from "./trim-filters.js";
import { resolveNativeTrimRange } from "./trim-range.js";
import { validateNativeTrimSelection } from "./trim-selection.js";
import { buildNativeResizeFilters } from "./resize-filters.js";
import { validateNativeResizeSource } from "./resize-source.js";

interface Dependencies {
  probe?: typeof probeNativeFileDetails;
  execute?: typeof executeNativeMp4File;
  analyzeTrim?: typeof analyzeNativeTrimSelection;
}

interface Options {
  configuration: NativeConfiguration;
  tools: PreparedNativeTools;
  inventory: NativeInventory;
  plan: ProcessingPlan;
  workspace: NativeWorkspace;
  context: Pick<EngineContext, "jobId" | "signal">;
}

/**
 * Encodes and validates a staging file.
 * The caller owns workspace cleanup and publication.
 */
export async function prepareNativeMp4File(
  { configuration, tools, inventory, plan, workspace, context }: Options,
  dependencies: Dependencies = {},
): Promise<{ path: string; metadata: MavioMediaMetadata }> {
  const probe = dependencies.probe ?? probeNativeFileDetails;
  const execute = dependencies.execute ?? executeNativeMp4File;
  const analyzeTrim = dependencies.analyzeTrim ?? analyzeNativeTrimSelection;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native file preparation was cancelled.", {
        stage: "running",
        jobId: context.jobId,
        cause: context.signal.reason,
      });
    }
  }

  checkAbort();

  if (
    (plan.output.kind !== "bytes" && plan.output.kind !== "path") ||
    (plan.input.kind !== "path" && plan.input.kind !== "bytes")
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "This route requires path or byte input and path or byte output.",
      {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "UNSUPPORTED_NATIVE_IO" },
      },
    );
  }

  const inputPath =
    plan.input.kind === "path"
      ? plan.input.path
      : await workspace.writeInput(plan.input.bytes, context);

  checkAbort();

  const source = await probe(configuration, tools, inputPath, context);
  checkAbort();

  const outputPath = workspace.getOutputPath();
  const commandOptions = {
    plan,
    source,
    inventory,
    inputPath,
    outputPath,
  };

  // Validate the complete supported route before starting the encoder.
  buildNativeMp4Command(commandOptions);

  const selected = selectNativeMp4Streams(source.metadata);
  const video = source.metadata.streams.find(
    (stream) => stream.index === selected.videoStreamIndex,
  )!;

  // Rotated output needs a separate, verified dimension/orientation policy.
  if (video.rotationDegrees !== undefined && video.rotationDegrees !== 0) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "Rotation normalization is not supported by this initial export route.",
      {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "NATIVE_ORIENTATION_PENDING" },
      },
    );
  }

  const resizeFilters = plan.transformations.some((item) => item.type === "resize")
    ? buildNativeResizeFilters(validateNativeResizeSource(source), plan.transformations, inventory)
    : undefined;

  const expected: NativeMp4OutputExpectation = {
    width: resizeFilters?.dimensions.width ?? video.width!,
    height: resizeFilters?.dimensions.height ?? video.height!,
    requireNormalizedGeometry: resizeFilters !== undefined,
    ...(selected.audioStreamIndex === undefined
      ? {}
      : {
          audio: {
            sampleRate: source.metadata.streams.find(
              (stream) => stream.index === selected.audioStreamIndex,
            )!.sampleRate!,
            channels: source.metadata.streams.find(
              (stream) => stream.index === selected.audioStreamIndex,
            )!.channels!,
            channelLayout: source.streams.find(
              (stream) => stream.index === selected.audioStreamIndex,
            )!.channelLayout!,
          },
        }),

    preset:
      plan.terminal.type === "export" && plan.terminal.preset === "video-small-v1"
        ? "video-small-v1"
        : "video-balanced-v1",
  };

  const trimRange = resolveNativeTrimRange(plan.transformations, source.metadata.durationSeconds);

  if (trimRange !== undefined) {
    const hasAudio = selected.audioStreamIndex !== undefined;

    const filters = buildNativeTrimFilters(
      trimRange,
      source.formatStartTimeSeconds,
      hasAudio,
      inventory,
    );

    checkAbort();

    const selection = await analyzeTrim({
      configuration,
      tools,
      inventory,
      inputPath,
      videoStreamIndex: selected.videoStreamIndex,
      ...(selected.audioStreamIndex === undefined
        ? {}
        : {
            audio: {
              streamIndex: selected.audioStreamIndex,
              channels: expected.audio!.channels,
            },
          }),
      filters,
      context,
    });

    checkAbort();

    // Validate the dependency result before permitting encoding.
    validateNativeTrimSelection(selection, hasAudio, context.jobId);
  }

  await execute(configuration, tools, commandOptions, context);
  checkAbort();

  const encoded = await probe(configuration, tools, outputPath, context);
  checkAbort();

  validateNativeMp4Output(encoded, expected, context.jobId);

  return { path: outputPath, metadata: encoded.metadata };
}
