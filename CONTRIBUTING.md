# Contributing to Mavio

## Development setup

Use Node.js 22 or 24 and npm. From the repository root, install the locked dependencies:

```sh
npm ci
```

Install the browser used by package verification:

```sh
npx playwright install --with-deps chromium --only-shell
```

If browser downloads are unavailable and Google Chrome is already installed, select it in PowerShell:

```powershell
$env:MAVIO_BROWSER_CHANNEL = "chrome"
```

## Before submitting changes

Format files, then run all checks:

```sh
npm run format
npm run check
```

The checks cover linting, formatting, compilation, browser and Node type compatibility, public exports, packaged imports, browser bundling, and a Chromium runtime smoke test.

Review your diff before committing. Include `package-lock.json` whenever dependencies change. GitHub Actions must pass on Windows and Linux with Node 22 and 24.

## Project conventions

- Keep shared SDK code independent of browser-specific and Node-specific engines.
- Use LF line endings, as configured in `.gitattributes`.
- Keep generated build output, dependencies, and temporary package archives out of commits.
- Explain the reason for each `@ts-expect-error` assertion.
- Validate proposed API changes against the approved contracts in `docs/m0` and update relevant documentation and tests together.
- Describe the behavior changed and how it was verified in each pull request.

## Current scope

The M1 package provides the SDK foundation, public types, and package entry points. Its current smoke tests verify packaging and loading; they do not demonstrate working media operations.
