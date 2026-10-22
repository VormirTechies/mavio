import type { BrowserEngineOptions } from "../../contracts.js";
import { createMavioError } from "../../core/errors.js";

interface BrowserEnvironment {
  baseURL: string;
  pageURL: string;
}

export interface BrowserConfiguration {
  readonly coreURL: string;
  readonly wasmURL: string;
  readonly classWorkerURL?: string;
}

function captureEnvironment(): BrowserEnvironment {
  if (typeof document === "undefined" || typeof location === "undefined") {
    throw createMavioError(
      "UNSUPPORTED_RUNTIME",
      "Browser initialization requires a document environment.",
    );
  }

  return {
    baseURL: document.baseURI,
    pageURL: location.href,
  };
}

export function captureBrowserConfiguration(
  options: BrowserEngineOptions,
  environment?: BrowserEnvironment,
): BrowserConfiguration {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw createMavioError("INVALID_OPTIONS", "Browser engine options must be an object.");
  }

  const assets = options.assets;

  if (assets === null || typeof assets !== "object" || Array.isArray(assets)) {
    throw createMavioError("INVALID_OPTIONS", "Browser engine assets are required.");
  }

  const captured = environment ?? captureEnvironment();

  let page: URL;
  let base: URL;

  try {
    page = new URL(captured.pageURL);
    base = new URL(captured.baseURL);
  } catch (cause) {
    throw createMavioError(
      "UNSUPPORTED_RUNTIME",
      "The browser environment contains an invalid URL.",
      { cause },
    );
  }

  if (
    !["http:", "https:"].includes(page.protocol) ||
    !["http:", "https:"].includes(base.protocol)
  ) {
    throw createMavioError(
      "UNSUPPORTED_RUNTIME",
      "Browser engine assets require an HTTP or HTTPS document.",
    );
  }

  function resolveAsset(value: unknown, field: string): string {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value !== value.trim() ||
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      throw createMavioError(
        "INVALID_OPTIONS",
        `${field} must be a non-empty asset URL without control characters.`,
        { details: { reason: "INVALID_BROWSER_ASSET_URL", field } },
      );
    }

    let url: URL;

    try {
      url = new URL(value, base);
    } catch (cause) {
      throw createMavioError("INVALID_OPTIONS", `${field} is not a valid asset URL.`, {
        cause,
        details: { reason: "INVALID_BROWSER_ASSET_URL", field },
      });
    }

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== page.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw createMavioError(
        "INVALID_OPTIONS",
        `${field} must be a same-origin HTTP(S) URL without credentials or a fragment.`,
        { details: { reason: "INVALID_BROWSER_ASSET_URL", field } },
      );
    }

    return url.href;
  }

  const coreURL = resolveAsset(assets.coreURL, "coreURL");
  const wasmURL = resolveAsset(assets.wasmURL, "wasmURL");
  const classWorkerURL =
    assets.classWorkerURL === undefined
      ? undefined
      : resolveAsset(assets.classWorkerURL, "classWorkerURL");

  return Object.freeze({
    coreURL,
    wasmURL,
    ...(classWorkerURL === undefined ? {} : { classWorkerURL }),
  });
}
