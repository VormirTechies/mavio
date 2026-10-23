import assert from "node:assert/strict";

export function instrumentResourceWorker(source) {
  const marker = "self.onmessage = async ({ data: { id, type, data: _data }, }) => {";
  assert.equal(source.split(marker).length, 2, "Pinned worker handler did not match.");

  const probe = [
    '    if (type === "MAVIO_RESOURCE_SNAPSHOT") {',
    "        try {",
    "            if (!ffmpeg) throw ERROR_NOT_LOADED;",
    '            const directories = ffmpeg.FS.readdir("/").filter(name => name.startsWith("mavio-"));',
    "            let entries = 0;",
    "            for (const name of directories) {",
    '                entries += ffmpeg.FS.readdir("/" + name).filter(entry => entry !== "." && entry !== "..").length;',
    "            }",
    "            self.postMessage({ id, type, data: {",
    "                wasmHeapBytes: ffmpeg.HEAPU8.byteLength,",
    "                workspaceDirectories: directories.length,",
    "                workspaceEntries: entries,",
    "            } });",
    "        } catch {",
    '            self.postMessage({ id, type, data: { probeError: "Resource snapshot failed." } });',
    "        }",
    "        return;",
    "    }",
  ].join("\n");

  return source.replace(marker, marker + "\n" + probe);
}

// Serialized into the test page using Playwright addInitScript.
export function installResourceObserver() {
  const OriginalWorker = globalThis.Worker;
  const probeType = "MAVIO_RESOURCE_SNAPSHOT";
  const workers = new Map();
  const state = {
    created: 0,
    terminated: 0,
    peakActive: 0,
    workspaceCreates: 0,
    workspaceDeletes: 0,
    workspaceDirectoriesDestroyedByTermination: 0,
    filesystemErrors: 0,
    dispatchedCancellations: 0,
    abortNextExec: undefined,
  };

  globalThis.Worker = class extends OriginalWorker {
    constructor(url, options) {
      super(url, options);

      const record = {
        id: ++state.created,
        active: true,
        directories: 0,
        nextProbe: -1,
        filesystem: new Map(),
        probes: new Map(),
      };
      this.mavioResourceRecord = record;
      workers.set(record.id, this);
      state.peakActive = Math.max(state.peakActive, workers.size);

      this.addEventListener("message", (event) => {
        const reply = event.data;
        if (!reply || typeof reply !== "object") return;

        if (reply.type === probeType) {
          // Keep test-only replies out of the SDK wrapper's message handler.
          event.stopImmediatePropagation();
          const pending = record.probes.get(reply.id);
          if (!pending) return;

          record.probes.delete(reply.id);
          clearTimeout(pending.timer);
          if (reply.data?.probeError) {
            pending.reject(new Error(reply.data.probeError));
          } else {
            pending.resolve(reply.data);
          }
          return;
        }

        const operation = record.filesystem.get(reply.id);
        if (!operation) return;
        record.filesystem.delete(reply.id);

        if (reply.type === operation && reply.data === true) {
          if (operation === "CREATE_DIR") {
            state.workspaceCreates++;
            record.directories++;
          } else {
            state.workspaceDeletes++;
            record.directories--;
          }
        } else if (reply.type === "ERROR") {
          state.filesystemErrors++;
        }
      });
    }

    postMessage(message, transferOrOptions) {
      const record = this.mavioResourceRecord;
      const tracked =
        message &&
        ["CREATE_DIR", "DELETE_DIR"].includes(message.type) &&
        typeof message.data?.path === "string" &&
        message.data.path.startsWith("/mavio-");

      if (tracked) record.filesystem.set(message.id, message.type);

      try {
        super.postMessage(message, transferOrOptions);
      } catch (error) {
        if (tracked) record.filesystem.delete(message.id);
        throw error;
      }

      if (message?.type === "EXEC" && typeof state.abortNextExec === "function") {
        const abort = state.abortNextExec;
        state.abortNextExec = undefined;
        state.dispatchedCancellations++;
        queueMicrotask(abort);
      }
    }

    resourceSnapshot() {
      const record = this.mavioResourceRecord;
      if (!record.active) {
        return Promise.reject(new Error("Cannot probe a terminated worker."));
      }

      return new Promise((resolve, reject) => {
        const id = record.nextProbe--;
        const timer = setTimeout(() => {
          record.probes.delete(id);
          reject(new Error("Worker resource snapshot timed out."));
        }, 10_000);

        record.probes.set(id, { resolve, reject, timer });

        try {
          super.postMessage({ id, type: probeType, data: {} });
        } catch (error) {
          clearTimeout(timer);
          record.probes.delete(id);
          reject(error);
        }
      });
    }

    terminate() {
      const record = this.mavioResourceRecord;
      if (record.active) {
        record.active = false;
        state.terminated++;
        state.workspaceDirectoriesDestroyedByTermination += record.directories;
        workers.delete(record.id);

        for (const pending of record.probes.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Worker terminated during resource snapshot."));
        }

        record.probes.clear();
        record.filesystem.clear();
      }

      return super.terminate();
    }
  };

  globalThis.__mavioResourceObserver = {
    cancelNextExec(callback) {
      if (typeof callback !== "function") {
        throw new Error("Cancellation callback must be a function.");
      }
      state.abortNextExec = callback;
    },

    clearExecCancellation() {
      state.abortNextExec = undefined;
    },

    async snapshot() {
      const instances = [...workers.values()];
      const measurements = await Promise.all(instances.map((worker) => worker.resourceSnapshot()));

      return {
        workersCreated: state.created,
        workersTerminated: state.terminated,
        activeWorkers: workers.size,
        peakActiveWorkers: state.peakActive,
        wasmHeapBytes: measurements.reduce((sum, item) => sum + item.wasmHeapBytes, 0),
        workspaceDirectories: measurements.reduce(
          (sum, item) => sum + item.workspaceDirectories,
          0,
        ),
        workspaceEntries: measurements.reduce((sum, item) => sum + item.workspaceEntries, 0),
        pendingFilesystemRequests: instances.reduce(
          (sum, worker) => sum + worker.mavioResourceRecord.filesystem.size,
          0,
        ),
        trackedWorkspaceDirectories: instances.reduce(
          (sum, worker) => sum + worker.mavioResourceRecord.directories,
          0,
        ),
        workspaceCreates: state.workspaceCreates,
        workspaceDeletes: state.workspaceDeletes,
        workspaceDirectoriesDestroyedByTermination:
          state.workspaceDirectoriesDestroyedByTermination,
        filesystemErrors: state.filesystemErrors,
        dispatchedCancellations: state.dispatchedCancellations,
      };
    },
  };
}
