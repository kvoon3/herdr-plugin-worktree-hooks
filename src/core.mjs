// Event-payload parsing, config discovery, idempotency state, command runner,
// and the built-in auto-install fallback for projects without herdr-worktree.yaml.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseYaml } from './yaml.mjs'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function log(message) {
  process.stderr.write(`[worktree-hooks] ${message}\n`)
}

// HERDR_PLUGIN_EVENT_JSON shape (verified on herdr 0.9.5):
// { event: "worktree_removed", data: { type, workspace: { worktree: { repo_root, ... } }, worktree: { path, branch, ... } } }
// On worktree.removed the checkout is already deleted and data.workspace is
// optional (the workspace may be gone), so repo_root can be missing there.
export function eventFacts(env) {
  let payload = {}
  try {
    payload = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON || '{}')
  } catch {
    // Fall through with empty facts; the handler logs and bails.
  }
  const data = payload.data ?? payload
  const workspace = data.workspace ?? {}
  const worktree = data.worktree ?? workspace.worktree ?? {}
  return {
    worktreePath: worktree.checkout_path ?? worktree.path ?? null,
    branch: worktree.branch ?? null,
    repoRoot: workspace.worktree?.repo_root ?? worktree.repo_root ?? null,
    repoName: workspace.worktree?.repo_name ?? worktree.repo_name ?? null,
  }
}

// Main checkout for $MAIN: the payload carries repo_root on created events; the
// git fallback also covers opened events and tests that fake the payload.
export function mainCheckoutOf(worktreePath, repoRoot) {
  if (repoRoot) return path.resolve(repoRoot)
  const res = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  })
  if (res.status === 0 && res.stdout.trim()) return path.dirname(res.stdout.trim())
  return null
}

const CONFIG_NAMES = ['herdr-worktree.yaml', 'herdr-worktree.yml']

// The worktree's own copy wins (a branch can change its hooks); the main
// checkout is the fallback for configs that are not committed yet.
export function findConfig(worktreePath, mainCheckout) {
  const bases = mainCheckout && mainCheckout !== worktreePath ? [worktreePath, mainCheckout] : [worktreePath]
  for (const base of bases) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(base, name)
      if (existsSync(file)) return file
    }
  }
  return null
}

function commandList(value, field, source) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new ConfigError(`${source}: hooks.${field} must be a list of shell commands`)
  return value.map((cmd) => {
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new ConfigError(`${source}: hooks.${field} entries must be non-empty strings`)
    }
    return cmd
  })
}

function rejectUnknownKeys(obj, allowed, where, source) {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k))
  if (unknown.length) {
    throw new ConfigError(`${source}: unknown ${where} key(s) ${unknown.map((k) => `"${k}"`).join(', ')}; allowed: ${allowed.join(', ')}`)
  }
}

// Schema: { autoInstall?: boolean, hooks?: { created?: string[], opened?: string[], removed?: string[] } }
export function validateWorktreeConfig(parsed, source) {
  if (parsed == null) return { autoInstall: false, hooks: { created: [], opened: [], removed: [] } }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${source}: root must be a mapping`)
  }
  rejectUnknownKeys(parsed, ['autoInstall', 'hooks'], 'config', source)
  const { autoInstall = false, hooks = {} } = parsed
  if (typeof autoInstall !== 'boolean') throw new ConfigError(`${source}: autoInstall must be true or false`)
  if (typeof hooks !== 'object' || hooks == null || Array.isArray(hooks)) {
    throw new ConfigError(`${source}: hooks must be a mapping with created/opened/removed lists`)
  }
  rejectUnknownKeys(hooks, ['created', 'opened', 'removed'], 'hooks', source)
  return {
    autoInstall,
    hooks: {
      created: commandList(hooks.created, 'created', source),
      opened: commandList(hooks.opened, 'opened', source),
      removed: commandList(hooks.removed, 'removed', source),
    },
  }
}

export function loadConfig(file) {
  const parsed = parseYaml(readFileSync(file, 'utf8'))
  return validateWorktreeConfig(parsed, path.basename(file))
}

// --- run-once claims: atomic mkdir keyed by checkout path, survives restarts ---

function stateDir(env) {
  return env.HERDR_PLUGIN_STATE_DIR || path.join(tmpdir(), 'herdr-worktree-hooks')
}

function keyOf(p) {
  return createHash('sha1').update(path.resolve(p)).digest('hex')
}

export function claim(env, checkoutPath) {
  const dir = path.join(stateDir(env), 'claims')
  mkdirSync(dir, { recursive: true })
  try {
    mkdirSync(path.join(dir, keyOf(checkoutPath)))
    return true
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
}

export function release(env, checkoutPath) {
  rmSync(path.join(stateDir(env), 'claims', keyOf(checkoutPath)), { recursive: true, force: true })
}

// --- main-checkout memory: created/opened resolve $MAIN while the checkout
// exists; by the time worktree.removed fires the checkout is deleted and the
// payload's workspace block may be gone, so remember the answer and read it
// back at removal time.

function mainsDir(env) {
  return path.join(stateDir(env), 'mains')
}

export function rememberMain(env, checkoutPath, mainPath) {
  if (!mainPath) return
  try {
    mkdirSync(mainsDir(env), { recursive: true })
    writeFileSync(path.join(mainsDir(env), keyOf(checkoutPath)), path.resolve(mainPath), 'utf8')
  } catch (e) {
    log(`could not remember main checkout for ${checkoutPath}: ${e.message}`)
  }
}

export function recallMain(env, checkoutPath) {
  try {
    const main = readFileSync(path.join(mainsDir(env), keyOf(checkoutPath)), 'utf8').trim()
    return main && existsSync(main) ? main : null
  } catch {
    return null
  }
}

export function forgetMain(env, checkoutPath) {
  rmSync(path.join(mainsDir(env), keyOf(checkoutPath)), { force: true })
}

// Run commands sequentially in a shell; stop at the first failure.
export function runCommands(commands, { cwd, extra, log: emit }) {
  for (const cmd of commands) {
    emit(`$ ${cmd}`)
    const res = spawnSync(cmd, {
      shell: true,
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...extra },
    })
    if (res.error) {
      emit(`failed to run: ${cmd} (${res.error.message})`)
      return false
    }
    if (res.status !== 0) {
      emit(`exit ${res.status}: ${cmd}`)
      return false
    }
  }
  return true
}

function commandAvailable(cmd) {
  return spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0
}

// Built-in fallback for repos without herdr-worktree.yaml: install JS deps with
// the toolchain the lockfile (or vite-plus) points at. No-ops when there is
// nothing to install.
export function autoInstall(worktreePath, emit = log) {
  if (!existsSync(path.join(worktreePath, 'package.json'))) {
    emit('no package.json, nothing to install')
    return true
  }
  if (existsSync(path.join(worktreePath, 'node_modules'))) {
    emit('node_modules already present, skipping install')
    return true
  }
  const pkg = readFileSync(path.join(worktreePath, 'package.json'), 'utf8')
  let cmd = null
  if (commandAvailable('vp') && pkg.includes('"vite-plus"')) cmd = 'vp install'
  else if (existsSync(path.join(worktreePath, 'pnpm-lock.yaml'))) cmd = 'pnpm install'
  else if (existsSync(path.join(worktreePath, 'yarn.lock'))) cmd = 'yarn install'
  else if (existsSync(path.join(worktreePath, 'bun.lockb')) || existsSync(path.join(worktreePath, 'bun.lock'))) cmd = 'bun install'
  else if (existsSync(path.join(worktreePath, 'package-lock.json'))) cmd = 'npm install'
  if (!cmd) {
    emit('no recognized lockfile, skipping install')
    return true
  }
  return runCommands([cmd], { cwd: worktreePath, extra: { EVENT: 'install' }, log: emit })
}
