import type { NativeInventory } from "./inventory.js";
import { buildNativeMp4Encoding } from "./mp4-encoding.js";

export function buildBalancedMp4Encoding(
  inventory: NativeInventory,
  hasAudio: boolean,
): readonly string[] {
  return buildNativeMp4Encoding("video-balanced-v1", inventory, hasAudio);
}
