# dsh-pijul

Pijul distributed version control inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — inspect, record, channel, push and pull without leaving the chat.

[![CI](https://github.com/erkinalp/dsh-pijul/actions/workflows/ci.yml/badge.svg)](https://github.com/erkinalp/dsh-pijul/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What changes after installing

The agent gains sixteen tools that drive the `pijul` CLI through the harness `shell` service, under the calling session's standing sandbox policy and working directory:

| Tool | What it does |
| --- | --- |
| `pijul_status` | Working-copy state: current channel, unrecorded changes, untracked files |
| `pijul_log` | Recorded changes, newest first (`limit`, `offset`) |
| `pijul_diff` | Unrecorded changes as hunks, optionally limited to paths |
| `pijul_init` | Create a repository |
| `pijul_clone` | Clone from a URL, SSH target or local path |
| `pijul_add` | Start tracking paths (`recursive` to include directory contents) |
| `pijul_record` | Record a change with a message, non-interactively |
| `pijul_change` | Show one change by hash or unambiguous prefix |
| `pijul_unrecord` | Drop changes from the current channel — Pijul's undo |
| `pijul_reset` | Discard unrecorded working-copy changes |
| `pijul_push` | Push to a remote (`--all` by default) |
| `pijul_pull` | Pull from a remote (`--all` by default) |
| `pijul_remote` | List remotes, set the default, delete one |
| `pijul_channel` | List, create, switch, delete or fork channels |
| `pijul_apply` | Apply recorded changes to the current channel |
| `pijul_identity` | List the signing identities pijul knows about |

Every tool returns `{ ok, exitCode, timedOut, aborted, stdout, stderr }`, and renders as a compact `[tool] ok/failed` block. `repo` defaults to the session working directory, so inside a repository chat you can omit it.

## Requirements

- **Pijul 1.0.0-beta.x on `PATH`** (tested against `1.0.0-beta.21`), e.g. `cargo install pijul --version 1.0.0-beta.21`. An absolute path can be pinned instead through the plugin's `binary` config key.
- **An SSH agent holding a signing key, plus a pijul identity.** pijul 1.0-beta signs every recorded change with a key from the agent. One-time setup:

  ```sh
  ssh-agent -a ~/.ssh/agent.sock      # persistent agent; the plugin defaults SSH_AUTH_SOCK here
  ssh-add ~/.ssh/id_ed25519           # your signing key
  pijul identity list                 # an identity already exists? done.
  pijul identity new default --no-link --display-name "You" --email you@example.com
  ```

  Every command runs under `SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-$HOME/.ssh/agent.sock}"`, so a persistent agent at that socket keeps recording working across harness restarts. Diagnose failures with `pijul_identity`.

## Install

From GitHub — the repository is plain ESM with no build step, so a git install needs **no `prepare` script and no build allowance**:

```sh
dsh plugin --profile web add github:erkinalp/dsh-pijul
```

Pin a commit if you want the code you audited to be the code that runs:

```sh
dsh plugin --profile web add github:erkinalp/dsh-pijul#<commit-sha>
```

From a local checkout or a packed tarball:

```sh
dsh plugin --profile web add ./dsh-pijul
```

Restart `dsh web` (or the profile's process) afterwards. Confirm the layer landed with `dsh --profile web --dump-config` — it shows a `# == dsh-pijul` block.

## Example

```
[user]  put these three files under pijul, commit, and show me the change
[agent] pijul_init  {path: "notebook"}                      → ok
        pijul_add   {repo: "notebook", paths: ["."], recursive: true} → ok
        pijul_record{repo: "notebook", message: "initial import",
                     author: "You <you@example.com>"}       → ok
[pijul_log]  Change XXKRZNVTIP3J637PCAZXHI32FAFNIZUKJKBQFCJQUP6NBTVA763AC
             Author: You <you@example.com>   Date: 2026-08-20 21:47:59 (+03)
                 initial import
```

## Non-interactivity

A pijul command that opens an editor does not just fail an agent — it blocks the tool until the shell timeout. The plugin is built so that cannot happen, and the two cases it must defend against were found by probing `1.0.0-beta.21`:

| pijul behaviour | How the plugin handles it |
| --- | --- |
| `pijul record <paths> -m <msg>` opens the commit-message editor **even though `-m` was given** (in every flag order) | The command preamble exports `EDITOR`/`VISUAL` as the shell builtin `true`, a no-op. pijul then accepts the template it already wrote — the `-m` message — instead of waiting on an editor. |
| `pijul push` / `pijul pull` without `--all` open the editor to pick changes | `--all` is the default, and the same no-op editor makes the explicit `all: false` escape hatch safe rather than hanging. |
| `pijul unrecord` with no hashes shows an interactive selection | `pijul_unrecord` requires at least one hash. |
| `pijul add .` records only the directory itself, **not its contents** | `pijul_add` exposes `recursive` (pijul `--recursive`); the tool description says so, because "add everything" is the common intent. |

The plugin never prompts, and it never leaves a process attached to a terminal.

## Permissions and compatibility

- **Permissions**: commands run through the harness `shell` service under the calling session's standing sandbox policy — the same confinement as the built-in `bash` tool. Repositories are read and written under the session workspace; the SSH agent is used only to sign recorded changes. The plugin makes no network calls of its own: `pijul clone`/`push`/`pull` reach the network only when you invoke them.
- **External services**: none. Fully offline for local repositories.
- **Compatibility**: DeepSeek Harness profiles built on `@deepseek-ai/dsh-base` (DSH `>=0.2.0 <0.3.0`). It uses `tools`, `shell` and `systemPrompt`, and reads `sandboxPolicy`, `shellEnv` and `workingDirectory` when the profile provides them. pijul `1.0.0-beta.x`.
- **HTTPS remotes** support clone and pull but not push; use SSH or a local path to push.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `pijul binary not found on PATH` | Install pijul, or set `config.binary` to an absolute path on the `pijul` row. |
| `pijul_record` fails with an SSH or identity error | Recording is signed. Run `pijul_identity`; start the agent at `~/.ssh/agent.sock` and `ssh-add` your key (see [Requirements](#requirements)). |
| `Error: Already in a Pijul repository` | `pijul_init` on a directory that already holds a repository. That is a pijul error with exit 1, not a no-op. |
| `Refusing to reset, as there are unrecorded changes` | `pijul_reset` first, or record them, before switching channels. |
| A tool reports `sandbox: file access denied` | The session's sandbox policy governs the repository path; widen the workspace or move the repository inside it. |

On some systems the distro/snap `pijul` package cannot run inside a container because it hard-codes an `XDG_RUNTIME_DIR` under a read-only `/run`; a plain binary (`cargo install` or a release tarball) is the reliable choice.

## Development

Plain ESM, no build step, **zero dependencies**: `index.mjs` has no imports and exports `name`, `inject` and `apply(ctx, config)` per the [DeepSeek Harness plugin spec](https://github.com/deepseek-ai/deepseek-harness). Tool definitions are plain objects with hand-converted JSON Schema, so `ctx.tools.register` accepts them without `@deepseek-ai/dsh-tools`.

That is deliberate. A pnpm-linked bundle's bare imports resolve from the checkout's real path rather than the profile's `node_modules` and can be pruned by a later `dsh plugin add`; a dependency-free plugin can never fail to import.

```sh
npm test              # unit + integration (node:test, no install step)
npm run test:unit     # 34 tests, no pijul required
npm run test:integration   # drives the real pijul CLI; self-skips when absent
```

The unit tests build the plugin against a stub that mirrors the real service shapes — `ctx.tools.register`, `ctx.systemPrompt.section`, `ctx.shell.resolve` → `ctx.shell.execute` → `result()`, and `ctx.get` for optional services — so a regression in the shell seam fails here rather than in a chat. The integration tests run the exact command strings the plugin produces, in a real `bash`, against a real repository.

The bundle manifest lives in `package.json` (`dsh.bundle` → `cordis.patch.yml`), which inserts the `pijul` row into the profile composition. The `binary` config key is read as a plain value from the row config:

```yaml
- id: pijul
  name: dsh-pijul
  config:
    binary: /usr/local/bin/pijul
```

See [CHANGELOG.md](CHANGELOG.md) for the release history.

## License

[MIT](LICENSE) © Erkin Alp Güney
