# herdr-plugin-worktree-hooks

Run a repo's `herdr-worktree.yaml` hooks when a [Herdr](https://herdr.dev)
worktree workspace of that repo is **created**, **opened**, or **removed**.
Repos without the config fall back to auto-installing JS dependencies.

Zero dependencies (plain Node ESM). Needs Node ≥ 18 on Herdr's PATH.

## Install

```sh
herdr plugin install kvoon3/herdr-plugin-worktree-hooks
```

Local development: `herdr plugin link ./herdr-plugin-worktree-hooks`.

## Config

Drop a `herdr-worktree.yaml` (or `.yml`) at the repo root:

```yaml
autoInstall: false        # optional: also run the built-in dependency install
hooks:
  created:                # once per new worktree, inside the worktree
    - vp install
    - cp "$MAIN/.env" .env
  opened:                 # every open; keep idempotent
    - echo ready
  removed:                # after the checkout is deleted; runs inside $MAIN
    - docker compose -p "$REPO_NAME-$BRANCH" down
```

Commands run sequentially in a shell and stop at the first failure.

| Variable        | Value                                        |
| -------------- | -------------------------------------------- |
| `$WORKTREE`    | the worktree checkout                        |
| `$MAIN`        | the repo's main checkout                     |
| `$REPO_NAME`   | repository name                              |
| `$BRANCH`      | worktree branch                              |
| `$EVENT`       | `created`, `opened`, `removed`, or `install` |
| `$HOOKS_CONFIG`| matched config file path                     |

## Semantics

- The worktree's own config wins over the main checkout's, so uncommitted
  configs and per-branch hooks work.
- `created` runs once per checkout; a failed run retries on the next event,
  and delete + re-create runs it again.
- `opened` and `removed` run every time — keep them idempotent.
- `removed` runs in `$MAIN` with `$WORKTREE` pointing at the deleted path.
- Config errors are logged with a line number; nothing runs.
- Without a config (or with `autoInstall: true`), JS dependencies are
  installed by lockfile: `vp install` for vite-plus projects, otherwise
  `pnpm` / `yarn` / `bun` / `npm`.

## Debug

```sh
herdr plugin log list --plugin kvoon.worktree-hooks
```

## Development

```sh
node --test
```

Tested against Herdr 0.9.5. [MIT](./LICENSE)
