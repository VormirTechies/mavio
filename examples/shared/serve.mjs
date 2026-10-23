import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = await realpath(resolve("public"));
const port = Number(process.argv[2] ?? process.env.PORT ?? "4173");

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Port must be an integer from 0 through 65535.");
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cache-Control", "no-store");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = await realpath(resolve(root, "." + requested));

    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = createReadStream(file);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.info("MAVIO_EXAMPLE_URL=http://127.0.0.1:" + server.address().port);
});

function close() {
  server.close();
  server.closeAllConnections();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
