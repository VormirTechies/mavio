# M5 metadata behavior

## Public operation

Call metadata() on an untransformed pipeline to inspect the source.
Preceding transformations are rejected; metadata() does not describe a
hypothetical converted or resized result.

Native accepts supported path and byte inputs. Browser accepts supported byte
and Blob inputs, including File values supplied as Blobs. Browser filesystem
paths are rejected. Readable media depends on the selected engine build.

## Field mapping

Both engines use the shared FFprobe metadata mapper.

| Public field           | FFprobe field                       | Behavior                                        |
| ---------------------- | ----------------------------------- | ----------------------------------------------- |
| durationSeconds        | format.duration                     | Finite nonnegative seconds; zero is retained    |
| sizeBytes              | format.size                         | Nonnegative safe integer; zero is retained      |
| container              | format.format_name                  | Nonblank string; alias lists are retained       |
| bitrateBitsPerSecond   | format.bit_rate                     | Finite nonnegative number                       |
| streams                | streams                             | Original stream order is retained               |
| stream.index           | index                               | Unique nonnegative safe integer JSON number     |
| stream.kind            | codec_type                          | video, audio, subtitle, or other                |
| stream.codec           | codec_name                          | Nonblank string when available                  |
| stream.width / height  | width / height                      | Positive safe integers for video                |
| stream.frameRate       | avg_frame_rate                      | Positive safe-integer numerator and denominator |
| stream.sampleRate      | sample_rate                         | Positive safe integer for audio                 |
| stream.channels        | channels                            | Positive safe integer for audio                 |
| stream.rotationDegrees | display matrix or legacy rotate tag | Normalized clockwise rotation when unambiguous  |

## Unknown values

Unavailable or invalid optional values remain undefined.
The contract does not promise that unknown properties are absent as own keys.
JSON serialization omits properties whose values are undefined.

Unknown values are not replaced with zero or invented estimates.
Container duration is not inferred from stream duration.
Unknown average frame rate does not fall back to nominal frame rate.
Zero dimensions are unknown, while known zero duration and size are retained.

A container string may contain FFprobe aliases such as
mov,mp4,m4a,3gp,3g2,mj2. It is not a canonical export-format identifier.

## Rotation

A valid display matrix takes precedence over a legacy rotate tag.
Display-matrix rotation is converted to the clockwise convention and normalized
to the range from zero inclusive to 360 exclusive.

Malformed or ambiguous display-matrix data remains unknown without falling
back to a possibly stale tag. Rotation metadata does not swap stored width
and height or imply that Mavio has transformed the source.

## Results and failures

Each metadata request returns an independent result snapshot.
Nested output from one request must not change another request's result.
This does not promise that every returned object is frozen.

The public schema excludes arbitrary source tags.
Malformed probe responses use structured errors with bounded context.
The parser avoids exposing malformed source JSON through parser messages.

The Browser wrapper requires a format object and nonempty stream list.
For the pinned core, exit code -1 is accepted only alongside valid structured
output; other unsuccessful exit codes are rejected. A valid structured
Browser media error maps to INVALID_MEDIA.

The shared/native parser can parse a response without a format object or
with an empty stream list. These parser boundaries do not promise that such
media succeeds through the public native adapter. Native process handling
and public validation remain separate layers.

## Evidence

Nine tests in metadata-parity.test.mjs passed locally and are registered
in the package test command. They exercise Native parsing and Browser parsing
with exit codes zero and -1 for valid responses.

Coverage includes field mapping, unknown values, known zeros, stream order,
rotation, private-field exclusion, independent nested results, malformed JSON,
invalid/duplicate indexes, and explicit Browser response-shape requirements.

Existing metadata-client, browser-metadata-client, composition, and terminal
tests cover public lifecycle and source-only behavior. Previously completed
native and installed-package Browser acceptance checks exercised real probing.

No production parser change was required for M5-01.
