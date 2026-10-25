/**
 * Unit tests for dsh-pijul. Zero dependencies: `node --test`.
 *
 * The harness stub below mirrors the REAL DeepSeek Harness service surface the
 * plugin is allowed to touch:
 *
 *   - ctx.tools.register(definition)        -> disposer (fiber-scoped effect)
 *   - ctx.systemPrompt.section(section)     -> disposer
 *   - ctx.shell.resolve(request)            -> ShellExecSpec (fills defaults)
 *   - ctx.shell.execute(spec)               -> ShellExecution { result() }
 *   - ctx.get(<service>)                    -> optional service or undefined
 *
 * `ctx.shell` deliberately has NO `run()`: the first release of this plugin
 * called `ctx.shell.run(...)`, which does not exist, so every tool failed with
 * "ctx.shell.run is not a function". These tests pin the correct seam.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name as pluginName, inject } from '../index.mjs'

const EXPECTED_TOOLS = [
  'pijul_add', 'pijul_apply', 'pijul_change', 'pijul_channel', 'pijul_clone',
  'pijul_diff', 'pijul_identity', 'pijul_init', 'pijul_log', 'pijul_pull',
  'pijul_push', 'pijul_record', 'pijul_remote', 'pijul_reset', 'pijul_status',
  'pijul_unrecord',
]

/** Build a harness stub with the production service shapes. */
function harness(options = {}) {
  const registered = new Map()
  const specs = []
  const sections = []
  const ensureCalls = []
  const services = options.services ?? {}

  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    shell: {
      // Mirrors @deepseek-ai/dsh-shell: resolve() then execute(). No run().
      resolve(request) {
        return {
          command: request.command,
          workdir: request.workdir ?? options.executorDefaultWorkdir ?? '/executor-default-cwd',
          timeoutMs: Math.min(request.timeoutMs ?? 120000, options.maxTimeoutMs ?? 3600000),
          onExpiry: request.onExpiry ?? 'kill',
          stdoutMaxBytes: 1048576,
          signal: request.signal,
          ...(request.dshEnv === undefined ? {} : { dshEnv: request.dshEnv }),
          sandboxPolicy: request.sandboxPolicy,
        }
      },
      async execute(spec) {
        specs.push(spec)
        if (options.onExecute !== undefined) {
          const output = await options.onExecute(spec)
          return handle({
            exitCode: output.exitCode ?? 0,
            timedOut: output.timedOut ?? false,
            aborted: output.aborted ?? false,
            stdout: output.stdout ?? '',
            stderr: output.stderr ?? '',
          })
        }
        return handle({ exitCode: 0, timedOut: false, aborted: false, stdout: 'ok', stderr: '' })
      },
    },
    get(serviceName) {
      return services[serviceName]
    },
  }

  function handle(result) {
    const run = {
      exitCode: result.exitCode,
      signal: null,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs: 120000,
      stdout: { text: result.stdout, truncated: false },
      stderr: { text: result.stderr, truncated: false },
    }
    return { result: async () => run }
  }

  // Track workingDirectory.ensure() the way the real service is called.
  if (services.workingDirectory !== undefined) {
    const ensure = services.workingDirectory.ensure
    services.workingDirectory.ensure = async (agent, signal) => {
      ensureCalls.push({ agent, signal })
      return ensure(agent, signal)
    }
  }

  const app = apply(ctx, options.config ?? {})
  return { ctx, registered, specs, sections, ensureCalls, app }
}

/** Run one tool through the stub and return its canonical value. */
async function call(h, toolName, args, exec = {}) {
  const definition = h.registered.get(toolName)
  assert.ok(definition, `tool ${toolName} is registered`)
  return definition.execute(args, { signal: undefined, agent: undefined, ...exec })
}

/** Execute a captured shell command for real, to test quoting end to end. */
function runInBash(command, env = {}) {
  return execFileSync('bash', ['-c', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
}

test('module exports the loader contract', () => {
  assert.equal(pluginName, 'pijul')
  assert.deepEqual(inject, ['tools', 'shell', 'systemPrompt'])
})

test('registers exactly the sixteen documented tools', () => {
  const h = harness()
  assert.deepEqual([...h.registered.keys()].sort(), EXPECTED_TOOLS)
})

test('registers one system prompt section with a finite order', () => {
  const h = harness()
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].name, 'tool:pijul')
  assert.equal(typeof h.sections[0].order, 'number')
  assert.match(h.sections[0].text, /pijul_record/)
})

test('every tool declares a well-formed output contract', () => {
  const h = harness()
  for (const [toolName, definition] of h.registered) {
    assert.equal(definition.name, toolName)
    assert.equal(typeof definition.execute, 'function', `${toolName} has execute`)
    assert.equal(typeof definition.description, 'string', `${toolName} has description`)
    assert.equal(definition.parameters.type, 'object', `${toolName} parameters are an object schema`)
    assert.equal(definition.parameters.additionalProperties, false)

    const schema = definition.output.schema
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      ['aborted', 'exitCode', 'ok', 'stderr', 'stdout', 'timedOut'],
    )
    assert.deepEqual(schema.required, ['ok'])
  }
})

test('canonical output matches the declared schema keys exactly', async () => {
  const h = harness()
  for (const toolName of ['pijul_status', 'pijul_identity', 'pijul_log']) {
    const value = await call(h, toolName, {})
    const schema = h.registered.get(toolName).output.schema
    assert.deepEqual(Object.keys(value).sort(), Object.keys(schema.properties).sort(), toolName)
  }
})

test('works against a shell service that has no run()', async () => {
  // Regression: the shipped 0.1.0 called ctx.shell.run(), which is not part of
  // the ShellExecutor seam, so every tool failed before reaching pijul.
  const h = harness()
  assert.equal(h.ctx.shell.run, undefined)
  const value = await call(h, 'pijul_status', {})
  assert.equal(value.ok, true)
  assert.equal(h.specs.length, 1)
})

test('status targets the repository with a quoted cd', async () => {
  const h = harness()
  await call(h, 'pijul_status', { repo: '/repos/demo' })
  assert.match(h.specs[0].command, /^cd '\/repos\/demo' \|\| exit 1$/m)
  assert.match(h.specs[0].command, /"\$PIJUL_BIN" status$/)
})

test('status forwards path filters as separate quoted arguments', async () => {
  const h = harness()
  await call(h, 'pijul_status', { paths: ['src/a b.txt', "it's.txt"] })
  assert.match(h.specs[0].command, /status 'src\/a b\.txt' 'it'\\''s\.txt'$/)
})

test('record without paths records everything with -a', async () => {
  const h = harness()
  await call(h, 'pijul_record', { message: 'initial commit' })
  const command = h.specs[0].command
  assert.match(command, /record -a -m 'initial commit'$/)
})

test('record with paths quotes them and passes the message', async () => {
  const h = harness()
  await call(h, 'pijul_record', { paths: ['a.txt', 'sub/'], message: "fix: it's ready" })
  const command = h.specs[0].command
  assert.match(command, /record 'a\.txt' 'sub\/' -m 'fix: it'\\''s ready'$/)
})

test('every command pins a no-op editor, because pijul opens one in agent-hostile places', async () => {
  // Verified against pijul 1.0.0-beta.21: `pijul record <paths> -m <msg>` opens
  // the commit-message editor even with -m, and push/pull without --all open it
  // to select changes. Both block an agent shell until its timeout, so the
  // preamble neutralises the editor and pijul accepts the template it wrote.
  const record = harness()
  await call(record, 'pijul_record', { paths: ['a.txt'], message: 'x' })
  assert.match(record.specs[0].command, /^export EDITOR=true VISUAL=true$/m)

  const pushWithoutAll = harness()
  await call(pushWithoutAll, 'pijul_push', { all: false })
  assert.match(pushWithoutAll.specs[0].command, /^export EDITOR=true VISUAL=true$/m)

  const pullWithoutAll = harness()
  await call(pullWithoutAll, 'pijul_pull', { all: false })
  assert.match(pullWithoutAll.specs[0].command, /^export EDITOR=true VISUAL=true$/m)
})

test('record passes author and timestamp through', async () => {
  const h = harness()
  await call(h, 'pijul_record', {
    message: 'm',
    author: 'Ada <ada@example.com>',
    timestamp: '2026-08-20T18:47:59Z',
  })
  assert.match(h.specs[0].command, /--author 'Ada <ada@example\.com>'/)
  assert.match(h.specs[0].command, /--timestamp '2026-08-20T18:47:59Z'/)
})

test('add forwards --recursive only when asked', async () => {
  const a = harness()
  await call(a, 'pijul_add', { paths: ['.'] })
  assert.match(a.specs[0].command, /"\$PIJUL_BIN" add '\.'$/)

  const b = harness()
  await call(b, 'pijul_add', { paths: ['.'], recursive: true })
  assert.match(b.specs[0].command, /"\$PIJUL_BIN" add --recursive '\.'$/)
})

test('paging integers are quoted, never interpolated bare', async () => {
  const h = harness()
  await call(h, 'pijul_log', { limit: 10, offset: 5 })
  assert.match(h.specs[0].command, /log --limit '10' --offset '5'$/)
})

test('a hostile paging value cannot inject shell syntax', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pijul-inject-'))
  const canary = join(dir, 'pwned')
  try {
    const h = harness()
    await call(h, 'pijul_log', { limit: `1; touch ${canary}` })
    const command = h.specs[0].command

    // Execute the generated command with a fake pijul on PATH, so the quoting
    // is proven against a real shell rather than by string inspection.
    const bin = join(dir, 'bin')
    execFileSync('mkdir', ['-p', bin])
    writeFileSync(join(bin, 'pijul'), '#!/bin/sh\nprintf "ARGV:%s\\n" "$*"\n')
    chmodSync(join(bin, 'pijul'), 0o755)

    const stdout = runInBash(command, { PATH: `${bin}:${process.env.PATH}` })
    assert.equal(existsSync(canary), false, 'the injected command must not run')
    assert.match(stdout, new RegExp(`ARGV:log --limit 1; touch ${canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hostile repository path cannot inject shell syntax', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pijul-repo-'))
  const canary = join(dir, 'pwned')
  try {
    const h = harness()
    await call(h, 'pijul_status', { repo: `/tmp/x'; touch ${canary}; '` })
    const command = h.specs[0].command
    // The cd must fail (the directory does not exist) and nothing else may run.
    assert.throws(() => runInBash(command, { PATH: process.env.PATH }))
    assert.equal(existsSync(canary), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runs in the session working directory when no repo is given', async () => {
  const h = harness({
    services: { workingDirectory: { ensure: async () => '/session/workspace' } },
    executorDefaultWorkdir: '/executor-default-cwd',
  })
  await call(h, 'pijul_status', {}, { agent: { session: { id: 's1' } } })
  assert.equal(h.specs[0].workdir, '/session/workspace')
  assert.equal(h.ensureCalls.length, 1)
  assert.deepEqual(h.ensureCalls[0].agent, { session: { id: 's1' } })
})

test('falls back to the executor workdir when the directory service is absent', async () => {
  const h = harness({ executorDefaultWorkdir: '/executor-default-cwd' })
  await call(h, 'pijul_status', {})
  assert.equal(h.specs[0].workdir, '/executor-default-cwd')
})

test('skips directory resolution when no agent is attached', async () => {
  const h = harness({
    services: { workingDirectory: { ensure: async () => '/session/workspace' } },
    executorDefaultWorkdir: '/executor-default-cwd',
  })
  await call(h, 'pijul_status', {})
  assert.equal(h.specs[0].workdir, '/executor-default-cwd')
  assert.equal(h.ensureCalls.length, 0)
})

test('forwards the standing sandbox policy and DSH environment', async () => {
  const h = harness({
    services: {
      sandboxPolicy: { resolve: (scope) => ({ mode: 'workspace-write', scope }) },
      shellEnv: { collect: () => ({ DSH_SESSION_ID: 'abc' }) },
    },
  })
  await call(h, 'pijul_status', {}, { agent: { session: { id: 's1' } } })
  assert.deepEqual(h.specs[0].sandboxPolicy, { mode: 'workspace-write', scope: { session: { id: 's1' } } })
  assert.deepEqual(h.specs[0].dshEnv, { DSH_SESSION_ID: 'abc' })
})

test('a non-zero exit is reported with both streams', async () => {
  const h = harness({ onExecute: async () => ({ exitCode: 1, stdout: 'out', stderr: 'fatal: nope' }) })
  const value = await call(h, 'pijul_status', {})
  assert.deepEqual(
    { ok: value.ok, exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr },
    { ok: false, exitCode: 1, stdout: 'out', stderr: 'fatal: nope' },
  )
  const rendered = h.registered.get('pijul_status').output.render({}, value)
  assert.match(rendered[0].text, /\[pijul_status\] failed \(exit 1\)/)
  assert.match(rendered[0].text, /fatal: nope/)
})

test('a timed-out run is not ok', async () => {
  const h = harness({ onExecute: async () => ({ exitCode: null, timedOut: true, stdout: '', stderr: '' }) })
  const value = await call(h, 'pijul_clone', { remote: 'https://example.com/r.git' })
  assert.equal(value.ok, false)
  assert.equal(value.timedOut, true)
})

test('an aborted run is not ok', async () => {
  const h = harness({ onExecute: async () => ({ exitCode: null, aborted: true }) })
  const value = await call(h, 'pijul_status', {}, { signal: { aborted: true } })
  assert.equal(value.ok, false)
  assert.equal(value.aborted, true)
  assert.match(h.registered.get('pijul_status').output.render({}, value)[0].text, /aborted/)
})

test('a missing pijul binary surfaces the preamble message', async () => {
  const h = harness({
    onExecute: async () => ({ exitCode: 127, stderr: 'pijul binary not found on PATH' }),
  })
  const value = await call(h, 'pijul_log', {})
  assert.equal(value.ok, false)
  assert.equal(value.exitCode, 127)
  assert.match(value.stderr, /not found on PATH/)
})

test('an infrastructure failure is captured, not thrown', async () => {
  const h = harness({ onExecute: async () => { throw new Error('spawn EAGAIN') } })
  const value = await call(h, 'pijul_status', {})
  assert.equal(value.ok, false)
  assert.equal(value.exitCode, null)
  assert.match(value.stderr, /^pijul_status failed: spawn EAGAIN$/)
})

test('the binary config key pins an absolute executable', async () => {
  const h = harness({ config: { binary: '/opt/pijul/bin/pijul' } })
  await call(h, 'pijul_log', {})
  assert.match(h.specs[0].command, /^PIJUL_BIN='\/opt\/pijul\/bin\/pijul'$/m)
})

test('an empty binary config falls back to PATH lookup', async () => {
  const h = harness({ config: { binary: '' } })
  await call(h, 'pijul_log', {})
  assert.match(h.specs[0].command, /^PIJUL_BIN=pijul$/m)
})

test('the preamble defaults the SSH agent socket', async () => {
  const h = harness()
  await call(h, 'pijul_identity', {})
  assert.match(h.specs[0].command, /export SSH_AUTH_SOCK="\$\{SSH_AUTH_SOCK:-\$HOME\/\.ssh\/agent\.sock\}"/)
})

test('network operations declare a long timeout budget', async () => {
  const h = harness({ maxTimeoutMs: 3600000 })
  await call(h, 'pijul_clone', { remote: 'ssh://host/repo' })
  await call(h, 'pijul_push', {})
  await call(h, 'pijul_pull', {})
  assert.equal(h.specs[0].timeoutMs, 600000)
  assert.equal(h.specs[1].timeoutMs, 600000)
  assert.equal(h.specs[2].timeoutMs, 600000)
  // Local-only tools keep the executor default.
  await call(h, 'pijul_status', {})
  assert.equal(h.specs[3].timeoutMs, 120000)
})

test('push and pull are non-interactive by default and opt out explicitly', async () => {
  const a = harness()
  await call(a, 'pijul_push', { remote: 'ssh://host/repo' })
  assert.match(a.specs[0].command, /push --all 'ssh:\/\/host\/repo'$/)

  const b = harness()
  await call(b, 'pijul_pull', { all: false })
  assert.match(b.specs[0].command, /"\$PIJUL_BIN" pull$/)

  const c = harness()
  await call(c, 'pijul_push', { fromChannel: 'dev', toChannel: 'main' })
  assert.match(c.specs[0].command, /push --all --from-channel 'dev' --to-channel 'main'$/)
})

test('channel actions map onto pijul subcommands', async () => {
  const cases = [
    ['list', {}, /"\$PIJUL_BIN" channel$/],
    ['new', { name: 'dev' }, /channel new 'dev'$/],
    ['switch', { name: 'dev' }, /channel switch 'dev'$/],
    ['delete', { name: 'dev' }, /channel delete 'dev'$/],
    ['fork', { name: 'dev2' }, /"\$PIJUL_BIN" fork 'dev2'$/],
  ]
  for (const [action, extra, pattern] of cases) {
    const h = harness()
    await call(h, 'pijul_channel', { action, ...extra })
    assert.match(h.specs[0].command, pattern, action)
  }
})

test('remote actions map onto pijul subcommands', async () => {
  const list = harness()
  await call(list, 'pijul_remote', {})
  assert.match(list.specs[0].command, /"\$PIJUL_BIN" remote$/)

  const setDefault = harness()
  await call(setDefault, 'pijul_remote', { action: 'default', remote: 'ssh://host/repo' })
  assert.match(setDefault.specs[0].command, /remote default 'ssh:\/\/host\/repo'$/)

  const remove = harness()
  await call(remove, 'pijul_remote', { action: 'delete', remote: 'ssh://host/repo' })
  assert.match(remove.specs[0].command, /remote delete 'ssh:\/\/host\/repo'$/)
})

test('diff, reset, change, unrecord and apply build the documented argv', async () => {
  const diff = harness()
  await call(diff, 'pijul_diff', { paths: ['src', 'a.txt'] })
  assert.match(diff.specs[0].command, /"\$PIJUL_BIN" diff 'src' 'a\.txt'$/)

  const reset = harness()
  await call(reset, 'pijul_reset', { dryRun: true, files: ['a.txt'] })
  assert.match(reset.specs[0].command, /"\$PIJUL_BIN" reset --dry-run 'a\.txt'$/)

  const change = harness()
  await call(change, 'pijul_change', { hash: 'ABCD' })
  assert.match(change.specs[0].command, /"\$PIJUL_BIN" change 'ABCD'$/)

  const unrecord = harness()
  await call(unrecord, 'pijul_unrecord', { hashes: ['AAAA', 'BBBB'] })
  assert.match(unrecord.specs[0].command, /"\$PIJUL_BIN" unrecord 'AAAA' 'BBBB'$/)

  const applyTool = harness()
  await call(applyTool, 'pijul_apply', { hashes: ['AAAA'] })
  assert.match(applyTool.specs[0].command, /"\$PIJUL_BIN" apply 'AAAA'$/)
})

test('init and clone do not cd into a repository first', async () => {
  const init = harness()
  await call(init, 'pijul_init', { path: 'fresh' })
  assert.doesNotMatch(init.specs[0].command, /^cd /m)
  assert.match(init.specs[0].command, /"\$PIJUL_BIN" init 'fresh'$/)

  const clone = harness()
  await call(clone, 'pijul_clone', { remote: 'ssh://host/repo', dest: 'here' })
  assert.doesNotMatch(clone.specs[0].command, /^cd /m)
  assert.match(clone.specs[0].command, /"\$PIJUL_BIN" clone 'ssh:\/\/host\/repo' 'here'$/)
})
