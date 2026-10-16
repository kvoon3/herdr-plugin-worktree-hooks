import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYaml, YamlError } from '../src/yaml.mjs'
import { validateWorktreeConfig } from '../src/core.mjs'

const SAMPLE = `
# comment at the top
autoInstall: false
hooks:
  created:
    - vp install
    - cp "$MAIN/.env" .env   # trailing comment
  opened:
    - echo 'it''s open'
  removed:
    - docker compose -p "$REPO_NAME-$BRANCH" down
`

test('parses sample config with comments, quotes, and booleans', () => {
  const cfg = validateWorktreeConfig(parseYaml(SAMPLE), 'herdr-worktree.yaml')
  assert.equal(cfg.autoInstall, false)
  assert.deepEqual(cfg.hooks.created, ['vp install', 'cp "$MAIN/.env" .env'])
  assert.deepEqual(cfg.hooks.opened, ["echo 'it''s open'"])
  assert.deepEqual(cfg.hooks.removed, ['docker compose -p "$REPO_NAME-$BRANCH" down'])
})

test('empty config means no hooks and no auto-install', () => {
  assert.deepEqual(validateWorktreeConfig(parseYaml(''), 'c'), {
    autoInstall: false,
    hooks: { created: [], opened: [], removed: [] },
  })
  assert.deepEqual(validateWorktreeConfig(null, 'c'), {
    autoInstall: false,
    hooks: { created: [], opened: [], removed: [] },
  })
})

test('typo in keys is rejected with allowed keys named', () => {
  assert.throws(() => validateWorktreeConfig(parseYaml('hook:\n  created:\n    - x\n'), 'c'), /unknown config key/)
  assert.throws(() => validateWorktreeConfig(parseYaml('hooks:\n  creatd:\n    - x\n'), 'c'), /unknown hooks key/)
  assert.throws(
    () => validateWorktreeConfig(parseYaml('hooks:\n  removd:\n    - x\n'), 'c'),
    /unknown hooks key.*created, opened, removed/,
  )
})

test('non-string commands are rejected', () => {
  assert.throws(() => validateWorktreeConfig(parseYaml('hooks:\n  created:\n    - 1\n'), 'c'), /non-empty strings/)
})

test('tab indentation is rejected with a line number', () => {
  try {
    parseYaml('hooks:\n\tcreated:\n')
    assert.fail('expected YamlError')
  } catch (e) {
    assert.ok(e instanceof YamlError)
    assert.match(e.message, /line 2/)
  }
})

test('flow collections are rejected', () => {
  assert.throws(() => parseYaml('hooks: {created: [x]}'), /flow collections/)
})
