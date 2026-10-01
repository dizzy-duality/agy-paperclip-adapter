# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-10-01

### Fixed

- **Stop now stops agy.** The adapter opts in to Paperclip's signal-based
  cancellation (`onCancellationReady` / `ctx.signal`), terminates agy's whole
  process group on Stop (SIGTERM, then SIGKILL after `graceSec`), and returns
  the `executionCancellation: acknowledged` result the server requires. Before,
  the server could not reach the agy child (it lives in the adapter's own copy
  of adapter-utils), so a stopped run kept editing until its print timeout.
- Login, quota, network and lost-conversation errors are only matched against
  agy's own diagnostics (stderr, the result event's error field, and stdout
  lines that are not stream-json events), never against model or tool text.
- A failed run with an empty stderr now gets an error message instead of none.

### Changed

- Built against `@paperclipai/adapter-utils` 2026.916.1; removed `modelProfiles`,
  which that version no longer has.
- A resume that agy cannot honour is reported. agy 1.2.14 does not fail on an
  unknown `--conversation` id: it warns on stderr, starts a new conversation
  and exits 0 with SUCCESS. The adapter now logs this and records
  `resultJson.conversationReset`; the new conversation id is kept.

### Added

- `execute()` tests against a fake agy replaying output captured from agy 1.2.14.

## [0.2.1] - 2026-09-10

### Added

- Skill delivery on the heartbeat path (`execute()`), not only through an explicit
  `syncSkills()` call, so skills are present from the first turn of a run.
- A skill-sync receipt logged on every run for troubleshooting.

### Changed

- Verified skill sync against a real Paperclip company skill (created through
  `POST /api/companies/{id}/skills`) rather than only synthetic fixtures.
- `DESIGN.md` now points at the filed upstream issue instead of the removed draft
  proposal.
- `--effort` is suppressed when the selected model id already encodes a reasoning
  tier, avoiding a redundant/conflicting CLI flag.

## [0.2.0] - 2026-09-10

### Added

- `listSkills()` / `syncSkills()` implemented against agy's real skill loader,
  including skill root discovery across candidate roots and symlink resolution.

## [0.1.0] - 2026-09-10

### Added

- Initial release: Paperclip external adapter for `agy` (the Antigravity CLI),
  registering the `agy_local` adapter type as a replacement lane for the
  deprecated `gemini_local` adapter.
- Heartbeat prompts, conversation resume across wakes, live tool-call rendering,
  token accounting, and "Test Connection" support.
- Workspace binding, session resume with stale-session rejection, and an
  environment probe for verifying `agy` is installed and authenticated.

[0.2.1]: https://github.com/evgemar/agy-paperclip-adapter/releases/tag/v0.2.1
[0.2.0]: https://github.com/evgemar/agy-paperclip-adapter/releases/tag/v0.2.0
[0.1.0]: https://github.com/evgemar/agy-paperclip-adapter/commit/f10400b4f84225bb458aae55f0b499e2512a85a5
