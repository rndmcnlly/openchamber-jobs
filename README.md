# openchamber-jobs

A jobs panel for OpenChamber 2.x. See the shell commands of a conversation and its recursive subagents: live output, elapsed time, outcome, and which subagent owns each one. Stop background jobs without leaving the agent guessing why its process stopped.

Everything goes through OpenChamber's `shells` extension capability. The panel never connects to OpenCode itself: no local service, no backend discovery, no saved credentials, and no reconnect step after OpenChamber or OpenCode restarts.

[opencode-monitor](https://github.com/rndmcnlly/opencode-monitor) independently supplies incremental output notifications to the agent. The packages have synergy, but each is useful on its own: human-facing job visibility here, agent-facing live notifications there.

<a href="./demo/openchamber-background-jobs.png"><img src="./demo/openchamber-background-jobs.png" alt="Jobs panel showing live output alongside a completed job" width="500"></a>

*Historical screenshot from the former companion panel. Representative of the experience; the current panel is named Jobs.*

## Install

Requires OpenChamber 2.2.0 or newer, the first release with ended shells in the `shells` capability.

### Release ZIP

When a release is available, download `openchamber-jobs.zip` from [GitHub Releases](https://github.com/rndmcnlly/openchamber-jobs/releases). In **Settings → Extensions → Add**, select its absolute local path or paste the HTTPS URL of the release asset. Approve the requested access, then open **Jobs** on the right-hand rail. The ZIP contains everything needed to run: no npm install or build on the user's machine.

The [source repository](https://github.com/rndmcnlly/openchamber-jobs) is public; no version tag or release has been published yet. GitHub Actions builds and tests the package on pushes and pull requests; pushing a version tag such as `v0.1.0` publishes the ZIP and `SHA256SUMS` to a release. The tag must match `package.json`.

OpenChamber's Git-version update detection does not apply to ZIP installs. Install a newer ZIP to upgrade, accepting replacement of the existing extension if prompted. Do not install the source repository URL: generated bundles intentionally are not committed.

### Local checkout

Requires Node 22.18+ and npm. From this directory:

```sh
npm ci
npm run check
npm run package
npm test
```

In **Settings → Extensions → Add**, select the absolute path of this repository root. A folder install uses the checkout directly. Rebuild after source changes and reload the panel.

## Access

The panel asks for two capabilities, approved once at install:

- `shells`: running shell commands of the open conversation and its subagents, the ones that ended, their output, and Stop.
- `sessions`: session titles, used only to label subagent jobs and count the conversation's sessions.

The extension's ID is `openchamber-jobs`, distinct from the former companion's `opencode-monitor`. Earlier versions of Jobs ran a local service with a `ps` permission and wrote `~/.config/openchamber-jobs/connection.json`; neither is used anymore, and that file can be deleted.

## Behavior and limits

- OpenChamber reports the commands running now and the ones it saw end since it loaded, with exit code, timeout, signal, or Stop. The panel remembers background jobs per conversation in extension storage (the newest 100), so finished jobs survive panel and app reloads.
- A job remembered as running that OpenChamber neither sees running nor saw end shows **Record unavailable**: it ended while OpenChamber was not watching. The panel never invents a success or a duration.
- Foreground commands occupy a separate, hideable zone while running. They disappear after completion and cannot be stopped here: their owning agent is waiting for the tool result.
- Cards preserve output views and text selection using keyed DOM updates. Collapse preferences are stored per conversation. Auto-collapse folds jobs when they finish; pin a job to keep it expanded.
- Stop uses the same path as OpenChamber's own Stop button. The agent first gets a note that the user stopped the command, then OpenCode removes it. OpenCode deletes a stopped command's output; output already displayed stays until the panel reloads.
- OpenCode keeps an ended command's output for its latest 25 ended commands per directory. Older output shows as no longer kept.
- Only expanded cards read output: the last 64 KiB first, then new output every two seconds, keeping the most recent 256 Ki characters. Live output combines stdout/stderr.
- Missing approval, an empty conversation, and an open conversation with no jobs each show a distinct message.
- No process execution is implemented here. OpenCode remains the process owner; the extension is a read model and an explicit Stop.

## Development and release

```sh
npm ci
npm run check
npm run package
npm test
```

`npm run package` builds and creates `dist/openchamber-jobs.zip` plus its SHA-256 checksum. Tests cover the job model, the local manifest, and the extracted package. TypeScript is authored source; JavaScript bundles and ZIPs are gitignored. The packaging whitelist excludes source, tests, and development dependencies.

## Lineage

Extracted from the optional OpenChamber panel in [opencode-monitor](https://github.com/rndmcnlly/opencode-monitor), itself adapted from [opencode-perk](https://github.com/rndmcnlly/opencode-perk)'s V1 cards. Bohdan Triapitsyn's [installation PR](https://github.com/rndmcnlly/opencode-monitor/pull/5) identified the root-manifest and ready-to-run-file requirements and contributed the SDK manifest-testing approach. This package satisfies that contract through release ZIPs rather than checked-in bundles.

Sources: [OpenChamber SDK](https://github.com/openchamber/openchamber/tree/main/packages/sdk), [host API](https://github.com/openchamber/openchamber/blob/main/packages/sdk/API.md).
