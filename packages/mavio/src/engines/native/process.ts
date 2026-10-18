import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { createMavioError } from "../../core/errors.js";

type ProcessFailure =
  "SPAWN_FAILED" | "NONZERO_EXIT" | "STREAM_ERROR" | "OUTPUT_LIMIT" | "CANCELLED";

export class NativeProcessError extends Error {
  readonly exitCode?: number | null;
  readonly terminationSignal?: NodeJS.Signals | null;
  terminationCause?: unknown;

  constructor(
    readonly reason: ProcessFailure,
    options: {
      cause?: unknown;
      exitCode?: number | null;
      terminationSignal?: NodeJS.Signals | null;
    } = {},
  ) {
    super(`Native process failed: ${reason}.`, { cause: options.cause });
    this.name = "NativeProcessError";
    this.exitCode = options.exitCode;
    this.terminationSignal = options.terminationSignal;
  }
}

interface ProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export async function runNativeProcess(
  options: ProcessOptions,
  launch: typeof spawn = spawn,
): Promise<ProcessResult> {
  const { executable, cwd, signal, maxOutputBytes = 1_048_576 } = options;

  if (signal.aborted) {
    throw new NativeProcessError("CANCELLED", { cause: signal.reason });
  }

  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    executable.includes("\0") ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !Array.isArray(options.args) ||
    options.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw createMavioError("INVALID_OPTIONS", "Invalid native process options.");
  }

  const args = [...options.args];

  return new Promise<ProcessResult>((resolve, reject) => {
    let child: ChildProcess;

    try {
      child = launch(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      reject(new NativeProcessError("SPAWN_FAILED", { cause }));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: NativeProcessError | undefined;
    let stopping = false;
    let exited = false;
    let closed = false;

    function stop(error: NativeProcessError): void {
      failure ??= error;

      if (stopping || exited || closed || child.pid === undefined) return;
      stopping = true;

      try {
        child.kill("SIGKILL");
      } catch (cause) {
        if (failure !== undefined) failure.terminationCause = cause;
      }

      // Sending a signal is not proof of termination.
      // Settlement remains attached to the close event.
    }

    function onAbort(): void {
      if (closed || exited) return;
      stop(new NativeProcessError("CANCELLED", { cause: signal.reason }));
    }

    function collect(target: Buffer[], chunk: Buffer): void {
      if (closed || failure !== undefined) return;

      if (chunk.byteLength > maxOutputBytes - outputBytes) {
        stop(new NativeProcessError("OUTPUT_LIMIT"));
        return;
      }

      outputBytes += chunk.byteLength;
      target.push(chunk);
    }

    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));

    child.stdout?.on("error", (cause) => {
      stop(new NativeProcessError("STREAM_ERROR", { cause }));
    });
    child.stderr?.on("error", (cause) => {
      stop(new NativeProcessError("STREAM_ERROR", { cause }));
    });

    child.on("error", (cause) => {
      if (stopping && failure !== undefined) {
        failure.terminationCause = cause;
      } else {
        stop(new NativeProcessError("SPAWN_FAILED", { cause }));
      }
    });

    child.once("exit", (exitCode, terminationSignal) => {
      exited = true;

      if (exitCode !== 0) {
        failure ??= new NativeProcessError("NONZERO_EXIT", {
          exitCode,
          terminationSignal,
        });
      }
    });

    child.once("close", (exitCode, terminationSignal) => {
      closed = true;
      signal.removeEventListener("abort", onAbort);

      if (failure !== undefined) {
        reject(failure);
        return;
      }

      if (exitCode !== 0) {
        reject(
          new NativeProcessError("NONZERO_EXIT", {
            exitCode,
            terminationSignal,
          }),
        );
        return;
      }

      resolve(
        Object.freeze({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
