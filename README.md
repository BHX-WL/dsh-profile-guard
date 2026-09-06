# dsh-profile-guard

Install-crash insurance for the dsh CLI plugin path.

`guard` is a small CLI that keeps a snapshot of a dsh profile's healthy state **outside the profile**, and rolls the profile back automatically when a plugin install breaks the host boot. It covers the one path neither dshmarket nor dsh-desktop protects: installing plugins straight into a profile through the CLI (`dsh plugin add`, npm).

It is a plain Node script. It does not depend on dsh-desktop, it does not modify the dsh host, and it never installs itself into a profile's bundles.

## Why

Two plugin-install accidents — both on the CLI direct-install path — broke the host boot and reset a profile to its default bundles; the CLI install path keeps no snapshot of its own, so recovering meant rebuilding the pre-crash manifest by hand.

## Install

Requires Node >= 20.

**npm global install** — puts the `guard` command on your PATH:

```sh
npm install -g dsh-profile-guard
```

**From a git clone** — no install step, run through Node:

```sh
git clone <this-repository> dsh-profile-guard
cd dsh-profile-guard
node lib/cli.js check
```

Both entry points are equivalent: every `guard <command>` below can also be run as `node lib/cli.js <command>` from a clone.

## Commands

Every command accepts `--profile <name>` (default: `web`).

| Command | What it does |
| --- | --- |
| `guard boot [--profile <name>] [-- <dsh args>]` | Start the dsh host under the guard: snapshot the current state, start the host, and mark the snapshot `healthy` when the boot succeeds. If a plugin-level failure breaks the boot, roll back to the latest healthy snapshot and start the host once more. |
| `guard snapshot [--profile <name>] [--reason "<note>"]` | Take a snapshot of the current profile state. Run it before you install a plugin. |
| `guard list [--profile <name>]` | List snapshots: id, time, reason, and state (`[healthy]` / `[pending]`). |
| `guard show <id> [--profile <name>]` | Show one snapshot's details: bundles, dependencies, hash. |
| `guard restore <id> [--no-auto-restart] [--profile <name>]` | Roll the profile back to a `healthy` snapshot. Stops the host on port 3080 if one is running; starts it again unless `--no-auto-restart` is given. |
| `guard check [--profile <name>]` | Read-only health check of the profile. Exit 0 = healthy, exit 1 = problems found. |
| `guard watch [--profile <name>]` | Resident auto-snapshot: watch `package.json` / `pnpm-lock.yaml` and snapshot automatically when they change. Stop with Ctrl+C or SIGTERM. |
| `guard preflight <pkg> [--force]` | Check a package before installing: refuses packages whose prod dependencies shadow the host @deepseek-ai namespace, or whose dsh engine requirements the host cannot meet. Exit 0 = safe, 1 = refused, `--force` overrides the core-shadow check. |
| `guard install <pkg> [--force] [--no-boot]` | Preflight → snapshot → `dsh plugin add` → activation: a plain-insert plugin is hot-mounted through the market toggle with no restart; any other shape, or a failed toggle, falls back to boot verification (auto-rollback on failure). One command, closed loop. |
| `guard hotmount <pkg> [--profile <name>]` | Hot-mount an already-installed plugin without a restart — install's post-add activation as a standalone command. Only plain-insert plugins qualify, and there is no restart fallback: an unsupported shape or a failed toggle exits 1 with the reason. |

Running `guard` with no arguments (or `guard help`) prints this usage.

Exit codes: `boot` 0 on success (already running is a success) / 1 on failure; `snapshot` and `list` 0; `show` 0 found / 1 not found / 2 usage error; `restore` 0 / 1 failure / 2 usage error; `check` 0 healthy / 1 unhealthy; `watch` exits 0 on Ctrl+C / SIGTERM; `preflight` 0 safe / 1 refused / 2 usage error; `install` 0 ok / 1 failed or refused / 2 usage error; `hotmount` 0 hot-mounted / 1 not installed, shape refused, or toggle failed / 2 usage error; an unknown command exits 2.

Note: `guard preflight` checks core-shadowing and the declared dsh engine requirement; peer-dependency compatibility is a future enhancement and is not checked yet.

## Snapshots

Snapshots live under the dsh **data root**, next to `profiles/`:

```text
$DSH_HOME/guards/<profile>/<snapshot-id>/
```

`DSH_HOME` is the dsh data root — the directory that contains `profiles/` and `guards/`. When it is not set, guard uses `<home>/.dsh` (for example `C:\Users\<you>\.dsh` on Windows), so the default location is `~/.dsh/guards/<profile>/`.

Each snapshot folder holds a copy of the profile's `package.json` (dependencies + `dsh.profile.bundles`), a `sentinel.json` (top-level `node_modules/@deepseek-ai` listing, the core-shadow guard), and a `meta.json` (id, createdAt, reason, dshVersion, healthy, hash). `node_modules` is not snapshotted — `pnpm install` rebuilds it.

- **Outside the profile**: snapshots sit under `guards/`, a sibling of `profiles/`, so a profile reset can never reach them.
- **Two states**: `pending` means the snapshot was just recorded and not yet verified; `healthy` means a boot succeeded in that state. `restore` refuses to roll back to anything but a `healthy` snapshot.
- **Retention**: the newest 5 snapshots are kept; set `DSH_GUARD_KEEP` to change the number.
- When a rollback happens, the current (broken) state is first backed up under `$DSH_HOME/guards/<profile>/crash/`, and a Chinese restore report is written to `$DSH_HOME/guards/<profile>/` (`restore-report-<timestamp>.md`, plus `last-report.md`).

## How this relates to dshmarket and dsh-desktop

Each tool protects its own install path, and they do not overlap:

| Path | Protected by |
| --- | --- |
| dshmarket UI / marketplace installs | dshmarket's own snapshot, rollback and deep compatibility checks |
| dsh-desktop workshop operations | dsh-desktop's own backup-before-every-operation and auto-restore on a failed restart |
| **CLI direct installs** (`dsh plugin add`, npm into a profile) | **`guard`** — this tool |

`guard` only reads and writes `$DSH_HOME/guards/<profile>/` and the profile's own `package.json`. It never touches dshmarket's or dsh-desktop's state, so the three run side by side without interfering.

## Host contract compatibility

guard runs **outside** the dsh host: no lib file imports a host runtime package, so an official host update cannot break guard through an import mismatch — the failure mode that breaks plugins living inside the host. What guard does rely on is a small set of disk/CLI contract points: the host boot marker, the boot-failure texts, the `dsh plugin` CLI shape, and the profile manifest schema. Three rules keep those points from going stale silently:

- **Zero runtime coupling.** No lib file imports any `@deepseek-ai/*` module. guard reads the host only from the outside — it resolves the installed dsh bin, reads its version, and reads profile manifests. When the host is missing or unreadable, guard degrades to the checks it can still prove locally and reports the host version as unknown rather than guessing.
- **Contract constants are env-overridable.** The marker and failure-text constants live in a single module, `lib/contract.js`, and each one can be overridden with an environment variable — `DSH_GUARD_BOOT_MARKER`, `DSH_GUARD_AUTH_MARKER`, `DSH_GUARD_NO_OPEN`, `DSH_GUARD_FAIL_TEXT`. If an official update renames a marker or a failure text, adapting is a configuration change, not a code change. The market hot-mount toggle keys live in the same module and stay env-overridable the same way — `DSH_GUARD_MARKET_BASE`, `DSH_GUARD_MARKET_TOGGLE_PATH`, `DSH_GUARD_MARKET_ORIGIN`.
- **No silent degradation.** guard never guesses on a contract point it cannot confirm: a profile manifest that cannot be read is reported as a problem, never treated as healthy; a boot failure whose log shows no known plugin-failure text is **not** auto-rolled back — guard reports the failure without rolling back (a wrong rollback is worse than a missed one); and every preflight warning and refusal is printed, never swallowed.

## Safety

- `guard` reads and writes only `$DSH_HOME/guards/` and the target profile's `package.json`. Everything else is read-only.
- Snapshots and reports contain no credentials: free-text fields in restore reports are scrubbed (tokens, authorization headers, cookies, passwords) before they reach disk.
- When `guard` stops the host it only kills processes on port 3080 whose command line carries a dsh marker (`dsh`, `bin.js`, `deepseek`) — never an unrelated process squatting on the port.
- `guard boot` and `guard restore` stop and start your **real** dsh host (port 3080). Run them only when you can accept a host restart — for example during an idle desktop window — and never from inside a session that the host itself serves.
- Everything stays on your machine and no external network request is made, except for `guard preflight` and `guard install`, which fetch the package manifest from the npm registry (`guard install` also runs `dsh plugin add`, which downloads and installs the package). Hot-mounting is loopback-only: `guard install` may POST to the local dsh-market toggle at `http://127.0.0.1:3080` to activate a plain-insert plugin without a restart, and `guard hotmount` does the same on demand.

## Tests

```sh
npm test
```

`npm test` runs `node --test test/**/*.test.js`. Every test uses a temporary `DSH_HOME` and never touches a real profile.

## Smoke test (verifying an install)

Run against a real profile when the host is idle:

```sh
guard check --profile web
guard snapshot --profile web --reason "first smoke"
guard list --profile web
guard preflight dsh-better-edit --profile web
guard preflight @deepseek-ai/dsh-tools --profile web
guard hotmount dsh-better-edit --profile web
```

`guard check` prints `profile web: healthy`, or the concrete problems found; `guard snapshot` prints the id it created; `guard list` then shows that snapshot as `[pending]` with the note `(first smoke)`.

`guard preflight` checks a package against the host before anything is installed: `guard preflight dsh-better-edit --profile web` prints `guard: preflight ok for dsh-better-edit (host <version>)` and exits 0 (its prod dependencies do not shadow the host `@deepseek-ai` namespace and its dsh engine requirements are met, or none are declared); `guard preflight @deepseek-ai/dsh-tools --profile web` exits 1 — `@deepseek-ai/dsh-tools` is itself a core package, so installing it as a plugin would shadow the host `@deepseek-ai` namespace.

`guard hotmount dsh-better-edit --profile web` runs the hot-mount toggle against the real market: when the market accepts it, guard prints `hot-mounted dsh-better-edit` and exits 0; a plugin that is not installed, or whose patch is not plain insert, exits 1 with the reason on stderr. Toggling a plugin that is already live is an idempotent no-op, so this is a safe command to try on a real profile — but it really POSTs to the local market at `127.0.0.1:3080`, so run it during an idle desktop window. Prefix it with `DSH_GUARD_DRY_HOTMOUNT=1` to see `[dry] would hot-mount dsh-better-edit` without making the request.

`guard install <pkg>` and `guard boot` are intentionally not listed here: `guard install` really runs `dsh plugin add` and installs the package, then activates it — a plain-insert plugin is hot-mounted through the market toggle with no restart, and anything else boot-verifies the new plugin, which may stop and restart your real host; `guard boot` restarts the host by definition. Run them yourself, during an idle desktop window, and never from inside a session that the host serves.

## License

MIT
