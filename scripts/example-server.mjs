import { spawn } from "node:child_process";
import { join } from "node:path";

export async function startExampleServer(examplesDirectory, name) {
  const child = spawn(process.execPath, [join(examplesDirectory, "shared/serve.mjs"), "0"], {
    cwd: join(examplesDirectory, name),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const closed = new Promise((accept) => child.once("close", accept));
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk.toString()).slice(-16000);
  });

  try {
    const origin = await new Promise((accept, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Example server startup timed out.")),
        30_000,
      );

      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-16000);
        const match = output.match(/MAVIO_EXAMPLE_URL=(http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          accept(match[1]);
        }
      });

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Example server exited: " + errors));
      });
    });

    return { origin, child, closed };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    throw error;
  }
}

export async function stopExampleServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill();
  }

  let timer;
  try {
    await Promise.race([
      server.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Example server did not close.")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
