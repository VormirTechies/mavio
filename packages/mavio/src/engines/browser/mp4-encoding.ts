import { buildMp4Encoding, type Mp4Preset } from "../shared/mp4-encoding.js";
import type { BrowserInventory } from "./inventory.js";

export type BrowserMp4Preset = Mp4Preset;

export function buildBrowserMp4Encoding(
  preset: BrowserMp4Preset,
  inventory: BrowserInventory,
  hasAudio: boolean,
): readonly string[] {
  const encoding = buildMp4Encoding(preset, inventory, hasAudio);

  return Object.freeze([...encoding, "-threads:v", "1", ...(hasAudio ? ["-threads:a", "1"] : [])]);
}
