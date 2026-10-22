import {
  parseFFprobeDetails,
  type ProbeDetails,
  type ProbeStreamDetails,
} from "../shared/probe-details.js";
import { parseBrowserProbeMetadata } from "./probe-metadata.js";

export type BrowserProbeDetails = ProbeDetails;
export type BrowserStreamDetails = ProbeStreamDetails;

export function parseBrowserProbeDetails(
  text: string,
  exitCode: number,
  jobId?: string,
): BrowserProbeDetails {
  // Enforce browser exit-code rules, explicit media errors, and the
  // required format/nonempty-stream response before reading details.
  parseBrowserProbeMetadata(text, exitCode, jobId);

  return parseFFprobeDetails(text, jobId);
}
