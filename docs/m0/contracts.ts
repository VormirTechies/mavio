/** M0 contract baseline approved by owner 2026-09-25. M0 design and bounded type checks complete. No runtime implementation or npm publication. */
export type Runtime = "browser" | "node";
export type OperationName = "convert" | "compress" | "trim" | "resize" | "extractAudio" | "thumbnail" | "metadata";
export type MediaFormat = "mp4" | "webm" | "mp3" | "wav" | "jpeg" | "png";
export type PresetId = "video-balanced-v1" | "video-small-v1" | "audio-balanced-v1" | "audio-pcm-v1" | "jpeg-balanced-v1" | "png-lossless-v1";
export type MediaInput =
  | { kind: "blob"; blob: Blob }
  | { kind: "bytes"; bytes: Uint8Array; name?: string }
  | { kind: "path"; path: string };
export type OutputTarget = { kind: "blob" } | { kind: "bytes" } | { kind: "path"; path: string };
export type MediaOutput =
  | { kind: "blob"; blob: Blob }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "path"; path: string };
export type OutputFor<T extends OutputTarget> = Extract<MediaOutput, { kind: T["kind"] }>;
export interface TrimOptions { start: number; end: number }
export interface ResizeOptions { width: number; height: number }
export interface ConvertOptions { format: MediaFormat; preset: PresetId }
export interface CompressOptions { preset: PresetId }
export interface ExtractAudioOptions { streamIndex?: number }
export type Transformation =
  | { type: "trim"; options: TrimOptions }
  | { type: "resize"; options: ResizeOptions }
  | { type: "convert"; options: ConvertOptions }
  | { type: "compress"; options: CompressOptions }
  | { type: "extractAudio"; options: ExtractAudioOptions };
export interface MediaStream {
  index: number;
  kind: "video" | "audio" | "subtitle" | "other";
  codec?: string;
  width?: number;
  height?: number;
  rotationDegrees?: number;
  frameRate?: { numerator: number; denominator: number };
  sampleRate?: number;
  channels?: number;
}
export interface MediaMetadata {
  durationSeconds?: number;
  sizeBytes?: number;
  container?: string;
  bitrateBitsPerSecond?: number;
  streams: readonly MediaStream[];
}
export type JobStage = "queued" | "preparing" | "running" | "finalizing" | "completed" | "cancelled" | "failed";
export interface ProgressEvent {
  jobId: string;
  stage: JobStage;
  percent?: number;
  engineId?: string;
}
export interface ExecutionOptions {
  signal?: AbortSignal;
  onProgress?: (event: Readonly<ProgressEvent>) => void;
}
export type ErrorCode = "INVALID_INPUT" | "INVALID_OPTIONS" | "INVALID_MEDIA" | "UNSUPPORTED_RUNTIME" | "UNSUPPORTED_CAPABILITY" | "ENGINE_UNAVAILABLE" | "ENGINE_INIT_FAILED" | "EXECUTION_FAILED" | "OUTPUT_EXISTS" | "IO_ERROR" | "RESOURCE_LIMIT" | "QUEUE_FULL" | "CANCELLED" | "DISPOSED" | "CLEANUP_FAILED";
export interface MavioError extends Error {
  readonly code: ErrorCode;
  readonly stage: JobStage;
  readonly jobId?: string;
  readonly operation?: OperationName;
  readonly engineId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly cleanupIssues?: readonly string[];
  readonly cause?: unknown;
}
export interface ExportOptions<T extends OutputTarget> { format?: MediaFormat; output: T }
export interface ThumbnailOptions<T extends OutputTarget> {
  at: number;
  format: "jpeg" | "png";
  preset: PresetId;
  output: T;
}
export interface CleanupWarning {
  code: "CLEANUP_FAILED";
  message: string;
}
export interface MediaResult<T extends OutputTarget> {
  /** Post-publication cleanup issues do not invalidate a successful output. */
  warnings?: readonly CleanupWarning[];
  jobId: string;
  output: OutputFor<T>;
  metadata: MediaMetadata;
  engine: { id: string; version: string };
}
export interface Pipeline {
  trim(options: TrimOptions): Pipeline;
  resize(options: ResizeOptions): Pipeline;
  convert(options: ConvertOptions): Pipeline;
  compress(options: CompressOptions): Pipeline;
  extractAudio(options?: ExtractAudioOptions): Pipeline;
  export<T extends OutputTarget>(options: ExportOptions<T>, execution?: ExecutionOptions): Promise<MediaResult<T>>;
  thumbnail<T extends OutputTarget>(options: ThumbnailOptions<T>, execution?: ExecutionOptions): Promise<MediaResult<T>>;
  metadata(execution?: ExecutionOptions): Promise<MediaMetadata>;
}
export interface CapabilityIssue { code: string; message: string; operation?: OperationName }
export type SupportResult =
  | { status: "supported" }
  | { status: "unsupported" | "unknown"; issues: readonly CapabilityIssue[] };
export interface EngineCapabilities {
  engineId: string;
  engineVersion: string;
  runtime: Runtime;
  operations: readonly OperationName[];
  inputKinds: readonly MediaInput["kind"][];
  outputKinds: readonly OutputTarget["kind"][];
  readableContainers: readonly string[];
  decoders: readonly string[];
  encodings: readonly { container: MediaFormat; videoCodec?: string; audioCodec?: string; preset: PresetId }[];
  limits: { maxInputBytes?: number; maxWidth?: number; maxHeight?: number };
}
export type TerminalOperation =
  | { type: "export"; format: MediaFormat; preset: PresetId }
  | { type: "thumbnail"; at: number; format: "jpeg" | "png"; preset: PresetId };
/** Core resolves defaults, relative paths, presets and plan conflicts first. */
export interface ProcessingPlan {
  input: MediaInput;
  transformations: readonly Transformation[];
  terminal: TerminalOperation;
  output: OutputTarget;
}
export interface EngineContext {
  jobId: string;
  signal: AbortSignal;
  reportProgress: (event: { stage: "preparing" | "running" | "finalizing"; percent?: number }) => void;
}
export interface ExecutionEngineContext extends EngineContext {
  /** Call once before publication. False denies publication; true defers later aborts. */
  beginCommit(): boolean;
}
/** Owned by one client. Calls are serialized; cancellation uses context.signal and the commit gate. */
export interface EngineAdapter {
  readonly id: string;
  readonly runtime: Runtime;
  initialize(context: EngineContext): Promise<void>;
  capabilities(): Promise<EngineCapabilities>;
  probe(input: MediaInput, context: EngineContext): Promise<MediaMetadata>;
  supports(plan: ProcessingPlan, source: MediaMetadata): Promise<SupportResult>;
  execute(plan: ProcessingPlan, context: ExecutionEngineContext): Promise<{ output: MediaOutput; metadata: MediaMetadata; warnings?: readonly CleanupWarning[] }>;
  dispose(): Promise<void>;
}
export interface NativeEngineOptions {
  /** Absolute binary path. Omit to discover the tool on the captured PATH. */
  ffmpegPath?: string;
  ffprobePath?: string;
}
export interface BrowserEngineOptions {
  /** Application-hosted same-origin JS/WASM assets; no automatic CDN. */
  assets: {
    coreURL: string;
    wasmURL: string;
    /** Optional wrapper module worker URL, not the multithread core worker. */
    classWorkerURL?: string;
  };
}
export interface MavioOptions {
  /** Positive finite integer; one complete initialization attempt; default 30000. */
  initTimeoutMs?: number;
  /** Default engine configuration only; invalid with an explicit adapter. */
  native?: NativeEngineOptions;
  browser?: BrowserEngineOptions;
  engine?: "auto" | EngineAdapter;
  maxQueuedJobs?: number;
}
export interface MavioClient {
  from(input: MediaInput): Pipeline;
  capabilities(execution?: ExecutionOptions): Promise<EngineCapabilities>;
  dispose(): Promise<void>;
}
export declare function createMavio(options?: MavioOptions): MavioClient;

// Blob and AbortSignal use standard platform declarations in this draft.
// M1 must prove Node consumer declarations without requiring DOM library types,
// using runtime-specific type entry points or minimal structural platform types.
// Broad unions deliberately require runtime validation of codec/plan combinations.
