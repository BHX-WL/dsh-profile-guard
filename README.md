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

Running `guard` with no arguments (or `guard help`) prints this usage.

Exit codes: `boot` 0 on success (already running is a success) / 1 on failure; `snapshot` and `list` 0; `show` 0 found / 1 not found / 2 usage error; `restore` 0 / 1 failure / 2 usage error; `check` 0 healthy / 1 unhealthy; `watch` exits 0 on Ctrl+C / SIGTERM; an unknown command exits 2.

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

## Safety

- `guard` reads and writes only `$DSH_HOME/guards/` and the target profile's `package.json`. Everything else is read-only.
- Snapshots and reports contain no credentials: free-text fields in restore reports are scrubbed (tokens, authorization headers, cookies, passwords) before they reach disk.
- When `guard` stops the host it only kills processes on port 3080 whose command line carries a dsh marker (`dsh`, `bin.js`, `deepseek`) — never an unrelated process squatting on the port.
- `guard boot` and `guard restore` stop and start your **real** dsh host (port 3080). Run them only when you can accept a host restart — for example during an idle desktop window — and never from inside a session that the host itself serves.
- Pure local tool: it makes no network requests.

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
```

`guard check` prints `profile web: healthy`, or the concrete problems found; `guard snapshot` prints the id it created; `guard list` then shows that snapshot as `[pending]` with the note `(first smoke)`.

`guard boot` — which restarts the real host — is intentionally not listed here: run it yourself, during an idle desktop window, and never from inside a session that the host serves.

## License

MIT
