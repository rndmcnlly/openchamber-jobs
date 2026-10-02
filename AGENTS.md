# openchamber-jobs

Independent OpenChamber extension observing native OpenCode V2 shells. The monitor plugin is optional: recognize structured `monitor: true` input without importing or requiring it. OpenCode owns processes; do not invent a parallel executor.

## Checks and packaging

Use Node 22.18+:

```sh
npm ci
npm run check
npm run package
npm test
```

Tests include the built filesystem package and extracted release ZIP. Run packaging before tests. Generated panel/main.js, service/main.js, and dist/ are ignored: never commit build artifacts. GitHub Actions runs the same gates, then publishes ZIP/checksum assets for version tags matching package.json.

The extension ID is openchamber-jobs so it can coexist with the legacy opencode-monitor companion. Read old cancellation metadata and connection files for compatibility, but write new metadata/credentials under openchamber-jobs. Credentials must remain outside the package and browser frame. Preserve native ownership checks and truthful cancellation reporting.

The initial extraction came from /Users/adam/Desktop/opencode-monitor at ed7b5b41edfbe74766df172eee8a005676d6a625. The legacy extension was removed from that repository and uninstalled after live validation; Jobs remains installed from this checkout. Historical cancellation/connection compatibility is intentional. This repository is local and unpublished; publishing and the first Actions run remain separate steps.
