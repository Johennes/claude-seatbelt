[![Lint](https://github.com/Johennes/claude-seatbelt/actions/workflows/lint.yml/badge.svg)](https://github.com/Johennes/claude-seatbelt/actions/workflows/lint.yml)
[![Tests](https://github.com/Johennes/claude-seatbelt/actions/workflows/test.yml/badge.svg)](https://github.com/Johennes/claude-seatbelt/actions/workflows/test.yml)

# claude-seatbelt

Run `claude` on the host under [Anthropic's sandbox-runtime][srt] with settings
controlled via environment variables. Only compatible with macOS for the moment.

[srt]: https://github.com/anthropics/sandbox-runtime

- **network** — denied, except a built-in list of the domains Claude itself needs
  plus anything in `CSB_EXTRA_DOMAINS`, reached through srt's proxies. srt also
  refuses any name that resolves to loopback, link-local, one of this host's own
  interface addresses, or a cloud metadata endpoint. Listed under
  [Domains](#domains).
- **read** — the workspace, plus the paths Claude needs. The rest of `$HOME`,
  `/Users` and `/Volumes` are denied. Listed under [Paths](#paths).
- **write** — the workspace, except `.git`, plus the caches and tmp directories
  Claude's tooling needs. Listed under [Paths](#paths).
- **profiles** — named bundles of additions for different use cases, in a JSON
  file. Listed under [Profiles](#profiles).

The workspace is `$CSB_WORKSPACE`, or the current directory when that is unset or
empty. Claude starts there either way.

## Requirements

Node >= 20.11, and `npx` on `PATH`. sandbox-runtime itself needs no installing —
`npx` fetches it.

A `CLAUDE_CODE_OAUTH_TOKEN`, which is mandatory. See [Authentication](#authentication).

## Install

    pnpm install          # also builds, via the prepare script
    pnpm link --global    # puts `claude-seatbelt` on PATH

## Authentication

The sandbox denies the macOS keychain, so Claude cannot reach the credentials a
normal `claude login` leaves there. Supply a long-lived OAuth token instead.

Create one **outside** the sandbox, once:

    claude setup-token

That runs the browser flow and prints a token. Put it in the environment of
whatever starts `claude-seatbelt`:

    export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-…'

Better, keep it out of your shell profile and out of your history by reading it
back from somewhere at call time — for instance from the host keychain, which is
denied inside the sandbox but is still yours outside it:

    security add-generic-password -a "$USER" -s claude-seatbelt -w
    # Paste the token

    export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -a "$USER" -s claude-seatbelt -w)

Without the token, the run is refused before srt is ever started. The token is
passed through to Claude unchanged.

Two consequences worth knowing:

- The token is long-lived — roughly a year — and does not rotate. Anything that
  can read the environment of the sandboxed process can use it.
- `git`'s `credential.helper = osxkeychain` cannot work inside the sandbox. It
  rarely comes up, because no forge host is in the allowlist to begin with:
  `push`, `fetch`, `pull` and `clone` have nowhere to go, with or without a
  credential. Should you open one with `CSB_EXTRA_DOMAINS`, put an HTTPS token in
  a file the sandbox can reach through `CSB_EXTRA_READ` and point a different
  helper at it. SSH remotes are not an alternative: allowlist entries are emitted
  on ports 80 and 443 only, so port 22 is unreachable for every host.

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
| `CSB_PROFILES`       | empty   | Space-separated profile names, applied in the order given. See [Profiles](#profiles). |
| `CSB_CLAUDE`         | `claude` from `PATH` | Which `claude` to run. Used verbatim, so it may be any executable. |
| `CSB_SRT_VERSION`    | `latest` | Which sandbox-runtime version `npx` fetches. Set a release (e.g. `0.0.76`) to pin it. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | **Required.** How Claude authenticates, the keychain being denied. See [Authentication](#authentication). |
| `TMPDIR`             | `/tmp`  | Where the generated settings file is written, and one of the writable paths inside the sandbox. |
| `HOME`               | — | Read to locate the config and cache paths listed under **read** above. |
| `PATH`               | — | Searched for `claude`, `srt` and `npx`. |

### Domains

Two layers. The built-in list is what Claude itself needs to hold a session, is
always allowed, and is not configurable — without it there is nothing to sandbox:

| domain | why |
| ------ | --- |
| `api.anthropic.com` | The Messages API. Every request to the model goes here, so nothing works without it. |
| `claude.com` | The OAuth authorize endpoint, `/cai/oauth/authorize`, which is where logging in starts. |
| `claude.ai` | The subscription side of the same account: the client metadata for that OAuth flow, the usage and settings pages Claude links to, and the `/code/…` endpoints behind artifacts and routines. |
| `platform.claude.com` | The console side, where the OAuth flow lands instead for an API-billed account, along with credits, billing and the API documentation. |
| `mcp-proxy.anthropic.com` | The proxy for remote MCP connectors. Without it, a connector configured on the account cannot be reached. |
| `downloads.claude.ai` | Release metadata under `/claude-code-releases`, and the official plugin marketplace beneath it. Self-updating is off — the spawn sets `DISABLE_AUTOUPDATER=1` — but plugin installs still come from here. |

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

### Paths

Read is allow-by-default in srt, so the home directory and the other user data
roots are denied as whole regions and then re-opened path by path:

| Denied for reading | Explanation |
| ------------------ | ----------- |
| `$HOME` | This user's home, resolved through symlinks so that a `HOME` outside `/Users` is covered too. |
| `/Users` | Every other account's home, and `/Users/Shared` with it. |
| `/Volumes` | External disks, network shares and mounted images, any of which can carry a second home directory. |
| `/Library/Keychains` | The system keychains. Unlike this user's keychain, they sit outside all three regions above, and `System.keychain` is mode 0644. |

Everything outside those four stays readable, which is why `/usr`, `/opt` and
`/Applications` need no entry. Re-opened inside them:

| Readable | Explanation |
| -------- | ----------- |
| the workspace | The repository being worked on. |
| `~/.claude` | Claude's own configuration: settings, agents, commands, skills, etc. |
| `~/.claude.json` | The account record, the MCP server definitions and the per-project history, all read at startup. |
| `~/.gitconfig` | Git identity, aliases, includes and the credential helper, read by every git invocation. |
| `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` | The shell startup files, sourced whenever a command is run. Without them the shell starts with neither `PATH` nor the rest of the environment you expect. |
| `~/.local/bin` | Where the native installer puts the `claude` symlink, alongside your other command line tools. |
| `~/.local/share/claude` | One directory per installed Claude version. Denying it leaves Claude unable to start. |
| `~/.local/state/claude` | Claude's runtime state, the lock files among it. |
| `~/.cache/claude` | Claude's own cache. |
| `~/Library/Preferences` | macOS preference plists, read on startup by the system libraries the native binary links against. |
| `$CSB_EXTRA_READ` | Whatever else you ask for. |

Write is the other way round: denied by default, opened path by path, and then
closed again where an opened region contains something dangerous.

| Writable | Explanation |
| -------- | ----------- |
| the workspace | The repository being worked on, which is the point of the exercise. |
| `$TMPDIR` | Where Claude and the tools it runs put their scratch files. |
| `/private/tmp`, `/private/var/tmp` | The system temp directories, which `$TMPDIR` is not. `/tmp` resolves to the first of them and plenty of tools hardcode it. |
| `~/.claude` | Session transcripts, todos and project state, all written as Claude runs. |
| `~/.claude.json` | Updated in place as projects are opened and MCP servers are added. |
| `~/.claude.json.backup` | The copy Claude writes beside it before rewriting the config. |
| `~/.cache/claude` | Claude's own cache. |
| `$CSB_EXTRA_WRITE` | Whatever else you ask for. |

| Denied for writing | Explanation |
| ------------------ | ----------- |
| `**/.git` | Git metadata, anywhere below the workspace. |
| `~/.claude/settings.json` | The host-side settings, which grant permissions and can name hooks. |
| `**/.claude/settings.json`, `**/.claude/settings.local.json` | The project-side settings, anywhere below the workspace, which do the same. |
| `~/.claude/CLAUDE.md` | The user-level memory file, loaded into every host session. |
| `~/.claude/skills` | User-level skills, offered to every host session and able to carry scripts. |
| `~/.claude/hooks` | Hook scripts, which the host Claude runs outside the sandbox. |
| `~/.claude/plugins` | Plugin code, which the host Claude loads and runs the same way. |
| `**/node_modules` | Installed packages, at any depth in the workspace. |
| `**/.env`, `**/.env.local`, `**/.env.*.local` | Environment files, read by the host toolchain. |

Note that a pattern starting `**/` is relative, and srt resolves it against its
working directory.

srt's own mandatory deny list already blocks writes to `.git/hooks`,
`.git/config`, `.gitconfig`, `.gitmodules`, the shell rc files, `.ripgreprc`,
`.mcp.json`, `.vscode/`, `.idea/`, `.claude/commands/` and `.claude/agents/`, so
those need no entry of their own. `CSB_EXTRA_WRITE` cannot reopen them either:
srt emits the allow rules first and its own denies last, and in a Seatbelt
profile the last matching rule wins.

## Profiles

A profile is a named bundle of additions for one tool, selected with
`CSB_PROFILES` and applied in the order you name them:

    CSB_PROFILES="gh" claude-seatbelt

A profile cannot close anything the base policy opens, cannot reach past srt's
own mandatory denies, and its domains go through the same grammar
`CSB_EXTRA_DOMAINS` does. It is otherwise additive, with one exception:
`denyWriteOverrides` can replace base entries from `denyWrite`. This is sometimes
required because srt gives `denyWrite` precedence over `allowWrite`.

They live in one file, `profiles.jsonc` beside the package.

| Key | Meaning |
| --- | ------- |
| `description` | One line, for whoever reads the file. Ignored otherwise. |
| `extraDomains` | Appended to `CSB_EXTRA_DOMAINS`. |
| `extraRead` | Appended to `CSB_EXTRA_READ`. Absolute, or under `~/`. |
| `extraWrite` | Appended to `CSB_EXTRA_WRITE`. Absolute, or under `~/`. |
| `denyWriteOverrides` | A map from a `denyWrite` entry to a replacement; an empty list drops it outright. This is sometimes required because `denyWrite` beats `allowWrite` in srt: a path this tool denies cannot be given back through `extraWrite` by anyone. A key that is not a current `denyWrite` entry is rejected. |
| `allowMachLookup` | XPC/Mach services to open, srt's `network.allowMachLookup`. |
| `requiredEnv` | Environment variables the tool needs, by name. They are inherited from the caller like everything else; naming them here turns a tool that misbehaves silently without its credential into a run that is refused. |

### clipboard

Makes copying out of the TUI work, by opening one Mach service:

    CSB_PROFILES="clipboard" claude-seatbelt

| | |
| --- | --- |
| `com.apple.pasteboard.1` | The pasteboard server, which `pbcopy` and `pbpaste` talk to. Without it `pbcopy` exits 1. |

**Try your terminal's OSC 52 setting first.** Claude emits `\x1b]52;c;<base64>`
down the pty alongside its `pbcopy` call, and that path needs nothing from the
sandbox. Terminals refuse it by default; turning it on is write-only and costs no
privilege at all:

| terminal | setting |
| --- | --- |
| iTerm2 | Settings → General → Selection → "Applications in terminal may access clipboard" |
| Ghostty | `clipboard-write = allow` |
| kitty | `clipboard_control write-clipboard write-primary` |
| WezTerm | on by default |
| Terminal.app | no OSC 52 support, so this profile is the only route |

What the profile costs, if you take it: the grant is two-way. `pbpaste` starts
working at the same moment, so whatever is on the host clipboard — a password
manager's last copy among it — is readable inside the sandbox, and
`api.anthropic.com` is open. srt warns separately that a Mach service is a
channel of its own, outside the proxy and so outside the domain allowlist.

### gh

Makes the GitHub CLI work against the REST and GraphQL API.

    export GH_TOKEN=$(gh auth token)      # outside the sandbox
    CSB_PROFILES="gh" claude-seatbelt

`gh` keeps its own token in the macOS keyring, which the sandbox denies, so the
token has to come in through `GH_TOKEN`. It is readable inside the sandbox — `gh
auth token`, `env`, anything Claude can run — so hand over as little as it can
do damage with: a **fine-grained personal access token**, scoped to the
repositories you want reachable, with `Contents: Read-only`.

This is especially important when this profile is combined with [git-writable](#git-writable).
Pushing is denied by the domain allowlist, but `api.github.com` stays open, and
`POST /repos/:owner/:repo/git/refs` with a write-capable token is a push by another
name — one that never runs `git push`. The token's scope is the only thing in front
of it.

`403` is the answer you want.

What the profile opens:

| | |
| --- | --- |
| `api.github.com` | REST and GraphQL. **Not** `github.com`, so the OAuth device flow (`github.com/login/device/code`) has nowhere to go and a *new* token cannot be minted inside the sandbox. `open` is blocked too, so no browser flow either. |
| `~/.config/gh` | `config.yml` and `hosts.yml`, which `gh` refuses to start without. Neither holds the token. |
| `GH_TOKEN` | Required. The run is refused if it is unset or empty. |
| `com.apple.trustd.agent` | `gh` is a Go binary, and Go on macOS verifies TLS through the Security framework rather than a CA bundle, so without this every request fails with `x509: OSStatus -26276`. srt warns that trustd is an exfiltration path in its own right — one that does not go through the proxy, and so is not bounded by the domain allowlist. |

### git-writable

Opens `.git` for writing, so `git add`, `git commit`, `git branch`, `git stash`
and `git rebase` work in the workspace:

    CSB_PROFILES="git-writable" claude-seatbelt

The base policy's `**/.git` is be dropped. Instead, the profile puts back the names
that matter, rather than the regions holding them, so that the index, objects and
refs beside them stay writable:

| Still denied | Why |
| --- | --- |
| `.git/hooks`, `.git/config` | srt's own mandatory denies, which no profile reaches past. A hook planted here runs on the host the next time git is invoked there. |
| `**/.git/modules/**/hooks`, `**/.git/modules/**/config` | A submodule's gitdir carries its own copy of both, at a path srt's two patterns do not cover. |
| `**/.git/worktrees/**/hooks` | A linked worktree's gitdir. Git reads hooks from the common directory rather than from here, so this is denied on principle rather than against a known path. |
| `**/.git/config.worktree`, and the same under `modules` and `worktrees` | Written by `git config --worktree`, and not matched by srt's `**/.git/config`. |

Committing to a submodule and `git worktree add` both keep working. One thing
does not: adding a worktree of a repository that *has* submodules, because the
checkout has to write `.gitmodules`, which is on srt's mandatory deny list.

#### How push is denied

Not by anything this profile does, but by the network policy it leaves alone:

- Over HTTPS, `git push` needs `github.com:443`. No forge host is in the built-in
  list, and the profile adds none, so srt's proxy refuses the connection.
- Over SSH it needs `github.com:22`. Every allowlist entry is emitted on ports 80
  and 443 only, so port 22 is unreachable for *any* host, allowlisted or not.
  `~/.ssh` is denied for reading anyway.
- The [gh](#gh) profile opens `api.github.com`, which serves no git endpoint.
  Combining the two does not give `git push` a route.

Filesystem and network are separate layers, and this profile only touches the
first one. Three consequences to accept before selecting it:

- **`fetch`, `pull` and `clone` are denied too**, for the same reason `push` is.
  This is local git only. Move branches in and out from outside the sandbox.
- **History is rewritable.** `commit --amend`, `reset --hard`, `rebase` and `gc`
  all work now, so unpushed work is destroyable. Denying push bounds that to your
  machine rather than your repository.
- **A gitdir does not have to be called `.git`.** Every hook deny above is by
  path, and a `.git` *file* holding `gitdir: ../elsewhere` points git at a
  directory no pattern covers, hooks and all. Writing that file is denied by the
  base policy and allowed by this profile, so the denies above stop git from
  planting a hook where git itself would put one — they are not a boundary
  against something that means it. What bounds that case is the rest of the
  policy: the workspace is the only writable place, and the network is shut.

Putting a forge host in `CSB_EXTRA_DOMAINS` undoes all of this at once. From
there only credentials stand between Claude and the remote, which is what the
token scope under [gh](#gh) is about.

### node

Enables running `pnpm` and `nvm` in the workspace, for instance:

    CSB_PROFILES="node" claude-seatbelt

The profile opens the version manager roots for **reading**:

| | |
| --- | --- |
| `~/.nvm`, `~/.config/nvm` | nvm, in both places it puts itself. |
| `~/.nodenv` | nodenv, whose shims/ dispatch to versions/<version>. |
| `~/.local/share/pnpm`, `~/Library/pnpm` | A standalone `pnpm` install, wherever `PNPM_HOME` points. |
| `~/.npm-global`, `~/.npm-packages` | The two conventional homes for an npm prefix moved out of `/usr/local`, which is where `npm install -g pnpm` then puts it. |
| `~/.cache/node` | Corepack's download cache, which holds the `pnpm` and `yarn` it dispatches to. |

- **No `~/.npmrc`.** That is where a registry auth token lives, and neither
  linting nor formatting needs one. Add it yourself if you use a private
  registry, knowing that it hands Claude that token.
- **No network, and no write outside the workspace.** So `pnpm install` is not
  covered: it needs `registry.npmjs.org` in `CSB_EXTRA_DOMAINS` and a writable
  store. Run installs outside the sandbox and let Claude use what is already in
  `node_modules`.
- **`node_modules` stays read-only.** A toolchain that writes into it needs
  [node-modules-writable](#node-modules-writable) selected as well.

### node-modules-writable

Drops the base policy's `**/node_modules` deny, at any depth:

    CSB_PROFILES="node node-modules-writable" claude-seatbelt

This is required when using Vite which transpiles its own config into
`node_modules/.vite-temp` before it can read it, and fails with `EPERM` otherwise.
srt cannot deny a path inside a region it has opened, so nothing narrower than the
whole of `node_modules` is expressible and the deny has to go entirely. A fix is
pending upstream: https://github.com/vitejs/vite/pull/23544

## Running several at once

Concurrent instances in different directories are fine, and nothing needs to be
configured for it. Each run gets:

- its own settings file, in a `mktemp` directory removed on exit;
- its own proxies. srt binds ephemeral port 0 and bakes the kernel-assigned port
  into that instance's sandbox profile, so there is no fixed port to collide over.

## Known gaps

### Writable Claude state that the host reads back

Two writable paths carry over into the next un-sandboxed `claude` run:

- `~/.claude.json` holds the user-scope MCP server definitions, which the host
  Claude starts without asking. It has to stay writable: Claude rewrites it in
  place on every start and as projects are opened.
- `~/.claude/projects/<project>/memory/` is loaded into sessions of *that*
  project. Every project's directory is writable, not only the workspace's own,
  because the transcripts and todos beside them are written as Claude runs.

### Apple Events

`allowAppleEvents: false` does not stop `osascript` from driving an application
that is already running.

Anything that application can do is outside the sandbox. `open` **is** blocked, so
an application that is not already running cannot be launched. This is upstream
behaviour in sandbox-runtime, not something this tool configures away.

`tests/escape.test.ts` asserts the gap as it actually behaves, so it is reported
on every run. If it ever closes, that test fails — which is the cue to promote it
to a real denial assertion and delete this subsection.

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
| `tests/filesystem.test.ts` | what it can read and write: workspace, siblings, `.git`, `$HOME`, the keychains, `CSB_EXTRA_READ` |
| `tests/escape.test.ts` | whether it can get another process to act for it |
| `tests/startup.test.ts` | configurations that must stop it running at all |
| `tests/profiles.test.ts` | what selecting `clipboard`, `gh`, `git-writable`, `node` or `node-modules-writable` adds, and what it still does not — each probe paired with the same one unselected, and the pairs that are meant to be combined |

Note that some tests are skipped when run under GitHub actions due to environment restrictions.
