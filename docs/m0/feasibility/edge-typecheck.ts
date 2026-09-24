import {type EngineContext,type ExecutionEngineContext,type MediaResult} from "./contracts";
declare const context: ExecutionEngineContext;
const mayPublish: boolean = context.beginCommit();
declare const base: EngineContext;
// @ts-expect-error Base context cannot authorize publication.
base.beginCommit();
declare const result: MediaResult<{kind:"bytes"}>;
const bytes: Uint8Array = result.output.bytes;
const warningCode: "CLEANUP_FAILED" | undefined = result.warnings?.[0]?.code;
// @ts-expect-error Warning collection is readonly.
result.warnings?.push({code:"CLEANUP_FAILED",message:"cleanup"});
void mayPublish; void bytes; void warningCode;
