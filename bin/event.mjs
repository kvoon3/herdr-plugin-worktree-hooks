#!/usr/bin/env node
// Event hook for worktree.created / worktree.opened. Runs the matching repo's
// herdr-worktree.yaml hooks; repos without the config get the built-in
// auto-install. `created` runs once per checkout (claim in the plugin state
// dir, released on failure so a re-create retries); `opened` fires on every
// open, so its hooks must be idempotent.
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  autoInstall,
  claim,
  eventFacts,
  findConfig,
  forgetMain,
  loadConfig,
  log,
  mainCheckoutOf,
  recallMain,
  rememberMain,
  release,
  runCommands,
} from '../src/core.mjs'

const env = process.env
const event = env.HERDR_PLUGIN_EVENT || ''

function hookExtra(facts, main, configFile, name) {
  return {
    WORKTREE: facts.worktreePath,
    MAIN: main ?? '',
    REPO_NAME: facts.repoName ?? '',
    BRANCH: facts.branch ?? '',
    EVENT: name,
    HOOKS_CONFIG: configFile ?? '',
  }
}

function resolveContext(env, facts, { fallbackToRemembered = false } = {}) {
  const main = mainCheckoutOf(facts.worktreePath, facts.repoRoot) ?? (fallbackToRemembered ? recallMain(env, facts.worktreePath) : null)
  const configFile = findConfig(facts.worktreePath, main)
  return { main, configFile }
}

function handleCreated() {
  const facts = eventFacts(env)
  if (!facts.worktreePath) return log('created: no worktree path in payload')

  // Claim before anything else so duplicate deliveries run the hooks once.
  if (!claim(env, facts.worktreePath)) {
    return log(`created: already handled, skipping ${facts.worktreePath}`)
  }

  const { main, configFile } = resolveContext(env, facts)
  rememberMain(env, facts.worktreePath, main)
  if (!configFile) {
    log(`no herdr-worktree.yaml in ${facts.worktreePath}${main ? ` or ${main}` : ''}, using built-in auto-install`)
    if (!autoInstall(facts.worktreePath)) release(env, facts.worktreePath)
    return
  }

  log(`config: ${configFile}`)
  let config
  try {
    config = loadConfig(configFile)
  } catch (e) {
    log(`config error: ${e.message}`)
    release(env, facts.worktreePath)
    return
  }

  if (config.autoInstall && !autoInstall(facts.worktreePath)) {
    release(env, facts.worktreePath)
    return
  }
  if (!config.hooks.created.length) return log('no created hooks configured, nothing to run')

  const ok = runCommands(config.hooks.created, {
    cwd: facts.worktreePath,
    extra: hookExtra(facts, main, configFile, 'created'),
    log,
  })
  if (!ok) release(env, facts.worktreePath)
}

function handleOpened() {
  const facts = eventFacts(env)
  if (!facts.worktreePath) return log('opened: no worktree path in payload')

  const { main, configFile } = resolveContext(env, facts)
  rememberMain(env, facts.worktreePath, main)
  if (!configFile) {
    log(`no herdr-worktree.yaml in ${facts.worktreePath}${main ? ` or ${main}` : ''}, checking built-in auto-install`)
    autoInstall(facts.worktreePath)
    return
  }

  log(`config: ${configFile}`)
  let config
  try {
    config = loadConfig(configFile)
  } catch (e) {
    return log(`config error: ${e.message}`)
  }

  if (config.autoInstall && !existsSync(path.join(facts.worktreePath, 'node_modules'))) autoInstall(facts.worktreePath)
  if (!config.hooks.opened.length) return log('no opened hooks configured, nothing to run')

  runCommands(config.hooks.opened, {
    cwd: facts.worktreePath,
    extra: hookExtra(facts, main, configFile, 'opened'),
    log,
  })
}

function handleRemoved() {
  const facts = eventFacts(env)
  if (!facts.worktreePath) return log('removed: no worktree path in payload')

  // Release first so a same-path re-create racing these hooks can claim freely.
  release(env, facts.worktreePath)

  // The checkout is already deleted; resolve $MAIN from the payload, else from
  // what created/opened remembered.
  const { main, configFile } = resolveContext(env, facts, { fallbackToRemembered: true })
  forgetMain(env, facts.worktreePath)
  if (!main) {
    return log(`removed: cannot resolve main checkout for ${facts.worktreePath}, skipping removed hooks`)
  }
  if (!existsSync(main)) {
    return log(`removed: main checkout ${main} is gone, skipping removed hooks`)
  }
  if (!configFile) {
    return log(`removed: no herdr-worktree.yaml in ${main}, nothing to run`)
  }

  log(`config: ${configFile}`)
  let config
  try {
    config = loadConfig(configFile)
  } catch (e) {
    return log(`config error: ${e.message}`)
  }
  if (!config.hooks.removed.length) return log('no removed hooks configured, nothing to run')

  runCommands(config.hooks.removed, {
    cwd: main,
    extra: {
      ...hookExtra(facts, main, configFile, 'removed'),
      REPO_NAME: facts.repoName ?? path.basename(main),
    },
    log,
  })
}

try {
  if (event.includes('removed')) handleRemoved()
  else if (event.includes('opened')) handleOpened()
  else handleCreated()
} catch (e) {
  log(`error: ${e.message}`)
  process.exit(1)
}
