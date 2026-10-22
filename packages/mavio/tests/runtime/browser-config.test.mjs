import assert from "node:assert/strict";
import test from "node:test";
import { captureBrowserConfiguration } from "../../dist/engines/browser/config.js";

const environment = {
  pageURL: "https://mavio.example/playground/index.html",
  baseURL: "https://mavio.example/app/",
};

function options() {
  return {
    assets: {
      coreURL: "./engine/ffmpeg-core.js",
      wasmURL: "./engine/ffmpeg-core.wasm",
    },
  };
}

test("browser assets resolve against the captured document base", () => {
  const configuration = captureBrowserConfiguration(options(), environment);

  assert.deepEqual(configuration, {
    coreURL: "https://mavio.example/app/engine/ffmpeg-core.js",
    wasmURL: "https://mavio.example/app/engine/ffmpeg-core.wasm",
  });
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal("classWorkerURL" in configuration, false);
});

test("browser assets preserve explicit worker URLs and query strings", () => {
  const configuration = captureBrowserConfiguration(
    {
      assets: {
        coreURL: "/engine/core.js?v=0.12.10",
        wasmURL: "/engine/core.wasm?v=0.12.10",
        classWorkerURL: "/wrapper/worker.js?v=0.12.15",
      },
    },
    environment,
  );

  assert.equal(configuration.coreURL, "https://mavio.example/engine/core.js?v=0.12.10");
  assert.equal(configuration.wasmURL, "https://mavio.example/engine/core.wasm?v=0.12.10");
  assert.equal(configuration.classWorkerURL, "https://mavio.example/wrapper/worker.js?v=0.12.15");
});

test("browser configuration is independent of later caller mutations", () => {
  const supplied = options();
  const suppliedEnvironment = { ...environment };

  const configuration = captureBrowserConfiguration(supplied, suppliedEnvironment);

  supplied.assets.coreURL = "/changed.js";
  supplied.assets.wasmURL = "/changed.wasm";
  suppliedEnvironment.baseURL = "https://other.example/";

  assert.equal(configuration.coreURL, "https://mavio.example/app/engine/ffmpeg-core.js");
  assert.equal(configuration.wasmURL, "https://mavio.example/app/engine/ffmpeg-core.wasm");
});

test("browser configuration rejects missing or malformed asset objects", () => {
  for (const value of [
    undefined,
    null,
    [],
    42,
    {},
    { assets: null },
    { assets: [] },
    { assets: {} },
  ]) {
    assert.throws(() => captureBrowserConfiguration(value, environment), {
      code: "INVALID_OPTIONS",
      stage: "queued",
    });
  }
});

test("browser configuration validates every supplied asset URL", () => {
  const invalidValues = [
    null,
    42,
    "",
    " ",
    " /engine/core.js",
    "/engine/core.js\n",
    "/engine/\0core.js",
    "https://other.example/core.js",
    "//other.example/core.js",
    "http://mavio.example/core.js",
    "https://mavio.example:444/core.js",
    "https://user:password@mavio.example/core.js",
    "blob:https://mavio.example/asset",
    "data:text/javascript,export default 1",
    "file:///engine/core.js",
    "/engine/core.js#fragment",
  ];

  for (const field of ["coreURL", "wasmURL", "classWorkerURL"]) {
    for (const value of invalidValues) {
      const supplied = options();
      supplied.assets[field] = value;

      assert.throws(() => captureBrowserConfiguration(supplied, environment), {
        code: "INVALID_OPTIONS",
        details: {
          reason: "INVALID_BROWSER_ASSET_URL",
          field,
        },
      });
    }
  }
});

test("a cross-origin document base cannot authorize cross-origin assets", () => {
  const changedBase = {
    ...environment,
    baseURL: "https://cdn.example/assets/",
  };

  assert.throws(() => captureBrowserConfiguration(options(), changedBase), {
    code: "INVALID_OPTIONS",
  });

  const configuration = captureBrowserConfiguration(
    {
      assets: {
        coreURL: "https://mavio.example/engine/core.js",
        wasmURL: "https://mavio.example/engine/core.wasm",
      },
    },
    changedBase,
  );

  assert.equal(configuration.coreURL, "https://mavio.example/engine/core.js");
});

test("browser configuration rejects unsupported document environments", () => {
  for (const suppliedEnvironment of [
    { pageURL: "invalid", baseURL: environment.baseURL },
    { pageURL: environment.pageURL, baseURL: "invalid" },
    { pageURL: "file:///app/index.html", baseURL: "file:///app/" },
    { pageURL: "about:blank", baseURL: environment.baseURL },
  ]) {
    assert.throws(() => captureBrowserConfiguration(options(), suppliedEnvironment), {
      code: "UNSUPPORTED_RUNTIME",
    });
  }
});

test("browser configuration supports HTTP localhost hosting", () => {
  const configuration = captureBrowserConfiguration(options(), {
    pageURL: "http://127.0.0.1:8080/index.html",
    baseURL: "http://127.0.0.1:8080/",
  });

  assert.equal(configuration.wasmURL, "http://127.0.0.1:8080/engine/ffmpeg-core.wasm");
});
