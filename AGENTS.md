# openchamber-jobs

Independent OpenChamber extension showing the shell commands of a conversation and its subagents. All data and control go through the host's `shells` capability (`onRunningShells`, `readShellOutput`, `stopShell`); session titles come from the `sessions` capability. Do not add a local service, backend discovery, or saved OpenCode credentials. OpenCode owns processes; do not invent a parallel executor.

## Checks and packaging

Use Node 22.18+:

```sh
npm ci
npm run check
npm run package
npm test
```

Tests include the built filesystem package and extracted release ZIP. Run packaging before tests. Generated panel/main.js and dist/ are ignored: never commit build artifacts. GitHub Actions runs the same gates, then publishes ZIP/checksum assets for version tags matching package.json.

The extension ID is openchamber-jobs so it can coexist with the legacy opencode-monitor companion. Remembered jobs live in extension storage under `jobs:<sessionID>`; parse them defensively, keep `unavailable` for jobs whose end was not observed, and never invent an outcome.

The initial extraction came from /Users/adam/Desktop/opencode-monitor at ed7b5b41edfbe74766df172eee8a005676d6a625. The public repository is https://github.com/rndmcnlly/openchamber-jobs. No version tag or release has been published yet.
