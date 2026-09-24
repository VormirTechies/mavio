import { createMavio, type PresetId } from "./contracts";
const pcm: PresetId = "audio-pcm-v1";
createMavio().from({kind:"path",path:"input.mp4"}).extractAudio().convert({format:"wav",preset:pcm}).export({output:{kind:"path",path:"output.wav"}});
