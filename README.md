# herdr-plugin-worktree-setup

Run a repo's `herdr-worktree.yaml` hooks when a [Herdr](https://herdr.dev)
worktree workspace of that repo is **created** or **opened**. Repos without the
config fall back to auto-installing JS dependencies. Zero dependencies (plain
Node ESM), so `herdr plugin install` works with no build step.

Needs Node ≥ 18 on Herdr's PATH.

## Install

```sh
herdr plugin install kvoon3/herdr-plugin-worktree-setup
```

or, for local development:

```sh
git clone https://github.com/kvoon3/herdr-plugin-worktree-setup
herdr plugin link ./herdr-plugin-worktree-setup
```

## Config

Drop a `herdr-worktree.yaml` (or `.yml`) at the repo root:

```yaml
autoInstall: false        # optional: also run the built-in dependency install
hooks:
  created:                # once per new worktree, inside the worktree
    - vp install
    - cp "$MAIN/.env" .env
  opened:                 # every time the workspace is opened; keep idempotent
    - echo ready
```

Hook commands run sequentially in a shell inside the worktree and stop at the
first failure. Available environment:

| Variable       | Value                                   |
| -------------- | --------------------------------------- |
| `$WORKTREE`    | the worktree checkout                   |
| `$MAIN`        | the repo's main checkout                |
| `$REPO_NAME`   | repository name                         |
| `$BRANCH`      | worktree branch                         |
| `$EVENT`       | `created`, `opened`, or `install`       |
| `$HOOKS_CONFIG`| path of the matched config file         |

The worktree's own config wins over the main checkout's, so uncommitted
configs still work and branches can vary their hooks.

## Semantics

- `created` runs **once per checkout**: an atomic claim in the plugin state dir
  dedupes repeat deliveries and survives restarts. A failed run releases the
  claim so the next event retries. `worktree.removed` releases the claim, so
  deleting and re-creating the same branch runs the hooks again.
- `opened` runs on every open — the config author owns idempotency.
- Config errors (unknown keys, bad indentation, flow syntax) are logged with a
  line number and nothing runs.
- Built-in auto-install (no config, or `autoInstall: true`): vite-plus projects
  install via `vp install`, otherwise the toolchain is picked from the lockfile
  (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `package-lock.json`).

## Debug

```sh
herdr plugin log list --plugin kvoon.worktree-setup
```

## Development

```sh
node --test test/config.test.mjs
```

Tested against Herdr 0.9.5 (event payload shape verified against the Herdr
source). `worktree.removed` hooks — running cleanup commands on removal — are
not implemented yet; removal currently only releases the claim.

## License

[MIT](./LICENSE)
