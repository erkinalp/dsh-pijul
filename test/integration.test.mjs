/**
 * Integration tests for dsh-pijul: drive the REAL pijul CLI through the plugin.
 *
 * Each test builds the plugin against a shell stub that executes the command
 * string the plugin produced, in a real `bash`, in a temporary repository. So
 * every assertion covers the whole chain: tool definition -> argv construction
 * -> quoting -> preamble -> pijul's own behaviour.
 *
 * The whole file self-skips when pijul is unavailable, or when pijul cannot
 * record on this machine (recording is signed and needs an SSH agent identity).
 * That keeps the suite green on machines and CI runners without pijul, while a
 * checkout with pijul installed gets real coverage.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.mjs'

const TIMEOUT_MS = 120000

/** Run a shell command and normalize it into the ShellRunResult shape. */
function run(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve({
        exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: TIMEOUT_MS,
        stdout: { text: stdout, truncated: false },
        stderr: { text: stderr, truncated: false },
      })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: TIMEOUT_MS,
        stdout: { text: '', truncated: false },
        stderr: { text: String(error), truncated: false },
      })
    })
  })
}

/** Decide once whether real pijul coverage is possible here. */
function detect() {
  const version = spawnSync('pijul', ['--version'], { encoding: 'utf8' })
  if (version.error !== undefined || version.status !== 0) {
    return { usable: false, reason: 'pijul is not installed' }
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pijul-probe-'))
  try {
    const script = [
      'pijul init repo',
      'cd repo',
      'printf "x\\n" > f.txt',
      'pijul add f.txt',
      'EDITOR=true VISUAL=true pijul record -a -m probe',
    ].join(' && ')
    const probe = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' })
    if (probe.status !== 0) {
      return { usable: false, reason: 'pijul cannot record here (no identity or SSH agent)' }
    }
    return { usable: true, version: version.stdout.trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const DETECT = detect()
const skip = DETECT.usable ? false : `integration: ${DETECT.reason}`

/** Build the plugin against a shell stub that really executes. */
function harness(root) {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    systemPrompt: { section: () => () => {} },
    shell: {
      resolve(request) {
        return {
          command: request.command,
          workdir: request.workdir ?? root,
          timeoutMs: Math.min(request.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS),
          onExpiry: 'kill',
          stdoutMaxBytes: 1 << 22,
          signal: request.signal,
          sandboxPolicy: undefined,
        }
      },
      async execute(spec) {
        const result = await run(spec.command, spec.workdir)
        return { result: async () => result }
      },
    },
    get(serviceName) {
      // Mirror a normal profile: the session working directory is available.
      return serviceName === 'workingDirectory' ? { ensure: async () => root } : undefined
    },
  }
  apply(ctx, {})
  const agent = { session: { id: 'integration' } }
  async function call(toolName, args) {
    const definition = registered.get(toolName)
    assert.ok(definition, `${toolName} registered`)
    const value = await definition.execute(args, { signal: undefined, agent })
    return value
  }
  /** Assert a call succeeded and return it. */
  async function ok(toolName, args) {
    const value = await call(toolName, args)
    assert.equal(value.ok, true, `${toolName} failed: ${value.stderr || value.stdout}`)
    return value
  }
  return { call, ok }
}

/** A scratch directory containing one initialized repository named `repo`. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pijul-it-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

if (DETECT.usable) {
  test('detected a usable pijul', () => {
    assert.ok(DETECT.version.includes('pijul'))
  })
}

test('init, add --recursive, status, record, log and change', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok, call } = harness(root)
    await ok('pijul_init', { path: 'repo' })
    mkdirSync(join(root, 'repo', 'deep', 'er'), { recursive: true })
    writeFileSync(join(root, 'repo', 'a.txt'), 'alpha\n')
    writeFileSync(join(root, 'repo', 'deep', 'b.txt'), 'beta\n')
    writeFileSync(join(root, 'repo', 'deep', 'er', 'c.txt'), 'gamma\n')

    // A bare "." tracks only the directory itself; --recursive is what brings
    // the contents along, which the tool now exposes as `recursive`.
    await ok('pijul_add', { repo: 'repo', paths: ['.'], recursive: true })

    const statusBefore = await ok('pijul_status', { repo: 'repo' })
    assert.match(statusBefore.stdout, /a\.txt/)

    await ok('pijul_record', { repo: 'repo', message: 'initial import' })
    const statusAfter = await ok('pijul_status', { repo: 'repo' })
    assert.match(statusAfter.stdout, /Nothing to record|working copy is clean/i)

    const log = await ok('pijul_log', { repo: 'repo' })
    assert.match(log.stdout, /Change [A-Z0-9]+/)
    assert.match(log.stdout, /initial import/)

    // Paging values reach pijul single-quoted; confirm the real CLI accepts them.
    const oneChange = await ok('pijul_log', { repo: 'repo', limit: 1, offset: 0 })
    assert.equal((oneChange.stdout.match(/^Change /gm) ?? []).length, 1)

    const hash = log.stdout.match(/Change ([A-Z0-9]+)/)[1]
    const change = await ok('pijul_change', { repo: 'repo', hash: hash.slice(0, 8) })
    assert.match(change.stdout, /initial import/)
  } finally {
    cleanup()
  }
})

test('root add without --recursive tracks only the directory', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'repo' })
    mkdirSync(join(root, 'repo', 'sub'), { recursive: true })
    writeFileSync(join(root, 'repo', 'sub', 'x.txt'), 'x\n')
    const added = await ok('pijul_add', { repo: 'repo', paths: ['.'] })
    // pijul reports the directory as recorded but its contents as untracked.
    assert.match(added.stdout + added.stderr, /will not be tracked/)
  } finally {
    cleanup()
  }
})

test('record with explicit paths completes without an editor', { skip }, async () => {
  // The regression this pins: pijul opens $EDITOR for `record <paths> -m msg`,
  // which used to hang the tool until the shell timeout.
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'repo' })
    writeFileSync(join(root, 'repo', 'a.txt'), 'one\n')
    writeFileSync(join(root, 'repo', 'b.txt'), 'two\n')
    await ok('pijul_add', { repo: 'repo', paths: ['a.txt', 'b.txt'] })
    await ok('pijul_record', { repo: 'repo', message: 'both files' })

    writeFileSync(join(root, 'repo', 'a.txt'), 'one changed\n')
    const recorded = await ok('pijul_record', { repo: 'repo', paths: ['a.txt'], message: 'only a' })
    assert.match(recorded.stdout, /Hash: [A-Z0-9]+/)

    const log = await ok('pijul_log', { repo: 'repo' })
    assert.match(log.stdout, /only a/)
  } finally {
    cleanup()
  }
})

test('diff shows the edit and reset discards it', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'repo' })
    writeFileSync(join(root, 'repo', 'a.txt'), 'original\n')
    await ok('pijul_add', { repo: 'repo', paths: ['a.txt'] })
    await ok('pijul_record', { repo: 'repo', message: 'base' })

    writeFileSync(join(root, 'repo', 'a.txt'), 'original\nappended\n')
    const diff = await ok('pijul_diff', { repo: 'repo' })
    assert.match(diff.stdout, /appended/)

    await ok('pijul_reset', { repo: 'repo', files: ['a.txt'] })
    assert.equal(readFileSync(join(root, 'repo', 'a.txt'), 'utf8'), 'original\n')
  } finally {
    cleanup()
  }
})

test('channel lifecycle: new, list, switch, fork, delete', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'repo' })
    writeFileSync(join(root, 'repo', 'a.txt'), 'a\n')
    await ok('pijul_add', { repo: 'repo', paths: ['a.txt'] })
    await ok('pijul_record', { repo: 'repo', message: 'base' })

    await ok('pijul_channel', { repo: 'repo', action: 'new', name: 'empty' })
    const listed = await ok('pijul_channel', { repo: 'repo', action: 'list' })
    assert.match(listed.stdout, /empty/)

    await ok('pijul_channel', { repo: 'repo', action: 'switch', name: 'empty' })
    await ok('pijul_channel', { repo: 'repo', action: 'fork', name: 'forked' })
    const afterFork = await ok('pijul_channel', { repo: 'repo', action: 'list' })
    assert.match(afterFork.stdout, /forked/)

    await ok('pijul_channel', { repo: 'repo', action: 'delete', name: 'forked' })
    const afterDelete = await ok('pijul_channel', { repo: 'repo', action: 'list' })
    assert.doesNotMatch(afterDelete.stdout, /forked/)
  } finally {
    cleanup()
  }
})

test('remote lifecycle and clone', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'src' })
    writeFileSync(join(root, 'src', 'a.txt'), 'a\n')
    await ok('pijul_add', { repo: 'src', paths: ['a.txt'] })
    await ok('pijul_record', { repo: 'src', message: 'base' })
    await ok('pijul_init', { path: 'dst' })

    await ok('pijul_remote', { repo: 'src', action: 'default', remote: '../dst' })
    const listed = await ok('pijul_remote', { repo: 'src', action: 'list' })
    assert.match(listed.stdout, /\*/)
    assert.match(listed.stdout, /dst/)

    const cloned = await ok('pijul_clone', { remote: join(root, 'src'), dest: 'copy' })
    assert.match(cloned.stdout + cloned.stderr, /Repository created|Cloning|clone/i)
    assert.equal(readFileSync(join(root, 'copy', 'a.txt'), 'utf8'), 'a\n')

    await ok('pijul_remote', { repo: 'src', action: 'delete', remote: '../dst' })
    const afterDelete = await ok('pijul_remote', { repo: 'src', action: 'list' })
    assert.doesNotMatch(afterDelete.stdout, /dst/)
  } finally {
    cleanup()
  }
})

test('push --all and pull --all move changes between local repositories', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'a' })
    writeFileSync(join(root, 'a', 'f.txt'), 'one\n')
    await ok('pijul_add', { repo: 'a', paths: ['f.txt'] })
    await ok('pijul_record', { repo: 'a', message: 'first' })
    await ok('pijul_init', { path: 'b' })

    await ok('pijul_push', { repo: 'a', remote: join(root, 'b') })
    const logB = await ok('pijul_log', { repo: 'b' })
    assert.match(logB.stdout, /first/)

    await ok('pijul_init', { path: 'c' })
    await ok('pijul_pull', { repo: 'c', remote: join(root, 'a') })
    const logC = await ok('pijul_log', { repo: 'c' })
    assert.match(logC.stdout, /first/)
  } finally {
    cleanup()
  }
})

test('unrecord drops a change and apply brings it back onto a channel', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { ok } = harness(root)
    await ok('pijul_init', { path: 'repo' })
    writeFileSync(join(root, 'repo', 'a.txt'), 'a\n')
    await ok('pijul_add', { repo: 'repo', paths: ['a.txt'] })
    await ok('pijul_record', { repo: 'repo', message: 'keeper' })
    const log = await ok('pijul_log', { repo: 'repo' })
    const hash = log.stdout.match(/Change ([A-Z0-9]+)/)[1]

    await ok('pijul_channel', { repo: 'repo', action: 'new', name: 'target' })
    await ok('pijul_channel', { repo: 'repo', action: 'switch', name: 'target' })
    await ok('pijul_apply', { repo: 'repo', hashes: [hash] })
    const applied = await ok('pijul_log', { repo: 'repo' })
    assert.match(applied.stdout, /keeper/)

    // Applying a change also materializes it in the working copy, and pijul
    // refuses to switch channels while changes are unrecorded, so discard them
    // before going back to main.
    await ok('pijul_reset', { repo: 'repo' })
    await ok('pijul_channel', { repo: 'repo', action: 'switch', name: 'main' })
    await ok('pijul_unrecord', { repo: 'repo', hashes: [hash] })
    const afterUnrecord = await ok('pijul_log', { repo: 'repo' })
    assert.doesNotMatch(afterUnrecord.stdout, /keeper/)
  } finally {
    cleanup()
  }
})

test('outside a repository the failure is reported, not thrown', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    const { call } = harness(root)
    const value = await call('pijul_status', {})
    assert.equal(value.ok, false)
    assert.equal(value.exitCode, 1)
    assert.match(value.stderr, /No Pijul repository found/)
  } finally {
    cleanup()
  }
})

test('a missing pijul binary fails with the preamble message', { skip }, async () => {
  const { root, cleanup } = scratch()
  try {
    // Rebuild the plugin with a binary path that does not exist.
    const registered = new Map()
    const ctx = {
      tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
      systemPrompt: { section: () => () => {} },
      shell: {
        resolve: (request) => ({
          command: request.command,
          workdir: request.workdir ?? root,
          timeoutMs: TIMEOUT_MS,
          onExpiry: 'kill',
          stdoutMaxBytes: 1 << 22,
          sandboxPolicy: undefined,
        }),
        async execute(spec) {
          const result = await run(spec.command, spec.workdir)
          return { result: async () => result }
        },
      },
      get: (name) => (name === 'workingDirectory' ? { ensure: async () => root } : undefined),
    }
    apply(ctx, { binary: '/nonexistent/pijul-binary' })
    const value = await registered.get('pijul_status').execute({}, { signal: undefined, agent: undefined })
    assert.equal(value.ok, false)
    assert.equal(value.exitCode, 127)
    assert.match(value.stderr, /pijul binary not found or not executable/)
  } finally {
    cleanup()
  }
})
