/**
 * dsh-pijul — Pijul version control tools for DeepSeek Harness.
 *
 * Registers sixteen Host-side model tools that drive the `pijul` CLI through
 * the harness `shell` service, with the calling session's standing sandbox
 * policy, session working directory and DSH environment (the same path
 * tool-bash uses):
 *
 *   pijul_status   — show the working-copy state of a repository
 *   pijul_log      — list recorded changes (--limit / --offset)
 *   pijul_diff     — show unrecorded changes as hunks
 *   pijul_init     — create a new repository
 *   pijul_clone    — clone a remote repository (URL, SSH target or local path)
 *   pijul_add      — start tracking paths (recursive for directory contents)
 *   pijul_record   — record a change non-interactively (-a or explicit paths)
 *   pijul_change   — show one change by hash
 *   pijul_unrecord — drop changes from the current channel (by hash)
 *   pijul_reset    — discard unrecorded working-copy changes
 *   pijul_push     — push changes to a remote (non-interactive --all)
 *   pijul_pull     — pull changes from a remote (non-interactive --all)
 *   pijul_remote   — list remotes, set/clear the default, delete one
 *   pijul_channel  — list, new, switch, delete or fork channels
 *   pijul_apply    — apply changes to the current channel
 *   pijul_identity — list the signing identities pijul knows about
 *
 * Non-interactivity rules (pijul opens $EDITOR or prompts per hunk otherwise):
 *
 *   - record passes `-a` when no paths are given, push and pull pass `--all`,
 *     and unrecord/apply require explicit hashes so none of them can fall back
 *     to an editor prompt.
 *   - Two cases still open $EDITOR, both verified against pijul 1.0.0-beta.21:
 *     `pijul record <paths> -m <msg>` does it even though `-m` was supplied (in
 *     every flag order), and `push`/`pull` without `--all` do it to select
 *     changes. The command preamble therefore exports EDITOR/VISUAL=true: pijul
 *     accepts the template it already wrote (the `-m` message, or the full
 *     change list) instead of waiting on an editor an agent shell cannot
 *     service. This keeps `record` with explicit paths and the `all: false`
 *     push/pull escape hatch usable rather than hanging until the timeout.
 *
 * Recording is signed: pijul 1.0-beta reads keys from the SSH agent, so the
 * preamble defaults SSH_AUTH_SOCK to ~/.ssh/agent.sock when it is not already
 * set (see the README identity setup).
 *
 * The pijul executable is resolved on PATH (or via the `binary` config key).
 *
 * Zero-dependency by design: this module has NO imports, so the Loader can
 * never fail to import it. Tool definitions are built as plain objects with
 * hand-converted JSON Schema, which `ctx.tools.register` accepts directly;
 * `defineTool` and the schemastery `Config` validator from @deepseek-ai are
 * deliberately not used, because a linked package's bare imports resolve from
 * the checkout's real path rather than the profile's node_modules and can be
 * pruned by a later `dsh plugin add` (see the README development notes).
 */

export const name = 'pijul'
export const inject = ['tools', 'shell', 'systemPrompt']

/** Single-quote a value for safe interpolation into a bash command string. */
function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Convert a property-level parameter spec (each property may carry
 * `required: true`, as defineTool accepts) into a plain JSON Schema node with
 * a top-level `required` array, which tools.register enforces.
 */
function specToSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = prop
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export function apply(ctx, config = {}) {
  const binary = config.binary !== undefined && config.binary !== ''
    ? sq(config.binary)
    : 'pijul'
  // Preamble prepended to every pijul command: resolves the pijul executable
  // and the SSH agent socket (pijul signs changes with a key from the agent),
  // failing with clear messages when either is missing.
  //
  // EDITOR/VISUAL are pinned to `true` (the shell builtin, a no-op). pijul
  // opens $EDITOR in two agent-hostile places, both verified against
  // 1.0.0-beta.21 while building this plugin:
  //   - `record <paths> -m <msg>` opens the commit-message editor even though
  //     `-m` was supplied, in every flag order;
  //   - `push`/`pull` without `--all` open the editor to select changes.
  // Either one blocks an agent shell until its timeout. A no-op editor accepts
  // the template pijul already wrote (the `-m` message, or the full change
  // list), so the command completes with the intended effect.
  const PREAMBLE = [
    'export SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-$HOME/.ssh/agent.sock}"',
    'export EDITOR=true VISUAL=true',
    `PIJUL_BIN=${binary}`,
    'case "$PIJUL_BIN" in /*) test -x "$PIJUL_BIN" || { echo "pijul binary not found or not executable: $PIJUL_BIN" >&2; exit 127; } ;;',
    '  *) PIJUL_BIN="$(command -v "$PIJUL_BIN" || true)"; [ -n "$PIJUL_BIN" ] || { echo "pijul binary not found on PATH (install pijul, e.g. cargo install pijul, or set the plugin \\"binary\\" config)" >&2; exit 127; } ;;',
    'esac',
  ].join('\n')

  // Run one bash command through the harness shell service with the caller's
  // standing sandbox policy and DSH environment, mirroring tool-bash:
  // ctx.shell.resolve() fills defaults, ctx.shell.execute() starts the process,
  // and the returned handle's result() is the foreground projection.
  async function runShell(command, exec, opts = {}) {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const policy = sandboxPolicy === undefined ? undefined
      : sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    const shellEnv = ctx.get('shellEnv')
    // Without an explicit workdir the executor would fall back to the harness
    // process cwd, not the session workspace, so resolve the caller's session
    // directory the same way tool-bash does. Optional: profiles without
    // @deepseek-ai/dsh-working-directory keep the executor default.
    const workingDirectory = ctx.get('workingDirectory')
    const workdir = opts.workdir ?? (workingDirectory !== undefined && exec.agent !== undefined
      ? await workingDirectory.ensure(exec.agent, exec.signal)
      : undefined)
    const request = {
      command,
      ...(workdir !== undefined ? { workdir } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
    }
    const handle = await ctx.shell.execute(ctx.shell.resolve({ ...request, signal: exec.signal }))
    return handle.result()
  }

  function outcome(result) {
    return {
      ok: result.exitCode === 0 && result.timedOut !== true && result.aborted !== true,
      exitCode: result.exitCode === undefined ? null : result.exitCode,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
      stdout: result.stdout === undefined ? '' : result.stdout.text,
      stderr: result.stderr === undefined ? '' : result.stderr.text,
    }
  }

  function renderOutcome(label, v) {
    const notes = [v.timedOut ? ', timed out' : '', v.aborted ? ', aborted' : ''].join('')
    const lines = [`[${label}] ${v.ok ? 'ok' : 'failed'} (exit ${v.exitCode ?? 'n/a'}${notes})`]
    if (v.stdout) lines.push('--- stdout ---\n' + v.stdout.replace(/\n+$/, ''))
    if (v.stderr) lines.push('--- stderr ---\n' + v.stderr.replace(/\n+$/, ''))
    return lines.join('\n')
  }

  // Canonical output contract. `additionalProperties: false` means every key
  // returned by outcome() must be declared here, and vice versa.
  const OUTPUT_SPEC = {
    ok: { type: 'boolean', required: true },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  }
  const OUTPUT_SCHEMA = specToSchema(OUTPUT_SPEC)

  const STRING = { type: 'string' }
  const STRINGS = { type: 'array', items: STRING }
  // Network operations get a much larger budget than the executor default; the
  // shell executor still clamps to its configured maxTimeoutMs.
  const NETWORK_TIMEOUT_MS = 600000

  async function safeExec(fn, label) {
    try {
      return await fn()
    } catch (error) {
      return { ok: false, exitCode: null, timedOut: false, aborted: false, stdout: '', stderr: `${label} failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // Build the shell command for one pijul invocation: optional repo workdir,
  // then a list of already-quoted argv pieces.
  function commandLine(repo, argv) {
    const parts = [PREAMBLE]
    if (repo !== undefined && repo !== '') parts.push(`cd ${sq(repo)} || exit 1`)
    parts.push(`"$PIJUL_BIN" ${argv.join(' ')}`)
    return parts.join('\n')
  }

  // Build one plain ToolDefinition for ctx.tools.register: JSON-schema output
  // + terminal render + safe execute. `argv(args)` returns { repo, argv }
  // where argv is already-quoted pieces.
  function tool({ name: toolName, description, parameters, argv, timeoutMs }) {
    return {
      name: toolName,
      description,
      parameters: specToSchema(parameters),
      timeoutMs,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderOutcome(toolName, value) }],
      },
      async execute(args, exec) {
        return safeExec(async () => {
          const { repo, argv: pieces } = argv(args)
          const result = await runShell(
            commandLine(repo, pieces),
            exec,
            timeoutMs === undefined ? {} : { timeoutMs },
          )
          return outcome(result)
        }, toolName)
      },
    }
  }

  ctx.tools.register(tool({
    name: 'pijul_status',
    description: 'Show the working-copy state of a Pijul repository: the current channel, unrecorded changes and untracked files. Run inside a Pijul repository or pass repo. Useful before record, reset or diff.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      paths: { ...STRINGS, description: 'Only show status for these paths.' },
    },
    argv(args) {
      const argv = ['status']
      if (args.paths !== undefined) for (const p of args.paths) argv.push(sq(p))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_log',
    description: 'List the recorded changes of a Pijul repository, newest first: hash, author, date and message of each change. Use the hash prefixes to feed pijul_change, pijul_unrecord or pijul_apply.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      limit: { type: 'integer', description: 'Output at most this many changes (pijul log --limit).' },
      offset: { type: 'integer', description: 'Start after this many changes (pijul log --offset).' },
    },
    argv(args) {
      const argv = ['log']
      // Quoted, never interpolated bare: a model-supplied value that is not a
      // bare integer must reach pijul as one argument, not as shell syntax.
      if (args.limit !== undefined) argv.push('--limit', sq(args.limit))
      if (args.offset !== undefined) argv.push('--offset', sq(args.offset))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_diff',
    description: 'Show the unrecorded changes of a Pijul repository as hunks (added, modified and deleted lines). Use with paths to limit scope.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      paths: { ...STRINGS, description: 'Only diff these paths (files or directories).' },
    },
    argv(args) {
      const argv = ['diff']
      if (args.paths !== undefined) for (const p of args.paths) argv.push(sq(p))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_init',
    description: 'Create a new Pijul repository at the given path (the path is created if missing). Fails with "Already in a Pijul repository" when the target already is one.',
    parameters: {
      path: { ...STRING, description: 'Directory for the new repository (defaults to the session working directory).' },
    },
    argv(args) {
      const argv = ['init']
      if (args.path !== undefined && args.path !== '') argv.push(sq(args.path))
      return { repo: undefined, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_clone',
    description: 'Clone a Pijul remote repository into the given directory (defaults to the remote\'s name). The remote may be an https:// URL, an SSH target like me@ssh.pijul.com:me/repo, or a local path. HTTPS supports clone/pull but not push.',
    parameters: {
      remote: { ...STRING, required: true, description: 'Remote URL, SSH target or local path of the repository to clone.' },
      dest: { ...STRING, description: 'Destination directory (defaults to the remote\'s repository name).' },
    },
    argv(args) {
      const argv = ['clone', sq(args.remote)]
      if (args.dest !== undefined && args.dest !== '') argv.push(sq(args.dest))
      return { repo: undefined, argv }
    },
    timeoutMs: NETWORK_TIMEOUT_MS,
  }))

  ctx.tools.register(tool({
    name: 'pijul_add',
    description: 'Start tracking paths in a Pijul repository. Paths are relative to the current directory (the repository when repo is given). A bare "." tracks only the directory itself: pass recursive true to track its contents, which is required for "add everything". Follow with pijul_record to create the change.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      paths: { ...STRINGS, required: true, description: 'Paths to start tracking (use ["."] with recursive true for the whole repository).' },
      recursive: { type: 'boolean', description: 'Track directory contents as well (pijul add --recursive). Required for a directory to bring its files along.' },
    },
    argv(args) {
      const argv = ['add']
      if (args.recursive === true) argv.push('--recursive')
      for (const p of args.paths) argv.push(sq(p))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_record',
    description: 'Record a new change in a Pijul repository without launching an interactive editor. Pass the change message (required). When no paths are given, records all changed paths (-a); pass paths to record only those. An author is optional when an identity is configured (pijul identity list).',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      message: { ...STRING, required: true, description: 'Change message (pijul record -m).' },
      author: { ...STRING, description: 'Author line such as "Name <email>" (pijul record --author).' },
      timestamp: { ...STRING, description: 'Timestamp as an RFC3339 date-time string, e.g. "2026-08-20T18:47:59Z" (pijul record --timestamp; Unix epoch numbers are NOT accepted). Defaults to now.' },
      paths: { ...STRINGS, description: 'Record only these paths (defaults to all changed paths).' },
    },
    argv(args) {
      const argv = ['record']
      if (args.paths === undefined || args.paths.length === 0) {
        argv.push('-a')
      } else {
        for (const p of args.paths) argv.push(sq(p))
      }
      argv.push('-m', sq(args.message))
      if (args.author !== undefined && args.author !== '') argv.push('--author', sq(args.author))
      if (args.timestamp !== undefined && args.timestamp !== '') argv.push('--timestamp', sq(args.timestamp))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_change',
    description: 'Show the details of one recorded change of a Pijul repository: author, date, message and the raw patch. The hash may be an unambiguous prefix from pijul_log; without a hash pijul shows the current change.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      hash: { ...STRING, description: 'The hash of the change to show, or an unambiguous prefix.' },
    },
    argv(args) {
      const argv = ['change']
      if (args.hash !== undefined && args.hash !== '') argv.push(sq(args.hash))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_unrecord',
    description: 'Remove changes from the current channel of a Pijul repository without touching the working copy. Pass one or more hashes (unambiguous prefixes from pijul_log). A change can only be unrecorded when every change that depends on it is unrecorded in the same call. This is the Pijul way to undo recorded work.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      hashes: { ...STRINGS, required: true, description: 'Hashes (or prefixes) of the changes to unrecord.' },
    },
    argv(args) {
      const argv = ['unrecord']
      for (const h of args.hashes) argv.push(sq(h))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_reset',
    description: 'Discard the unrecorded changes of a Pijul repository, restoring the working copy to the last recorded change. Use with a dryRun to preview. Dangerous: unrecorded work is lost.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      files: { ...STRINGS, description: 'Only reset these files.' },
      dryRun: { type: 'boolean', description: 'Only print what would change, without modifying the repository (single file only).' },
    },
    argv(args) {
      const argv = ['reset']
      if (args.dryRun === true) argv.push('--dry-run')
      if (args.files !== undefined) for (const f of args.files) argv.push(sq(f))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_push',
    description: 'Push the recorded changes of a Pijul repository to a remote (a URL, SSH target or local path). Non-interactive: pushes all changes by default. HTTPS remotes do not support push; use SSH or a local path.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      remote: { ...STRING, description: 'Remote URL, SSH target or local path to push to (defaults to the configured default remote).' },
      all: { type: 'boolean', description: 'Push all changes (pijul push --all). Default true; set false only when you know what you are doing.' },
      fromChannel: { ...STRING, description: 'Push from this channel instead of the default (pijul push --from-channel).' },
      toChannel: { ...STRING, description: 'Push to this remote channel (pijul push --to-channel).' },
    },
    argv(args) {
      const argv = ['push']
      if (args.all !== false) argv.push('--all')
      if (args.fromChannel !== undefined && args.fromChannel !== '') argv.push('--from-channel', sq(args.fromChannel))
      if (args.toChannel !== undefined && args.toChannel !== '') argv.push('--to-channel', sq(args.toChannel))
      if (args.remote !== undefined && args.remote !== '') argv.push(sq(args.remote))
      return { repo: args.repo, argv }
    },
    timeoutMs: NETWORK_TIMEOUT_MS,
  }))

  ctx.tools.register(tool({
    name: 'pijul_pull',
    description: 'Pull the changes of a remote into a Pijul repository (a URL, SSH target or local path; defaults to the configured default remote). Non-interactive: pulls all changes by default.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      remote: { ...STRING, description: 'Remote URL, SSH target or local path to pull from (defaults to the configured default remote).' },
      all: { type: 'boolean', description: 'Pull all changes (pijul pull --all). Default true; set false only when you know what you are doing.' },
    },
    argv(args) {
      const argv = ['pull']
      if (args.all !== false) argv.push('--all')
      if (args.remote !== undefined && args.remote !== '') argv.push(sq(args.remote))
      return { repo: args.repo, argv }
    },
    timeoutMs: NETWORK_TIMEOUT_MS,
  }))

  ctx.tools.register(tool({
    name: 'pijul_remote',
    description: 'Manage the saved remotes of a Pijul repository. list shows saved remotes (a * marks the default), default sets the default remote (a URL, SSH target or local path), delete removes a saved remote. Remotes are identified by their URL/path.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      action: { type: 'string', enum: ['list', 'default', 'delete'], description: 'What to do with remotes.' },
      remote: { ...STRING, description: 'The remote URL, SSH target or local path (required for default and delete).' },
    },
    argv(args) {
      const action = args.action ?? 'list'
      const argv = ['remote']
      if (action !== 'list') argv.push(action)
      if (args.remote !== undefined && args.remote !== '') argv.push(sq(args.remote))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_channel',
    description: 'Manage the channels of a Pijul repository (Pijul\'s analogue of branches, needed far less often because independent changes commute). list shows channels (a * marks the current one); new creates an empty channel; switch changes channel (refuses with unrecorded changes in the working copy); delete removes a channel that is not current; fork creates a channel from the current state.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      action: { type: 'string', enum: ['list', 'new', 'switch', 'delete', 'fork'], description: 'What to do with channels.' },
      name: { ...STRING, description: 'Channel name (required for new, delete and fork; optional for switch, which then defaults to the current channel).' },
    },
    argv(args) {
      const action = args.action ?? 'list'
      if (action === 'fork') {
        const argv = ['fork']
        if (args.name !== undefined && args.name !== '') argv.push(sq(args.name))
        return { repo: args.repo, argv }
      }
      const argv = ['channel']
      if (action !== 'list') argv.push(action)
      if (args.name !== undefined && args.name !== '') argv.push(sq(args.name))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_apply',
    description: 'Apply recorded changes to the current channel of a Pijul repository, using hashes (or unambiguous prefixes) from pijul_log. This is how you bring a change that exists in the repository onto a channel.',
    parameters: {
      repo: { ...STRING, description: 'Path to the repository (defaults to the session working directory).' },
      hashes: { ...STRINGS, required: true, description: 'Hashes (or prefixes) of the changes to apply.' },
    },
    argv(args) {
      const argv = ['apply']
      for (const h of args.hashes) argv.push(sq(h))
      return { repo: args.repo, argv }
    },
  }))

  ctx.tools.register(tool({
    name: 'pijul_identity',
    description: 'List the signing identities pijul knows about on this machine. Recording is signed: pijul 1.0-beta reads keys from the SSH agent (SSH_AUTH_SOCK, defaulted to ~/.ssh/agent.sock). Run this when pijul_record fails with an SSH-agent or identity error.',
    parameters: {},
    argv() {
      return { repo: undefined, argv: ['identity', 'list'] }
    },
  }))

  ctx.systemPrompt.section({
    name: 'tool:pijul',
    order: 150,
    text: 'The pijul_status / pijul_log / pijul_diff / pijul_init / pijul_clone / pijul_add / pijul_record / pijul_change / pijul_unrecord / pijul_reset / pijul_push / pijul_pull / pijul_remote / pijul_channel / pijul_apply / pijul_identity tools drive the pijul distributed version control system. Use them only for Pijul repositories (.pijul), never Git repositories. pijul_record needs a message and records all changed paths by default (-a); pijul_add needs recursive true to track the contents of a directory; pijul_push and pijul_pull are non-interactive (--all). Recording is signed via the SSH agent: run pijul_identity when record fails with an SSH or identity error.',
  })
}
