import type {
  EngineContext,
  MediaMetadata as MavioMediaMetadata,
  ProcessingPlan,
} from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";
import { buildNativeAudioCommand } from "./audio-command.js";
import { executeNativeAudioFile } from "./audio-execution.js";
import { validateNativeAudioOutput } from "./audio-output.js";
import { validateNativeAudioSource } from "./audio-source.js";
import type { NativeConfiguration } from "./config.js";
import type { NativeInventory } from "./inventory.js";
import type { PreparedNativeTools } from "./prepare.js";
import { probeNativeFileDetails } from "./probe.js";
import type { NativeWorkspace } from "./workspace.js";
import { resolveNativeTrimRange } from "./trim-range.js";
import { buildNativeAudioTrimFilters } from "./audio-trim-filters.js";
import { analyzeNativeAudioTrim } from "./audio-trim-analysis.js";

interface Dependencies {
  probe?: typeof probeNativeFileDetails;
  execute?: typeof executeNativeAudioFile;
  analyzeTrim?: typeof analyzeNativeAudioTrim;
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
 * Produces a validated intermediate audio file.
 * The caller owns workspace cleanup, byte readback, and publication.
 */
export async function prepareNativeAudioFile(
  { configuration, tools, inventory, plan, workspace, context }: Options,
  dependencies: Dependencies = {},
): Promise<{ path: string; metadata: MavioMediaMetadata }> {
  const probe = dependencies.probe ?? probeNativeFileDetails;
  const execute = dependencies.execute ?? executeNativeAudioFile;
  const analyzeTrim = dependencies.analyzeTrim ?? analyzeNativeAudioTrim;

  function checkAbort(): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native audio preparation was cancelled.", {
        stage: "running",
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

  if (
    plan.terminal.type !== "export" ||
    (plan.terminal.preset !== "audio-balanced-v1" && plan.terminal.preset !== "audio-pcm-v1")
  ) {
    throw createMavioError(
      "UNSUPPORTED_CAPABILITY",
      "This route requires an audio export preset.",
      {
        stage: "preparing",
        jobId: context.jobId,
        details: { reason: "UNSUPPORTED_NATIVE_ENCODING" },
      },
    );
  }

  const preset = plan.terminal.preset;
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

  // Reject unsupported operations and conflicting declarations before encoding.
  buildNativeAudioCommand(commandOptions);

  let streamIndex: number | undefined;

  for (const transformation of plan.transformations) {
    if (transformation.type === "extractAudio") {
      streamIndex = transformation.options.streamIndex;
    }
  }

  const selected = validateNativeAudioSource(source, preset, streamIndex);
  const expected = {
    preset,
    sampleRate: selected.sampleRate,
    channels: selected.channels,
    channelLayout: selected.channelLayout,
  };

  const trimRange = resolveNativeTrimRange(plan.transformations, source.metadata.durationSeconds);

  if (trimRange !== undefined) {
    const filters = buildNativeAudioTrimFilters(
      trimRange,
      source.formatStartTimeSeconds,
      inventory,
    );

    checkAbort();

    const selection = await analyzeTrim({
      configuration,
      tools,
      inventory,
      inputPath,
      streamIndex: selected.audioStreamIndex,
      channels: selected.channels,
      filters,
      context,
    });

    checkAbort();

    // Validate dependency results before allowing encoding.
    if (!Number.isSafeInteger(selection.audioSamples) || selection.audioSamples < 0) {
      throw createMavioError(
        "EXECUTION_FAILED",
        "Audio trim analysis returned an invalid sample count.",
        {
          stage: "preparing",
          operation: "trim",
          jobId: context.jobId,
          details: { reason: "INVALID_TRIM_SELECTION" },
        },
      );
    }

    if (selection.audioSamples === 0) {
      throw createMavioError(
        "INVALID_OPTIONS",
        "The requested trim contains no selected audio samples.",
        {
          stage: "preparing",
          operation: "trim",
          jobId: context.jobId,
          details: { reason: "RANGE_TOO_SHORT", streamKind: "audio" },
        },
      );
    }
  }

  await execute(configuration, tools, commandOptions, context);
  checkAbort();

  const encoded = await probe(configuration, tools, outputPath, context);
  checkAbort();

  validateNativeAudioOutput(encoded, expected, context.jobId);

  return { path: outputPath, metadata: encoded.metadata };
}
