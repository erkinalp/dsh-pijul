# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-25

First public release. 0.1.0 was never published; it is kept only as a version
number, because it could not have worked — see "Fixed" below.

### Fixed

- **Every tool failed with `ctx.shell.run is not a function`.** The DeepSeek
  Harness shell seam is `ctx.shell.resolve(request)` → `ctx.shell.execute(spec)`
  → `await handle.result()`; there is no `run()`. All sixteen tools now use the
  real seam, and the unit suite builds the plugin against a stub that exposes
  exactly that surface so the mistake cannot come back.
- **Commands ran in the harness process's directory, not the session's.**
  Nothing filled `workdir`, so `repo`-less calls used the executor default. The
  plugin now resolves the caller's session directory through
  `ctx.workingDirectory.ensure(agent, signal)`, matching `tool-bash`, and keeps
  the executor default when the profile has no such service.
- **`pijul_record` with explicit `paths` blocked until the shell timeout.**
  pijul opens the commit-message editor for `record <paths> -m <msg>` even though
  `-m` was supplied (verified in every flag order against `1.0.0-beta.21`). The
  command preamble now exports `EDITOR`/`VISUAL` as the no-op `true`, so pijul
  accepts the message it already wrote.
- **`pijul_push`/`pijul_pull` with `all: false` blocked the same way.** They open
  the editor to select changes; the same no-op editor covers them.
- **Paging values were interpolated into the command unquoted.** `limit` and
  `offset` went through `String()` bare, so a non-integer value from a model was
  shell syntax. Both are now single-quoted; a test proves an injected `touch`
  cannot run.

### Added

- `pijul_add` gained `recursive`, because `pijul add .` records only the
  directory and silently leaves its contents untracked.
- `aborted` is part of the canonical output, and a run killed by the caller's
  signal is no longer reported as a plain failure.
- Network operations (`clone`, `push`, `pull`) declare a 10-minute tool budget
  instead of the executor default.
- Test suite (`node --test`, zero dependencies): 34 unit tests covering
  registration, argv construction, quoting and injection, workdir resolution,
  sandbox/DSH-env forwarding and failure rendering, plus integration tests that
  drive the real pijul CLI end to end.
- CI workflow, changelog, `.gitignore`, and a runnable `npm test`.

### Documentation

- README rewritten to match measured behaviour: `pijul init` inside an existing
  repository is an error, not a no-op; directory adds need `recursive`; both
  editor-opening cases are documented with the remedy.
- The npm install line and the placeholder dsh-plugin.org badge were removed;
  installation is documented from GitHub, a local checkout or a tarball.

## [0.1.0] — unpublished

Initial sketch: sixteen tools, sandboxed shell execution, SSH-agent defaulting,
and a system-prompt section. Broken by the shell-seam mistake described above.
