# claude-seatbelt

Run `claude` on the host under [Anthropic's sandbox-runtime][srt] with settings
controlled via environment variables. Only compatible with macOS for the moment.

[srt]: https://github.com/anthropics/sandbox-runtime

- **network** — denied, except a built-in list of the domains Claude itself needs
  plus anything in `CSB_EXTRA_DOMAINS`, reached through srt's proxies. srt also
  refuses any name that resolves to loopback, link-local, one of this host's own
  interface addresses, or a cloud metadata endpoint.
- **read** — the workspace, plus the paths Claude needs. The rest of `$HOME`,
  `/Users` and `/Volumes` are denied.
- **write** — the workspace, except `.git`, plus the caches and tmp directories
  Claude's tooling needs.
- **terminal** — pty access is allowed (srt's `allowPty`). Claude is a TUI, and
  without it `setRawMode` fails with `EPERM`, so it never receives a keystroke.

The workspace is `$CSB_WORKSPACE`, or the current directory when that is unset or
empty. Claude starts there either way.

## Requirements

Node >= 20.11, and `npx` on `PATH`. sandbox-runtime itself needs no installing —
`npx` fetches it.

## Install

    pnpm install          # also builds, via the prepare script
    pnpm link --global    # puts `claude-seatbelt` on PATH

## Usage

    cd /path/to/repo && claude-seatbelt [claude args...]
    CSB_WORKSPACE=/path/to/repo claude-seatbelt [claude args...]

### Without installing

`pnpm start` runs it straight from the checkout, building first:

    pnpm start [claude args...]

One catch: `pnpm run` always executes in the package root, whatever directory you
typed it in, so the workspace is this repo rather than where you are. That is
what you want when working on claude-seatbelt itself; point it anywhere else with
`CSB_WORKSPACE`:

    CSB_WORKSPACE=/path/to/repo pnpm start [claude args...]

## Configuration

| Variable             | Default | Meaning |
| -------------------- | ------- | ------- |
| `CSB_WORKSPACE`      | the current directory | The one writable directory, and where Claude is started. Empty falls back to the default; a path that does not exist, or is not a directory, is refused. |
| `CSB_EXTRA_DOMAINS`  | empty   | Space-separated domains to allow **on top of** the built-in list below. `.example.com` is the host and all subdomains; `example.com` is that host exactly. |
| `CSB_EXTRA_READ`     | empty   | Space-separated absolute paths to additionally open for reading. |
| `CSB_EXTRA_WRITE`    | empty   | Space-separated absolute paths to additionally open for writing. |
| `CSB_CLAUDE`         | `claude` from `PATH` | Which `claude` to run. Used verbatim, so it may be any executable. |
| `CSB_SRT_VERSION`    | `latest` | Which sandbox-runtime version `npx` fetches. Set a release (e.g. `0.0.76`) to pin it. |
| `TMPDIR`             | `/tmp`  | Where the generated settings file is written, and one of the writable paths inside the sandbox. |
| `HOME`               | — | Read to locate the config and cache paths listed under **read** above. |
| `PATH`               | — | Searched for `claude`, `srt` and `npx`. |

### Domains

Two layers. The built-in list is what Claude itself needs to hold a session, is
always allowed, and is not configurable — without it there is nothing to sandbox:

`api.anthropic.com`, `platform.claude.com`, `claude.com`, `claude.ai`,
`mcp-proxy.anthropic.com`, `downloads.claude.ai`

Everything a *project* needs goes in `CSB_EXTRA_DOMAINS`, so the reach granted to a
workspace is a deliberate per-workspace decision rather than a default everyone
inherits.

An empty `CSB_EXTRA_DOMAINS` is fine and means exactly that: no additions. It is not
a way to switch the network off — the built-in list still applies.

Entries containing `*` are refused, as are TLD-wide entries like `.com` and
anything without a dot. Use the leading dot for subdomains. One bad entry stops
the run rather than being skipped.

### Ports

An srt allowlist entry without a `:port` suffix matches every port, so an
allowlisted host could be reached on 22. Each entry is therefore emitted twice,
as `:80` and `:443`. If you need an allowlisted host on another port, that is the
loop to change.

## Running several at once

Concurrent instances in different directories are fine, and nothing needs to be
configured for it. Each run gets:

- its own settings file, in a `mktemp` directory removed on exit;
- its own proxies. srt binds ephemeral port 0 and bakes the kernel-assigned port
  into that instance's sandbox profile, so there is no fixed port to collide over.

## Known gap

`allowAppleEvents: false` does not stop `osascript` from driving an application
that is already running.

Anything that application can do is outside the sandbox. `open` **is** blocked, so
an application that is not already running cannot be launched. This is upstream
behaviour in sandbox-runtime, not something this tool configures away.

`tests/escape.test.ts` asserts the gap as it actually behaves, so it is reported
on every run. If it ever closes, that test fails — which is the cue to promote it
to a real denial assertion and delete this section.

A fix for this is pending upstream: https://github.com/anthropics/sandbox-runtime/pull/557

## Development

    pnpm start         # build, then run it on this repo
    pnpm build         # tsc -> dist/
    pnpm typecheck     # tsc --noEmit, src and tests
    pnpm lint          # oxlint
    pnpm lint:fix      # oxlint --fix
    pnpm format        # oxfmt, rewrites in place
    pnpm format:check  # oxfmt --check, rewrites nothing
    pnpm check         # typecheck + lint + format:check, the one to run in CI

## Tests

    pnpm test   # builds first, then runs

Behaviour tests only. Each one runs the real entry point with `CSB_CLAUDE=/bin/sh`
and asserts what the sandboxed process can actually reach — nothing inspects the
generated settings file. A domain being absent from an allowlist is not the claim;
the sandboxed process failing to reach it is.

| file | asks |
| ---- | ---- |
| `tests/network.test.ts` | what the sandboxed process can reach: exact vs subdomain entries, lookalike suffixes, non-443 ports, proxy bypass, raw TCP, DNS, LAN addresses |
| `tests/filesystem.test.ts` | what it can read and write: workspace, siblings, `.git`, `$HOME`, `CSB_EXTRA_READ` |
| `tests/escape.test.ts` | whether it can get another process to act for it |
| `tests/startup.test.ts` | configurations that must stop it running at all |
