# Media test fixtures

This directory holds small, reproducible media samples for engine and operation tests.

## Current status

The fixture collection is not populated yet. M1 package checks do not depend on media fixtures.

## Planned coverage

- Short video with audio: metadata, trimming, and conversion.
- Video without audio: missing-audio behavior.
- Audio-only sample: extraction and audio conversion.
- Portrait video with rotation metadata: orientation handling.
- Empty and malformed files: input validation and error handling.

Add each sample when its corresponding engine or operation test is introduced.

## Requirements

- Prefer synthetic media generated specifically for testing.
- Keep samples under 1 MB where practical.
- Record the generation command, tool version, file size, and SHA-256 checksum.
- Record expected container, codecs, duration, dimensions, and audio properties where applicable.
- Document permitted numerical tolerances in the consuming test.
- For externally sourced samples, include their source and redistribution license.
- Never include personal or confidential recordings.

## Test behavior

Tests must preserve fixture files and write outputs to temporary directories. Clean up temporary outputs after each test.

Ordinary tests must use local fixtures without downloading media. Browser and Node engine tests should share samples wherever their supported formats overlap.
