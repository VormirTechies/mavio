import type {
  EngineAdapter,
  EngineCapabilities,
  EngineContext,
  MediaMetadata as MavioMediaMetadata,
  MavioError,
  NativeEngineOptions,
  ProcessingPlan,
  ExecutionEngineContext,
} from "../../contracts.js";
import { createMavioError, getErrorCode, preserveFailure } from "../../core/errors.js";
import { captureNativeConfiguration } from "./config.js";
import { discoverNativeInventory } from "./inventory.js";
import { prepareNativeTools, type PreparedNativeTools } from "./prepare.js";
import { probeNativeFile, probeNativeFileDetails } from "./probe.js";
import { createNativeWorkspace, type NativeWorkspace } from "./workspace.js";
import { join } from "node:path";
import { captureExecutionResult } from "../../core/adapter-response.js";
import { buildNativeMp4Command } from "./mp4-command.js";
import { prepareNativeMp4Bytes } from "./mp4-bytes.js";
import type { NativeInventory } from "./inventory.js";
import type { NativeProbeDetails } from "./probe-details.js";
import { prepareNativeMp4File } from "./mp4-file.js";
import { createNativePathWorkspace } from "./path-workspace.js";
import { publishNativeFile } from "./publication.js";
import { buildNativeAudioCommand } from "./audio-command.js";
import { prepareNativeAudioBytes } from "./audio-bytes.js";
import { prepareNativeAudioFile } from "./audio-file.js";
import { buildNativeThumbnailCommand } from "./thumbnail-command.js";
import { prepareNativeThumbnailBytes } from "./thumbnail-bytes.js";
import { prepareNativeThumbnailFile } from "./thumbnail-file.js";

interface Dependencies {
  prepare?: typeof prepareNativeTools;
  inventory?: typeof discoverNativeInventory;
  probe?: typeof probeNativeFile;
  probeDetails?: typeof probeNativeFileDetails;
  prepareBytes?: typeof prepareNativeMp4Bytes;
  workspace?: typeof createNativeWorkspace;
  prepareFile?: typeof prepareNativeMp4File;
  pathWorkspace?: typeof createNativePathWorkspace;
  publish?: typeof publishNativeFile;
  prepareAudioBytes?: typeof prepareNativeAudioBytes;
  prepareAudioFile?: typeof prepareNativeAudioFile;
  prepareThumbnailBytes?: typeof prepareNativeThumbnailBytes;
  prepareThumbnailFile?: typeof prepareNativeThumbnailFile;
}

interface ReadyState {
  tools: PreparedNativeTools;
  capabilities: EngineCapabilities;
  inventory: NativeInventory;
  byteExportEnabled: boolean;
  trimEnabled: boolean;
  resizeEnabled: boolean;
  mp3ExportEnabled: boolean;
  pcmExportEnabled: boolean;
  audioTrimEnabled: boolean;
  jpegThumbnailEnabled: boolean;
  pngThumbnailEnabled: boolean;
  thumbnailResizeEnabled: boolean;
}

export function createNativeEngine(
  options: NativeEngineOptions = {},
  dependencies: Dependencies = {},
): EngineAdapter {
  // Capture configuration now; filesystem and process work stays lazy.
  const configuration = captureNativeConfiguration(options);
  const prepare = dependencies.prepare ?? prepareNativeTools;
  const inventory = dependencies.inventory ?? discoverNativeInventory;
  const createWorkspace = dependencies.workspace ?? createNativeWorkspace;
  const pendingWorkspaces = new Set<NativeWorkspace>();
  const prepareFile = dependencies.prepareFile ?? prepareNativeMp4File;
  const createPathWorkspace = dependencies.pathWorkspace ?? createNativePathWorkspace;
  const publish = dependencies.publish ?? publishNativeFile;
  let lastProbe: NativeProbeDetails | undefined;

  const probeDetails = dependencies.probeDetails ?? probeNativeFileDetails;
  const prepareBytes = dependencies.prepareBytes ?? prepareNativeMp4Bytes;

  const prepareAudioBytes = dependencies.prepareAudioBytes ?? prepareNativeAudioBytes;
  const prepareAudioFile = dependencies.prepareAudioFile ?? prepareNativeAudioFile;

  const prepareThumbnailBytes = dependencies.prepareThumbnailBytes ?? prepareNativeThumbnailBytes;
  const prepareThumbnailFile = dependencies.prepareThumbnailFile ?? prepareNativeThumbnailFile;

  const probe: typeof probeNativeFile =
    dependencies.probe ??
    (async (configuration, tools, path, context) => {
      const details = await probeDetails(configuration, tools, path, context);
      lastProbe = details;
      return details.metadata;
    });

  const id = "native-ffmpeg";
  let ready: ReadyState | undefined;

  function checkAbort(context: EngineContext): void {
    if (context.signal.aborted) {
      throw createMavioError("CANCELLED", "Native operation was cancelled.", {
        stage: "preparing",
        jobId: context.jobId,
        engineId: id,
        cause: context.signal.reason,
      });
    }
  }

  function requireReady(): ReadyState {
    if (ready === undefined) {
      throw createMavioError("ENGINE_INIT_FAILED", "The native engine has not been initialized.", {
        stage: "preparing",
        engineId: id,
        details: { reason: "NATIVE_NOT_INITIALIZED" },
      });
    }

    return ready;
  }

  function isNativeExportPlan(plan: ProcessingPlan): boolean {
    if (plan?.terminal?.type !== "export" || plan.terminal.format !== "mp4") {
      return false;
    }

    const preset = plan.terminal.preset;

    if (preset !== "video-balanced-v1" && preset !== "video-small-v1") {
      return false;
    }

    return (
      (plan.output?.kind === "bytes" || plan.output?.kind === "path") &&
      (plan.input?.kind === "path" || plan.input?.kind === "bytes") &&
      Array.isArray(plan.transformations) &&
      plan.transformations.every(
        (item) =>
          item.type === "trim" ||
          item.type === "resize" ||
          (item.type === "compress" && item.options.preset === preset) ||
          (item.type === "convert" &&
            item.options.format === "mp4" &&
            item.options.preset === preset),
      )
    );
  }

  function isNativeAudioExportPlan(plan: ProcessingPlan): boolean {
    if (plan?.terminal?.type !== "export") return false;

    const { preset, format } = plan.terminal;

    if (!(
      (preset === "audio-balanced-v1" && format === "mp3") ||
      (preset === "audio-pcm-v1" && format === "wav")
    )) {
      return false;
    }

    if (
      (plan.input?.kind !== "path" && plan.input?.kind !== "bytes") ||
      (plan.output?.kind !== "path" && plan.output?.kind !== "bytes") ||
      !Array.isArray(plan.transformations)
    ) {
      return false;
    }

    const seen = new Set<string>();

    return plan.transformations.every((item) => {
      if (item.type === "trim") {
        const { start, end } = item.options;
        return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
      }

      if (seen.has(item.type)) return false;
      seen.add(item.type);

      if (item.type === "extractAudio") {
        const index = item.options.streamIndex;
        return index === undefined || (Number.isSafeInteger(index) && index >= 0);
      }

      if (item.type === "compress") {
        return item.options.preset === preset;
      }

      if (item.type === "convert") {
        return item.options.preset === preset && item.options.format === format;
      }

      return false;
    });
  }

  function isNativeThumbnailPlan(plan: ProcessingPlan): boolean {
    if (plan?.terminal?.type !== "thumbnail") return false;

    const { preset, format, at } = plan.terminal;

    if (
      !(
        (preset === "jpeg-balanced-v1" && format === "jpeg") ||
        (preset === "png-lossless-v1" && format === "png")
      ) ||
      !Number.isFinite(at) ||
      at < 0
    ) {
      return false;
    }

    return (
      (plan.input?.kind === "path" || plan.input?.kind === "bytes") &&
      (plan.output?.kind === "path" || plan.output?.kind === "bytes") &&
      Array.isArray(plan.transformations) &&
      plan.transformations.every((item) => {
        if (item.type === "resize") {
          const { width, height } = item.options;

          return (
            Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
          );
        }

        if (item.type !== "trim") return false;

        const { start, end } = item.options;
        return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
      })
    );
  }

  function isEnabledExportPlan(plan: ProcessingPlan, state: ReadyState): boolean {
    if (isNativeThumbnailPlan(plan)) {
      const encodingEnabled =
        plan.terminal.preset === "jpeg-balanced-v1"
          ? state.jpegThumbnailEnabled
          : state.pngThumbnailEnabled;

      return (
        encodingEnabled &&
        (state.thumbnailResizeEnabled ||
          !plan.transformations.some((item) => item.type === "resize"))
      );
    }

    if (isNativeAudioExportPlan(plan)) {
      const encodingEnabled =
        plan.terminal.type === "export" && plan.terminal.preset === "audio-balanced-v1"
          ? state.mp3ExportEnabled
          : state.pcmExportEnabled;

      return (
        encodingEnabled &&
        (state.audioTrimEnabled || !plan.transformations.some((item) => item.type === "trim"))
      );
    }

    return (
      state.byteExportEnabled &&
      isNativeExportPlan(plan) &&
      (state.trimEnabled || !plan.transformations.some((item) => item.type === "trim")) &&
      (state.resizeEnabled || !plan.transformations.some((item) => item.type === "resize"))
    );
  }

  async function executePath(
    plan: ProcessingPlan,
    context: ExecutionEngineContext,
    state: ReadyState,
  ): Promise<Awaited<ReturnType<EngineAdapter["execute"]>>> {
    if (plan.output.kind !== "path") {
      throw createMavioError("INVALID_OPTIONS", "A path output is required.");
    }

    const targetPath = plan.output.path;
    let workspace: NativeWorkspace | undefined;
    let result: Awaited<ReturnType<EngineAdapter["execute"]>> | undefined;
    let failure: MavioError | undefined;
    let published = false;

    try {
      workspace = await createPathWorkspace(targetPath);
      pendingWorkspaces.add(workspace);
      checkAbort(context);

      const prepareOutput = isNativeThumbnailPlan(plan)
        ? prepareThumbnailFile
        : isNativeAudioExportPlan(plan)
          ? prepareAudioFile
          : prepareFile;

      const prepared = await prepareOutput({
        configuration,
        tools: state.tools,
        inventory: state.inventory,
        plan,
        workspace,
        context,
      });

      checkAbort(context);

      // Capture and validate the result before any publication occurs.
      result = captureExecutionResult(
        {
          output: { kind: "path", path: targetPath },
          metadata: prepared.metadata,
        },
        plan.output,
      );

      context.reportProgress({ stage: "finalizing" });
      checkAbort(context);

      // This helper owns the single commit-gate attempt.
      await publish(prepared.path, targetPath, context);
      published = true;
    } catch (cause) {
      const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

      failure = createMavioError(
        getErrorCode(cause) ?? (context.signal.aborted ? "CANCELLED" : "EXECUTION_FAILED"),
        primary?.message ?? "Native file export failed.",
        {
          stage: primary?.stage ?? "finalizing",
          jobId: context.jobId,
          engineId: id,
          details: primary?.details,
          cleanupIssues: primary?.cleanupIssues,
          cause,
        },
      );
    }

    if (workspace !== undefined) {
      try {
        await workspace.dispose();
        pendingWorkspaces.delete(workspace);
      } catch (cause) {
        if (published && result !== undefined) {
          result = {
            ...result,
            warnings: [
              ...(result.warnings ?? []),
              {
                code: "CLEANUP_FAILED",
                message: "Output was published, but staging cleanup needs retrying.",
              },
            ],
          };
        } else {
          failure = createMavioError(
            failure?.code ?? (context.signal.aborted ? "CANCELLED" : "CLEANUP_FAILED"),
            failure?.message ?? "Native file workspace cleanup failed.",
            {
              stage: failure?.stage ?? "finalizing",
              jobId: context.jobId,
              engineId: id,
              details: failure?.details ?? { reason: "WORKSPACE_CLEANUP_FAILED" },
              cleanupIssues: [
                ...(failure?.cleanupIssues ?? []),
                "Native file workspace cleanup failed.",
              ],
              cause: failure ?? cause,
            },
          );
        }

        // Keep this workspace registered so disposal can retry cleanup.
      }
    }

    if (failure !== undefined) {
      throw preserveFailure(failure);
    }

    if (!published || result === undefined) {
      throw createMavioError("EXECUTION_FAILED", "File publication returned no result.");
    }

    // Successful publication survives late cancellation and cleanup warnings.
    return result;
  }

  return {
    id,
    runtime: "node",

    async initialize(context) {
      checkAbort(context);
      if (ready !== undefined) return;

      const tools = await prepare(configuration, context);
      checkAbort(context);

      const discovered = await inventory(configuration, tools, context);
      checkAbort(context);

      // Conservatively enable the preset only with both video and audio encoders.
      const byteExportEnabled =
        discovered.muxers.includes("mp4") &&
        discovered.encoders.includes("libx264") &&
        discovered.encoders.includes("aac");

      const trimEnabled =
        byteExportEnabled &&
        discovered.muxers.includes("framemd5") &&
        ["rawvideo", "pcm_f32le"].every((name) => discovered.encoders.includes(name)) &&
        ["trim", "settb", "setpts", "atrim", "asetpts"].every((name) =>
          discovered.filters.includes(name),
        );

      const resizeEnabled =
        byteExportEnabled && ["scale", "setsar"].every((name) => discovered.filters.includes(name));

      const mp3ExportEnabled =
        discovered.muxers.includes("mp3") && discovered.encoders.includes("libmp3lame");

      const pcmExportEnabled =
        discovered.muxers.includes("wav") && discovered.encoders.includes("pcm_s16le");

      const audioExportEnabled = mp3ExportEnabled || pcmExportEnabled;

      const audioTrimEnabled =
        audioExportEnabled &&
        discovered.muxers.includes("framemd5") &&
        discovered.encoders.includes("pcm_f32le") &&
        ["atrim", "asetpts"].every((name) => discovered.filters.includes(name));

      const anyExportEnabled = byteExportEnabled || audioExportEnabled;

      const thumbnailBaseEnabled =
        ["image2pipe", "framemd5"].every((name) => discovered.muxers.includes(name)) &&
        discovered.encoders.includes("rawvideo") &&
        ["trim", "setpts", "scale", "format"].every((name) => discovered.filters.includes(name));

      const jpegThumbnailEnabled = thumbnailBaseEnabled && discovered.encoders.includes("mjpeg");

      const pngThumbnailEnabled = thumbnailBaseEnabled && discovered.encoders.includes("png");

      const anyThumbnailEnabled = jpegThumbnailEnabled || pngThumbnailEnabled;

      const thumbnailResizeEnabled = anyThumbnailEnabled && discovered.filters.includes("setsar");

      const encodings: EngineCapabilities["encodings"] = [
        ...(byteExportEnabled
          ? [
              {
                container: "mp4" as const,
                videoCodec: "h264",
                audioCodec: "aac",
                preset: "video-balanced-v1" as const,
              },
              {
                container: "mp4" as const,
                videoCodec: "h264",
                audioCodec: "aac",
                preset: "video-small-v1" as const,
              },
            ]
          : []),
        ...(mp3ExportEnabled
          ? [
              {
                container: "mp3" as const,
                audioCodec: "mp3",
                preset: "audio-balanced-v1" as const,
              },
            ]
          : []),
        ...(pcmExportEnabled
          ? [
              {
                container: "wav" as const,
                audioCodec: "pcm_s16le",
                preset: "audio-pcm-v1" as const,
              },
            ]
          : []),
        ...(jpegThumbnailEnabled
          ? [
              {
                container: "jpeg" as const,
                videoCodec: "mjpeg",
                preset: "jpeg-balanced-v1" as const,
              },
            ]
          : []),
        ...(pngThumbnailEnabled
          ? [
              {
                container: "png" as const,
                videoCodec: "png",
                preset: "png-lossless-v1" as const,
              },
            ]
          : []),
      ];

      // Publish state only after the complete initialization succeeds.
      ready = {
        tools,
        inventory: discovered,
        byteExportEnabled,
        mp3ExportEnabled,
        pcmExportEnabled,
        trimEnabled,
        resizeEnabled,
        audioTrimEnabled,
        jpegThumbnailEnabled,
        pngThumbnailEnabled,
        thumbnailResizeEnabled,
        capabilities: {
          engineId: id,
          engineVersion: `ffmpeg ${tools.ffmpeg.version}; ffprobe ${tools.ffprobe.version}`,
          runtime: "node",
          operations: [
            "metadata",
            ...(anyExportEnabled ? (["convert", "compress"] as const) : []),
            ...(audioExportEnabled ? (["extractAudio"] as const) : []),
            ...(trimEnabled || audioTrimEnabled || anyThumbnailEnabled ? (["trim"] as const) : []),
            ...(anyThumbnailEnabled ? (["thumbnail"] as const) : []),
            ...(resizeEnabled || thumbnailResizeEnabled ? (["resize"] as const) : []),
          ],
          inputKinds: ["path", "bytes"],
          outputKinds: anyExportEnabled || anyThumbnailEnabled ? ["bytes", "path"] : [],
          readableContainers: [],
          decoders: [],
          encodings,
          limits: {},
        },
      };
    },

    async capabilities() {
      return structuredClone(requireReady().capabilities);
    },

    async probe(input, context) {
      lastProbe = undefined;
      checkAbort(context);
      const state = requireReady();

      if (input.kind === "path") {
        return probe(configuration, state.tools, input.path, context);
      }

      if (input.kind !== "bytes") {
        throw createMavioError(
          "UNSUPPORTED_CAPABILITY",
          "The native engine accepts file paths or bytes.",
          {
            stage: "preparing",
            jobId: context.jobId,
            engineId: id,
            operation: "metadata",
            details: { reason: "NATIVE_INPUT_NOT_IMPLEMENTED" },
          },
        );
      }

      let workspace: NativeWorkspace | undefined;
      let metadata: MavioMediaMetadata | undefined;
      let failure: MavioError | undefined;

      try {
        workspace = await createWorkspace();
        pendingWorkspaces.add(workspace);
        checkAbort(context);

        const path = await workspace.writeInput(input.bytes, context);
        checkAbort(context);

        metadata = await probe(configuration, state.tools, path, context);
        checkAbort(context);
      } catch (cause) {
        const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

        failure = createMavioError(
          getErrorCode(cause) ?? (context.signal.aborted ? "CANCELLED" : "EXECUTION_FAILED"),
          primary?.message ?? "Native byte probing failed.",
          {
            stage: "preparing",
            jobId: context.jobId,
            engineId: id,
            operation: "metadata",
            details: primary?.details,
            cleanupIssues: primary?.cleanupIssues,
            cause,
          },
        );
      }

      if (workspace !== undefined) {
        try {
          await workspace.dispose();
          pendingWorkspaces.delete(workspace);
        } catch (cause) {
          const cleanupIssues = [
            ...(failure?.cleanupIssues ?? []),
            "Native input workspace cleanup failed.",
          ];

          failure = createMavioError(
            failure?.code ?? (context.signal.aborted ? "CANCELLED" : "CLEANUP_FAILED"),
            failure?.message ?? "Native input workspace cleanup failed.",
            {
              stage: failure?.stage ?? "finalizing",
              jobId: context.jobId,
              engineId: id,
              operation: "metadata",
              details: failure?.details ?? {
                reason: "WORKSPACE_CLEANUP_FAILED",
              },
              cleanupIssues,
              cause: failure ?? cause,
            },
          );

          // Retain the workspace so engine disposal can retry cleanup.
        }
      }

      if (failure !== undefined) {
        throw preserveFailure(failure);
      }

      checkAbort(context);

      if (metadata === undefined) {
        throw createMavioError("EXECUTION_FAILED", "Native probing did not return metadata.");
      }

      return metadata;
    },

    async supports(plan, source) {
      const state = requireReady();

      if (!isEnabledExportPlan(plan, state)) {
        return {
          status: "unsupported",
          issues: [
            {
              code: "NATIVE_PROCESSING_PENDING",
              message: "This native processing route is not implemented.",
            },
          ],
        };
      }

      if (
        lastProbe === undefined ||
        JSON.stringify(lastProbe.metadata) !== JSON.stringify(source)
      ) {
        return {
          status: "unknown",
          issues: [
            {
              code: "NATIVE_SOURCE_DETAILS_REQUIRED",
              message: "Matching detailed source metadata is required.",
            },
          ],
        };
      }

      const video = source.streams.find((stream) => stream.kind === "video");

      if (
        !isNativeAudioExportPlan(plan) &&
        video?.rotationDegrees !== undefined &&
        video.rotationDegrees !== 0
      ) {
        return {
          status: "unsupported",
          issues: [
            {
              code: "NATIVE_ORIENTATION_PENDING",
              message: "Rotation normalization is not implemented for this route.",
            },
          ],
        };
      }

      try {
        // Pure validation: these paths are never opened or created.
        const buildCommand = isNativeThumbnailPlan(plan)
          ? buildNativeThumbnailCommand
          : isNativeAudioExportPlan(plan)
            ? buildNativeAudioCommand
            : buildNativeMp4Command;

        buildCommand({
          plan,
          source: lastProbe,
          inventory: state.inventory,
          inputPath: join(configuration.cwd, ".mavio-support-input"),
          outputPath: join(configuration.cwd, ".mavio-support-output"),
        });

        return { status: "supported" };
      } catch (cause) {
        const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

        return {
          status: "unsupported",
          issues: [
            {
              code: String(primary?.details?.reason ?? "UNSUPPORTED_NATIVE_PLAN"),
              message: primary?.message ?? "The native plan is unsupported.",
            },
          ],
        };
      }
    },

    async execute(plan, context) {
      checkAbort(context);
      const state = requireReady();

      if (!isEnabledExportPlan(plan, state)) {
        throw createMavioError(
          "UNSUPPORTED_CAPABILITY",
          "This native processing route is not implemented.",
          {
            stage: "preparing",
            jobId: context.jobId,
            engineId: id,
            details: { reason: "NATIVE_PROCESSING_PENDING" },
          },
        );
      }

      if (plan.output.kind === "path") {
        return executePath(plan, context, state);
      }

      let workspace: NativeWorkspace | undefined;
      let result: Awaited<ReturnType<EngineAdapter["execute"]>> | undefined;
      let failure: MavioError | undefined;

      try {
        workspace = await createWorkspace();
        pendingWorkspaces.add(workspace);
        checkAbort(context);

        const prepareOutput = isNativeThumbnailPlan(plan)
          ? prepareThumbnailBytes
          : isNativeAudioExportPlan(plan)
            ? prepareAudioBytes
            : prepareBytes;

        const prepared = await prepareOutput({
          configuration,
          tools: state.tools,
          inventory: state.inventory,
          plan,
          workspace,
          context,
        });

        checkAbort(context);

        // Validate the result before allowing publication.
        result = captureExecutionResult(
          {
            output: { kind: "bytes", bytes: prepared.bytes },
            metadata: prepared.metadata,
          },
          plan.output,
        );

        context.reportProgress({ stage: "finalizing" });
        checkAbort(context);
      } catch (cause) {
        const primary = cause instanceof Error ? (cause as Partial<MavioError>) : undefined;

        failure = createMavioError(
          getErrorCode(cause) ?? (context.signal.aborted ? "CANCELLED" : "EXECUTION_FAILED"),
          primary?.message ?? "Native byte export failed.",
          {
            stage: primary?.stage ?? "running",
            jobId: context.jobId,
            engineId: id,
            details: primary?.details,
            cleanupIssues: primary?.cleanupIssues,
            cause,
          },
        );
      }

      if (workspace !== undefined) {
        try {
          await workspace.dispose();
          pendingWorkspaces.delete(workspace);
        } catch (cause) {
          failure = createMavioError(
            failure?.code ?? (context.signal.aborted ? "CANCELLED" : "CLEANUP_FAILED"),
            failure?.message ?? "Native export workspace cleanup failed.",
            {
              stage: failure?.stage ?? "finalizing",
              jobId: context.jobId,
              engineId: id,
              details: failure?.details ?? { reason: "WORKSPACE_CLEANUP_FAILED" },
              cleanupIssues: [
                ...(failure?.cleanupIssues ?? []),
                "Native export workspace cleanup failed.",
              ],
              cause: failure ?? cause,
            },
          );

          // Retain the workspace for disposal/reset to retry cleanup.
        }
      }

      if (failure !== undefined) {
        throw preserveFailure(failure);
      }

      checkAbort(context);

      if (result === undefined) {
        throw createMavioError("EXECUTION_FAILED", "Native export returned no result.");
      }

      if (!context.beginCommit()) {
        throw createMavioError("CANCELLED", "Native export publication was denied.", {
          stage: "finalizing",
          jobId: context.jobId,
          engineId: id,
        });
      }

      // Publication was granted. Later cancellation cannot revoke these bytes.
      return result;
    },

    async dispose() {
      lastProbe = undefined;
      ready = undefined;

      const failures: unknown[] = [];

      for (const workspace of pendingWorkspaces) {
        try {
          await workspace.dispose();
          pendingWorkspaces.delete(workspace);
        } catch (cause) {
          failures.push(cause);
        }
      }

      if (failures.length > 0) {
        throw createMavioError("CLEANUP_FAILED", "Native workspace cleanup remains incomplete.", {
          stage: "finalizing",
          engineId: id,
          details: { reason: "WORKSPACE_CLEANUP_FAILED" },
          cause: new AggregateError(failures),
        });
      }
    },
  };
}
