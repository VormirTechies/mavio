import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type {
  BrowserEngineOptions,
  EngineAdapter,
  EngineCapabilities,
  ProcessingPlan,
} from "../../contracts.js";
import { createMavioError, getErrorCode } from "../../core/errors.js";
import { captureBrowserConfiguration } from "./config.js";
import { initializeBrowserWorker } from "./initialize.js";
import { probeBrowserInput, probeBrowserInputDetails } from "./probe.js";
import type { BrowserProbeDetails } from "./probe-details.js";
import { prepareBrowserMp4Bytes } from "./mp4-bytes.js";
import { buildBrowserMp4Command } from "./mp4-command.js";
import { captureExecutionResult } from "../../core/adapter-response.js";
import { discoverBrowserInventory, type BrowserInventory } from "./inventory.js";
import { prepareBrowserAudioBytes } from "./audio-bytes.js";
import { buildBrowserAudioCommand } from "./audio-command.js";
import { prepareBrowserThumbnailBytes } from "./thumbnail-bytes.js";
import { buildBrowserThumbnailCommand } from "./thumbnail-command.js";

interface Dependencies {
  environment?: Parameters<typeof captureBrowserConfiguration>[1];
  loader?: Parameters<typeof initializeBrowserWorker>[2];
  probe?: typeof probeBrowserInput;
  inventory?: typeof discoverBrowserInventory;
  probeDetails?: typeof probeBrowserInputDetails;
  prepareBytes?: typeof prepareBrowserMp4Bytes;
  prepareAudioBytes?: typeof prepareBrowserAudioBytes;
  prepareThumbnailBytes?: typeof prepareBrowserThumbnailBytes;
}

export function createBrowserEngine(
  options: BrowserEngineOptions,
  dependencies: Dependencies = {},
): EngineAdapter {
  const configuration = captureBrowserConfiguration(options, dependencies.environment);

  const id = "browser-ffmpeg";
  let worker: FFmpeg | undefined;
  let inventory: BrowserInventory | undefined;
  let lastProbe: BrowserProbeDetails | undefined;
  let unsafe = false;

  function unavailable(): never {
    throw createMavioError("ENGINE_UNAVAILABLE", "Browser worker is not initialized.", {
      engineId: id,
      stage: "preparing",
    });
  }

  function isAudioPlan(plan: ProcessingPlan): boolean {
    return (
      plan.terminal.type === "export" &&
      (plan.terminal.preset === "audio-balanced-v1" || plan.terminal.preset === "audio-pcm-v1")
    );
  }

  function audioTrimAvailable(available: BrowserInventory): boolean {
    const audioExport =
      (available.muxers.includes("mp3") && available.encoders.includes("libmp3lame")) ||
      (available.muxers.includes("wav") && available.encoders.includes("pcm_s16le"));

    return (
      audioExport &&
      available.filters.includes("atrim") &&
      available.filters.includes("asetpts") &&
      available.encoders.includes("pcm_f32le") &&
      available.muxers.includes("framemd5")
    );
  }

  function thumbnailAvailable(available: BrowserInventory): boolean {
    return (
      available.muxers.includes("image2pipe") &&
      available.muxers.includes("framemd5") &&
      available.encoders.includes("rawvideo") &&
      (available.encoders.includes("mjpeg") || available.encoders.includes("png")) &&
      ["trim", "setpts", "scale", "format"].every((filter) => available.filters.includes(filter))
    );
  }

  function videoTrimAvailable(available: BrowserInventory): boolean {
    return (
      available.muxers.includes("mp4") &&
      available.encoders.includes("libx264") &&
      available.muxers.includes("framemd5") &&
      available.encoders.includes("rawvideo") &&
      ["trim", "settb", "setpts"].every((filter) => available.filters.includes(filter))
    );
  }

  function checkPlan(plan: ProcessingPlan): void {
    if (unsafe || worker === undefined || !worker.loaded || inventory === undefined) {
      unavailable();
    }

    if (lastProbe === undefined) {
      throw createMavioError(
        "UNSUPPORTED_CAPABILITY",
        "Detailed source metadata is required for browser export.",
        { details: { reason: "SOURCE_DETAILS_REQUIRED" } },
      );
    }

    if (plan.terminal.type === "thumbnail") {
      if (!thumbnailAvailable(inventory)) {
        throw createMavioError(
          "UNSUPPORTED_CAPABILITY",
          "The browser core lacks the required thumbnail features.",
          {
            stage: "preparing",
            operation: "thumbnail",
            details: { reason: "BROWSER_THUMBNAIL_UNAVAILABLE" },
          },
        );
      }

      buildBrowserThumbnailCommand({
        plan,
        source: lastProbe,
        inventory,
        inputPath: "/mavio-preflight/input.bin",
        outputPath:
          plan.terminal.format === "jpeg"
            ? "/mavio-preflight/output.jpeg"
            : "/mavio-preflight/output.png",
      });

      return;
    }

    if (plan.transformations.some((operation) => operation.type === "trim")) {
      const videoAudioAnalysisMissing =
        lastProbe.metadata.streams.some((stream) => stream.kind === "audio") &&
        (!inventory.encoders.includes("pcm_f32le") || !inventory.muxers.includes("f32le"));

      if (!isAudioPlan(plan) && (!videoTrimAvailable(inventory) || videoAudioAnalysisMissing)) {
        throw createMavioError(
          "UNSUPPORTED_CAPABILITY",
          "The browser core lacks the required video trim features.",
          {
            stage: "preparing",
            operation: "trim",
            details: { reason: "BROWSER_VIDEO_TRIM_UNAVAILABLE" },
          },
        );
      }
      if (isAudioPlan(plan) && !audioTrimAvailable(inventory)) {
        throw createMavioError(
          "UNSUPPORTED_CAPABILITY",
          "The browser core lacks the required audio trim features.",
          {
            stage: "preparing",
            operation: "trim",
            details: { reason: "BROWSER_AUDIO_TRIM_UNAVAILABLE" },
          },
        );
      }
    }

    // Validation only: no filesystem or encoding work.
    if (isAudioPlan(plan)) {
      buildBrowserAudioCommand({
        plan,
        source: lastProbe,
        inventory,
        inputPath: "/mavio-preflight/input.bin",
        outputPath:
          plan.terminal.type === "export" && plan.terminal.preset === "audio-balanced-v1"
            ? "/mavio-preflight/output.mp3"
            : "/mavio-preflight/output.wav",
      });
    } else {
      buildBrowserMp4Command({
        plan,
        source: lastProbe,
        inventory,
        inputPath: "/mavio-preflight/input.bin",
        outputPath: "/mavio-preflight/output.mp4",
      });
    }
  }

  return {
    id,
    runtime: "browser",

    async initialize(context) {
      if (context.signal.aborted) {
        throw createMavioError("CANCELLED", "Browser initialization was cancelled.", {
          stage: "preparing",
          jobId: context.jobId,
          engineId: id,
          cause: context.signal.reason,
        });
      }

      if (unsafe) {
        throw createMavioError(
          "ENGINE_UNAVAILABLE",
          "Browser worker cleanup failed; this adapter cannot be reused.",
          {
            stage: "preparing",
            engineId: id,
            details: { reason: "UNSAFE_ENGINE_STATE" },
          },
        );
      }

      if (worker !== undefined) {
        if (!worker.loaded || inventory === undefined) unavailable();
        return;
      }

      try {
        worker = await initializeBrowserWorker(configuration, context, dependencies.loader);

        const discovered = await (dependencies.inventory ?? discoverBrowserInventory)(
          worker,
          context,
        );

        if (context.signal.aborted) {
          throw createMavioError("CANCELLED", "Browser capability discovery was cancelled.", {
            stage: "preparing",
            jobId: context.jobId,
            cause: context.signal.reason,
          });
        }

        // Capture independent arrays rather than retaining dependency-owned data.
        inventory = Object.freeze({
          encoders: Object.freeze([...discovered.encoders]),
          decoders: Object.freeze([...discovered.decoders]),
          muxers: Object.freeze([...discovered.muxers]),
          demuxers: Object.freeze([...discovered.demuxers]),
          filters: Object.freeze([...discovered.filters]),
        });
      } catch (cause) {
        inventory = undefined;

        if (
          worker === undefined &&
          cause instanceof Error &&
          "cleanupIssues" in cause &&
          Array.isArray(cause.cleanupIssues) &&
          cause.cleanupIssues.length > 0
        ) {
          // Initialization failed before returning worker ownership.
          unsafe = true;
        }

        throw cause;
      }
    },

    async capabilities(): Promise<EngineCapabilities> {
      if (unsafe || worker === undefined || !worker.loaded || inventory === undefined) {
        unavailable();
      }

      const mp4Enabled = inventory.muxers.includes("mp4") && inventory.encoders.includes("libx264");

      const mp3Enabled =
        inventory.muxers.includes("mp3") && inventory.encoders.includes("libmp3lame");

      const pcmEnabled =
        inventory.muxers.includes("wav") && inventory.encoders.includes("pcm_s16le");

      const audioEnabled = mp3Enabled || pcmEnabled;
      const exportEnabled = mp4Enabled || audioEnabled;
      const hasAAC = inventory.encoders.includes("aac");

      const thumbnailsEnabled = thumbnailAvailable(inventory);

      const jpegEnabled = thumbnailsEnabled && inventory.encoders.includes("mjpeg");

      const pngEnabled = thumbnailsEnabled && inventory.encoders.includes("png");

      const resizeEnabled =
        inventory.filters.includes("setsar") &&
        inventory.filters.includes("scale") &&
        (mp4Enabled || thumbnailsEnabled);

      const encodings: EngineCapabilities["encodings"] = [
        ...(mp4Enabled
          ? (["video-balanced-v1", "video-small-v1"] as const).map((preset) => ({
              container: "mp4" as const,
              videoCodec: "h264",
              preset,
              ...(hasAAC
                ? {
                    audioCodec: "aac",
                    audioPadding: "decoder-dependent" as const,
                  }
                : {}),
            }))
          : []),
        ...(mp3Enabled
          ? [
              {
                container: "mp3" as const,
                audioCodec: "mp3",
                preset: "audio-balanced-v1" as const,
              },
            ]
          : []),
        ...(pcmEnabled
          ? [
              {
                container: "wav" as const,
                audioCodec: "pcm_s16le",
                preset: "audio-pcm-v1" as const,
              },
            ]
          : []),
        ...(jpegEnabled
          ? [
              {
                container: "jpeg" as const,
                videoCodec: "mjpeg",
                preset: "jpeg-balanced-v1" as const,
              },
            ]
          : []),
        ...(pngEnabled
          ? [
              {
                container: "png" as const,
                videoCodec: "png",
                preset: "png-lossless-v1" as const,
              },
            ]
          : []),
      ];

      return {
        engineId: id,
        engineVersion: "@ffmpeg/core@0.12.10",
        runtime: "browser",
        operations: [
          "metadata",
          ...(exportEnabled ? (["convert", "compress"] as const) : []),
          ...(resizeEnabled ? (["resize"] as const) : []),
          ...(audioEnabled ? (["extractAudio"] as const) : []),
          ...(audioTrimAvailable(inventory) || videoTrimAvailable(inventory) || thumbnailsEnabled
            ? (["trim"] as const)
            : []),
          ...(thumbnailsEnabled ? (["thumbnail"] as const) : []),
        ],
        inputKinds: ["bytes", "blob"],
        outputKinds: exportEnabled || thumbnailsEnabled ? ["bytes", "blob"] : [],
        readableContainers: [...inventory.demuxers],
        decoders: [...inventory.decoders],
        encodings,
        limits: {},
      };
    },

    async probe(input, context) {
      if (unsafe || worker === undefined || !worker.loaded) unavailable();

      lastProbe = undefined;

      // Retain the existing metadata-only test hook.
      if (dependencies.probe !== undefined) {
        return dependencies.probe(worker, input, context);
      }

      const details = await (dependencies.probeDetails ?? probeBrowserInputDetails)(
        worker,
        input,
        context,
      );

      lastProbe = structuredClone(details);
      return details.metadata;
    },

    async supports(plan) {
      try {
        checkPlan(plan);
        return { status: "supported" };
      } catch (cause) {
        const code = getErrorCode(cause);

        if (
          code !== "UNSUPPORTED_CAPABILITY" &&
          code !== "INVALID_MEDIA" &&
          code !== "INVALID_OPTIONS"
        ) {
          throw cause;
        }

        return {
          status: "unsupported",
          issues: [
            {
              code,
              message: cause instanceof Error ? cause.message : "Unsupported browser export plan.",
            },
          ],
        };
      }
    },

    async execute(plan, context) {
      if (unsafe || worker === undefined || !worker.loaded || inventory === undefined) {
        unavailable();
      }

      checkPlan(plan);

      try {
        const audio = isAudioPlan(plan);

        const prepare =
          plan.terminal.type === "thumbnail"
            ? (dependencies.prepareThumbnailBytes ?? prepareBrowserThumbnailBytes)
            : audio
              ? (dependencies.prepareAudioBytes ?? prepareBrowserAudioBytes)
              : (dependencies.prepareBytes ?? prepareBrowserMp4Bytes);

        const prepared = await prepare(
          worker,
          { ...plan, output: { kind: "bytes" } },
          inventory,
          context,
        );

        const mimeType =
          plan.terminal.type === "thumbnail"
            ? plan.terminal.format === "jpeg"
              ? "image/jpeg"
              : "image/png"
            : audio
              ? plan.terminal.type === "export" && plan.terminal.preset === "audio-balanced-v1"
                ? "audio/mpeg"
                : "audio/wav"
              : "video/mp4";

        // Preparation has already completed workspace cleanup.
        const bytes = new Uint8Array(prepared.bytes);

        const output =
          plan.output.kind === "blob"
            ? {
                kind: "blob" as const,
                blob: new Blob([bytes.buffer], { type: mimeType }),
              }
            : {
                kind: "bytes" as const,
                bytes,
              };

        // Validate before granting publication.
        const result = captureExecutionResult({ output, metadata: prepared.metadata }, plan.output);

        if (context.signal.aborted || !context.beginCommit()) {
          throw createMavioError("CANCELLED", "Browser export publication was cancelled.", {
            stage: "finalizing",
            jobId: context.jobId,
          });
        }

        return result;
      } finally {
        lastProbe = undefined;
      }
    },

    async dispose() {
      lastProbe = undefined;
      inventory = undefined;
      if (unsafe) {
        throw createMavioError("CLEANUP_FAILED", "Browser worker termination previously failed.", {
          engineId: id,
          stage: "finalizing",
        });
      }

      if (worker === undefined) return;

      // Probe failure or cancellation may have already terminated it.
      // Retain the reference if a new termination attempt throws.
      if (worker.loaded) worker.terminate();
      worker = undefined;
    },
  };
}
