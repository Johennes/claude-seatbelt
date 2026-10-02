[![Lint](https://github.com/Johennes/claude-seatbelt/actions/workflows/lint.yml/badge.svg)](https://github.com/Johennes/claude-seatbelt/actions/workflows/lint.yml)
[![Tests](https://github.com/Johennes/claude-seatbelt/actions/workflows/test.yml/badge.svg)](https://github.com/Johennes/claude-seatbelt/actions/workflows/test.yml)

# claude-seatbelt

Run `claude` on the host under [Anthropic's sandbox-runtime][srt] with settings
controlled via environment variables. Only compatible with macOS for the moment.

[srt]: https://github.com/anthropics/sandbox-runtime

- **execution** — denied. Nothing runs but the shells and the `claude` binary
  itself, plus whatever a profile or `CSB_EXTRA_EXEC` names. Listed under
  [Execution](#execution).
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

Node >= 20.11. sandbox-runtime is a pinned dependency. srt has no execution
policy of its own, so this tool drives it as a library and writes the exec
allowlist into the Seatbelt profile srt builds. See [Execution](#execution).

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
| `CSB_WORKSPACE`      | the current directory | The repository being worked on, opened for reading and writing, and where Claude is started. Empty falls back to the default. Refused: a path that does not exist or is not a directory, and one that is, or holds, a region denied for reading — `/`, `$HOME`, `/Users`, `/Volumes`, `/Library` — since otherwise the workspace would be opened as a whole. |
| `CSB_EXTRA_DOMAINS`  | empty   | Space-separated domains to allow **on top of** the built-in list below. `.example.com` is the host and all subdomains; `example.com` is that host exactly. |
| `CSB_EXTRA_READ`     | empty   | Colon-separated paths to additionally open for reading, `PATH`-style so that a path may hold a space. Absolute, or under `~/`. |
| `CSB_EXTRA_WRITE`    | empty   | Colon-separated paths to additionally open for writing, likewise. |
| `CSB_EXTRA_EXEC`     | empty   | Colon-separated paths to additionally allow **executing**. Absolute, under `~/`, or under `./` for the workspace. A trailing `/**` takes the whole tree below a directory. See [Execution](#execution). |
| `CSB_PROFILES`       | empty   | Space-separated profile names, applied in the order given. See [Profiles](#profiles). |
| `CSB_UNSET_ENV`      | empty   | Space-separated names of environment variables to withhold from the sandboxed process. Everything else is inherited. See [Environment](#environment). |
| `CSB_CLAUDE`         | `claude` from `PATH` | Which `claude` to run: an absolute path, one under `~/`, or a bare name to find on `PATH`. May be any executable, and is allow-listed for execution automatically. Refused: a relative path, which the allowlist could not name and which would run from wherever the wrapper was started, and anything that is not an executable file. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | **Required.** How Claude authenticates, the keychain being denied. See [Authentication](#authentication). |
| `TMPDIR`             | `/tmp`  | One of the writable paths inside the sandbox. |
| `HOME`               | — | Read to locate the config and cache paths listed under **read** above. |
| `PATH`               | — | Searched for `claude`, and for `$SHELL` when that is a bare name. Relative entries — `.`, or an empty one — are skipped because they resolve against the workspace. |
| `SHELL`              | — | Allow-listed for execution, being the shell Claude runs a command with. A bare name is resolved on `PATH`. See [Execution](#execution). |

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

An entry is a host name: two or more labels of letters, digits and inner hyphens,
so an IPv4 address passes. Anything else is refused — `*`, a port, a path,
TLD-wide entries like `.com`, anything without a dot — and one bad entry stops
the run rather than being skipped. Use the leading dot for subdomains. Case does
not matter.

### Ports

An srt allowlist entry without a `:port` suffix matches every port, so an
allowlisted host could be reached on 22. Each entry is therefore emitted twice,
as `:80` and `:443`. If you need an allowlisted host on another port, that is the
loop to change.

### Execution

Nothing runs unless it is named. Seatbelt checks `process-exec` on every
`execve`, in the sandboxed process and in every descendant of it, so this is a
boundary rather than a convention: a denied binary fails with `Operation not
permitted` and exit status 126.

sandbox-runtime has no setting for this — it emits a blanket `(allow
process-exec)` — so claude-seatbelt drives srt as a library, takes the Seatbelt
profile it builds, and appends the rules below to it. The last matching rule in
a Seatbelt profile wins, so they override srt's. If the profile ever comes back
in a shape those rules cannot be appended to, the run is refused rather than
started without them.

Allowed before any profile is selected:

| | |
| --- | --- |
| `/bin/bash` | The shell srt starts inside the sandbox, which then starts Claude, and what Claude falls back to for a command when `$SHELL` is unset. |
| `$SHELL` | This account's login shell, which is the one Claude runs a command with. When it is unset or names nothing, Claude falls back to `/bin/bash`, which is on the list anyway. |
| `~/.local/share/claude/versions/**` | The native installer's layout: one directory per installed version, so an update does not lock you out. Claude's bundled `rg` is the same binary under another `argv[0]`. |
| `$CSB_CLAUDE` | Whatever you pointed the tool at, and what that resolves to. When it is a script rather than a binary — an npm or Homebrew install of Claude is `#!/usr/bin/env node` — the interpreter its shebang names as well, and for `env` also what `env` finds on `PATH`. |

Entries are paths, or globs over paths:

| form | means |
| ---- | ----- |
| `/usr/bin/git` | That binary. |
| `~/.nvm/versions/node/**` | Everything below that directory. |
| `./node_modules/**` | The same, taken from the workspace. |
| `./**/node_modules/**` | A `**` anywhere spans directories, so this reaches a monorepo's `packages/*/node_modules` as well as the root's. |
| `./packages/*/node_modules/**` | `*` and `?` stop at a slash. |

Those three characters are the whole glob language; `[`, `{` and `}` are
refused rather than passed through as literals that could never match.

A path is emitted twice: as written, and as it resolves through symlinks. A glob
is emitted once, as written — a pattern has no real path to resolve — and is
matched against the path the kernel arrived at, so a glob over a symlinked
directory has to be written for where the symlink points.
Seatbelt matches the path the kernel arrived at, so a Homebrew command — a
symlink into its Cellar — would otherwise be denied under the name you typed.
Shims that are not symlinks have to be named in full: `/usr/bin/git` re-execs the
real git under `/Library/Developer`, and that second exec is checked in its own
right.

What this is not:

- **Not a limit on an allow-listed interpreter.** `bash`, `python3`, `node`,
  `perl` and `awk` run whatever they are given. Allow-listing one is the decision
  that code in that language may run at all; what bounds it from there is the
  filesystem and domain policy, not this list.
- **Not a limit on shell builtins.** `echo`, `cd`, redirection, loops and
  `read` never exec, so they always work. `bash` can open a socket with
  `/dev/tcp/host/port` without exec'ing anything — still bounded by the domain
  allowlist, so it reaches no further than `curl` would have.
- **Not a content check.** `sh script.sh` runs the script, because the binary
  that starts is `sh`. What the allowlist stops is `./script.sh`, where the
  script itself is the thing being executed.

The workspace is writable, so nothing in it is executable by default: a binary
Claude fetched or a script it just wrote is denied. Grant what a repository needs
with `./`-prefixed entries, the [node-modules-exec](#node-modules-exec) profile
for its installed tools, or [workspace-exec](#workspace-exec) for the lot.

### Environment

The sandboxed process inherits the whole environment of whatever started
`claude-seatbelt`: `PATH`, the OAuth token, and every other variable exported in
that shell.

`CSB_UNSET_ENV` names the variables to withhold:

    CSB_UNSET_ENV="AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY NPM_TOKEN" claude-seatbelt

Each name goes into srt's settings as a `credentials.envVars` entry with
`mode: "deny"`, and srt unsets it in the sandboxed process.

Names only, no patterns. A name that is not set is no error. A name that a
selected profile lists under `requiredEnv` is refused.

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
| `~/.claude` | Claude's own configuration: settings, agents, commands, skills, etc. Also the transcripts, todos and memory of **every** project, and `history.jsonl`, so a session in one repository can read what was said in another. |
| `~/.claude.json`, `~/.claude.json.lock`, `~/.claude.json.tmp.*` | The account record, the MCP server definitions and the per-project history (all read at startup) and the associated lock and temporary files. |
| `~/.gitconfig` | Git identity, aliases, includes and the credential helper, read by every git invocation. |
| `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` | The shell startup files, sourced whenever a command is run. Without them the shell starts with neither `PATH` nor the rest of the environment you expect. |
| `~/.local/bin` | Where the native installer puts the `claude` symlink, alongside your other command line tools. |
| `~/.local/share/claude` | One directory per installed Claude version. Denying it leaves Claude unable to start. |
| `~/.local/state/claude` | Claude's runtime state, the lock files among it. |
| `~/.cache/claude` | Claude's own cache. |
| `~/Library/Preferences` | macOS preference plists, read on startup by the system libraries the native binary links against. Every application's plist comes with them, and some third-party applications keep tokens there. |
| `$CSB_EXTRA_READ` | Whatever else you ask for. |

Two of those grants are wider than they look:

- `~/.claude` is opened whole because Claude reads and writes throughout it, and
  no narrower grant survives contact with `--resume`, subagents and worktrees.
  Nothing said in one project is a secret from a session in another.
- `~/Library/Preferences` could not be narrowed usefully even if the set of plists
  the binary needs were known: srt's profile allows `user-preference-read`, so
  `defaults read <domain>` answers through `cfprefsd` for any domain, file grant
  or not. Writing preferences is denied.

Write is the other way round: denied by default, opened path by path, and then
closed again where an opened region contains something dangerous.

| Writable | Explanation |
| -------- | ----------- |
| the workspace | The repository being worked on, which is the point of the exercise. |
| `$TMPDIR` | Where Claude and the tools it runs put their scratch files. |
| `/private/tmp`, `/private/var/tmp` | The system temp directories, which `$TMPDIR` is not. `/tmp` resolves to the first of them and plenty of tools hardcode it. |
| `~/.claude` | Session transcripts, todos and project state, all written as Claude runs. |
| `~/.claude.json`, `~/.claude.json.lock`, `~/.claude.json.tmp.*` | Rewritten as projects are opened and trusted and as MCP servers are added. |
| `~/.cache/claude` | Claude's own cache. |
| `$CSB_EXTRA_WRITE` | Whatever else you ask for. |

Note that a write grant is not enough on its own inside `$HOME`, `/Users` or `/Volumes`.
The path has to be readable as well, or the lookup fails before the write is
attempted.

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
| `extraExec` | Appended to `CSB_EXTRA_EXEC`. Absolute, under `~/`, or under `./` for the workspace. |
| `denyWriteOverrides` | A map from a `denyWrite` entry to a replacement; an empty list drops it outright. This is sometimes required because `denyWrite` beats `allowWrite` in srt: a path this tool denies cannot be given back through `extraWrite` by anyone. A key that is not a current `denyWrite` entry is rejected. |
| `allowMachLookup` | XPC/Mach services to open, srt's `network.allowMachLookup`. |
| `requiredEnv` | Environment variables the tool needs, by name. They are inherited from the caller like everything else; naming them here turns a tool that misbehaves silently without its credential into a run that is refused. |

The shipped ones:

| profile | what it is for |
| ------- | -------------- |
| [unix](#unix) | The everyday command line toolbox. Start here. |
| [clipboard](#clipboard) | Copying out of the TUI. |
| [curl](#curl) | `curl`, against the allow-listed domains. |
| [gh](#gh) | The GitHub CLI, against the API. |
| [git](#git) | Running git at all. |
| [git-writable](#git-writable) | Letting git write to `.git`. |
| [node](#node) | Node toolchains installed under `$HOME`. |
| [node-modules-exec](#node-modules-exec) | The workspace's own installed tools. |
| [node-modules-writable](#node-modules-writable) | Tools that transpile into `node_modules`. |
| [workspace-exec](#workspace-exec) | Anything in the workspace. |

### unix

The everyday commands — `ls`, `cat`, `grep`, `sed`, `awk`, `find`, `sort`,
`diff`, `tar` and the rest of that toolbox:

    CSB_PROFILES="unix" claude-seatbelt

Execution is denied by default, so without this profile or something like it a
session has shell builtins and very little else.

The list is in `profiles.jsonc`. What is deliberately **not** in it:

- **No interpreters.** `python3`, `perl`, `ruby` and `node` are not here.
- **No network tools.** `curl` has its [own profile](#curl); `nc`, `ssh` and
  `scp` have none.
- **No compilers, no package managers, no `sudo`, no `osascript`, no `open`.**

`xargs`, `env` and `find -exec` are in it, and none of them widens anything: the
command each of those starts is checked against the allowlist in its own right.

### clipboard

Makes copying out of the TUI work, by opening one Mach service and the two
commands that talk to it:

    CSB_PROFILES="clipboard" claude-seatbelt

| | |
| --- | --- |
| `com.apple.pasteboard.1` | The pasteboard server, which `pbcopy` and `pbpaste` talk to. Without it `pbcopy` exits 1. |
| `/usr/bin/pbcopy`, `/usr/bin/pbpaste` | The commands themselves, which are on no other list. |

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

### curl

`curl`, from `/usr/bin` or from Homebrew:

    CSB_PROFILES="curl" claude-seatbelt

Being able to start it changes nothing about where it can go: every request still
goes through srt's proxy and is still bounded by the domain allowlist. The
profile exists because `curl` is a fetch tool rather than a text tool, and that
is worth selecting on purpose.

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
| `/opt/homebrew/bin/gh`, `/usr/local/bin/gh` | Permission to run it, on both Homebrew prefixes. `gh pr checkout` and friends shell out to git, so select [git](#git) beside this one for those. |
| `GH_TOKEN` | Required. The run is refused if it is unset or empty. |
| `com.apple.trustd.agent` | `gh` is a Go binary, and Go on macOS verifies TLS through the Security framework rather than a CA bundle, so without this every request fails with `x509: OSStatus -26276`. srt warns that trustd is an exfiltration path in its own right — one that does not go through the proxy, and so is not bounded by the domain allowlist. |

### git

Permission to run git at all — `status`, `log`, `diff`, `show`, `blame`:

    CSB_PROFILES="git" claude-seatbelt

Writing to `.git` remains denied — that is [git-writable](#git-writable) — and so does reaching a remote, which is the network policy rather than this one.

What it names:

| | |
| --- | --- |
| `/usr/bin/git` | The shim, which is not a symlink. |
| `/Library/Developer/CommandLineTools/usr/bin/git`, the Xcode path beside it | What that shim re-execs. Naming only the shim stops git at its second exec. |
| the `libexec/git-core` trees | git dispatches subcommands to its own helper binaries — `git-remote-https` for a fetch, `git-sh-setup` for the shell-based ones. |
| `/bin/sh`, and `basename` `cat` `expr` `find` `sed` `sort` `uname` `wc` | Some of those helpers are shell scripts, `git-submodule` among them, so `git submodule status` is an exec of `/bin/sh` and of what `git-sh-setup` and `git-submodule` run on their way to `git submodule--helper`. Exactly those eight. The heavier scripts — `git-filter-branch`, `git-subtree`, `git-mergetool` — want the rest of the toolbox, which is [unix](#unix). |
| `/opt/homebrew/bin/git`, `/usr/local/bin/git` and their `git-core` | Homebrew's git, which takes precedence on `PATH` where it is installed. |

### git-writable

Opens `.git` for writing, so `git add`, `git commit`, `git branch`, `git stash`
and `git rebase` work in the workspace. Select it beside [git](#git), which is
what makes the binary runnable in the first place:

    CSB_PROFILES="git git-writable" claude-seatbelt

The base policy's `**/.git` is dropped. Instead, the profile puts back the names
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

With nvm, select [unix](#unix) beside it. `nvm.sh`, sourced from the shell rc
file, resolves the version to put on `PATH` by running `awk`, `grep`, `sort`,
`tr`, `cut`, `head`, `tail`, `wc` and `ls` — none of which this profile grants —
and without them the shell starts with no `node` on `PATH` at all:

    CSB_PROFILES="unix node" claude-seatbelt

The profile opens the version manager roots for **reading**:

| | |
| --- | --- |
| `~/.nvm`, `~/.config/nvm` | nvm, in both places it puts itself. |
| `~/.nodenv` | nodenv, whose shims/ dispatch to versions/<version>. |
| `~/.local/share/pnpm`, `~/Library/pnpm` | A standalone `pnpm` install, wherever `PNPM_HOME` points. |
| `~/.npm-global`, `~/.npm-packages` | The two conventional homes for an npm prefix moved out of `/usr/local`, which is where `npm install -g pnpm` then puts it. |
| `~/.cache/node` | Corepack's download cache, which holds the `pnpm` and `yarn` it dispatches to. |

and the same roots for **execution**, plus the pieces a shim needs on the way:

| | |
| --- | --- |
| the version manager trees | Whole trees rather than the handful of names in each `bin/`: a version manager holds one per installed version, and a globally installed package puts its entry point in there beside node. |
| `/usr/bin/env` | A shebang is an exec of its own, and `#!/usr/bin/env node` is what npm, npx, pnpm and most installed tools start with. |
| `/usr/bin/dirname`, `basename`, `readlink`, `sed`, `uname` | What the shell shims in a `node_modules/.bin` write themselves out of. Deny them and the shim computes its paths from an empty string rather than failing outright. |
| Homebrew's `node`, `npm`, `npx`, `pnpm`, `yarn` | For an installation that uses no version manager at all. |

node is an interpreter, so this is not a list of what may run: it is the decision
that JavaScript may run, with the filesystem and the domain allowlist as the
boundary that remains.

- **No `~/.npmrc`.** That is where a registry auth token lives, and neither
  linting nor formatting needs one. Add it yourself if you use a private
  registry, knowing that it hands Claude that token.
- **No network, and no write outside the workspace.** So `pnpm install` is not
  covered: it needs `registry.npmjs.org` in `CSB_EXTRA_DOMAINS` and a writable
  store. Run installs outside the sandbox and let Claude use what is already in
  `node_modules`.
- **The workspace's own tools do not run yet.** `pnpm test` reaches for
  `node_modules/.bin`, which is in the workspace and therefore denied. That is
  [node-modules-exec](#node-modules-exec).
- **`node_modules` stays read-only.** A toolchain that writes into it needs
  [node-modules-writable](#node-modules-writable) selected as well.

### node-modules-exec

Lets the workspace's own installed tools run, which is what `pnpm test`, `npm
run` and `pnpm exec` reach for:

    CSB_PROFILES="node node-modules-exec" claude-seatbelt

The grant is `./**/node_modules/**`, not `./node_modules/.bin`. Every name in
`.bin` resolves into the package that provides it — with pnpm, another level down
again under `.pnpm` — and Seatbelt matches the path the kernel arrived at. At any
depth, because a pnpm, npm or yarn workspace keeps a `node_modules` per package,
and `pnpm --filter app test` runs the one under `packages/app`.

This is a grant over files a dependency update rewrites without anyone reading
them. It is what running a repository's tests costs, and it is a separate profile
so that it is chosen rather than inherited.

### node-modules-writable

Drops the base policy's `**/node_modules` deny, at any depth:

    CSB_PROFILES="node node-modules-writable" claude-seatbelt

This is required when using Vite which transpiles its own config into
`node_modules/.vite-temp` before it can read it, and fails with `EPERM` otherwise.
srt cannot deny a path inside a region it has opened, so nothing narrower than the
whole of `node_modules` is expressible and the deny has to go entirely. A fix is
pending upstream: https://github.com/vitejs/vite/pull/23544

### workspace-exec

Opens the whole workspace for execution — `./gradlew`, `./scripts/build.sh`, a
checked-in binary:

    CSB_PROFILES="workspace-exec" claude-seatbelt

The workspace is the one place Claude can write, so this says that whatever it
puts there may also be run: a script written this minute, or a binary fetched
from an allow-listed host. What that code can then reach is still the filesystem
and domain policy and nothing more, but the exec allowlist stops being a list at
this point.

Prefer a narrower `./`-prefixed entry where one will do:

    CSB_EXTRA_EXEC="./gradlew:./scripts/**" claude-seatbelt

## Running several at once

Concurrent instances in different directories are fine, and nothing needs to be
configured for it. Each run gets:

- its own policy, held in the process rather than written anywhere;
- its own proxies. srt binds ephemeral port 0 and bakes the kernel-assigned port
  into that instance's sandbox profile, so there is no fixed port to collide over.

## Known gaps

### Writable Claude state that the host reads back

Two writable paths carry over into the next un-sandboxed `claude` run:

- `~/.claude.json` holds the user-scope MCP server definitions, which the host
  Claude starts without asking. It has to stay writable: Claude rewrites it on
  every start and as projects are opened and trusted.
- `~/.claude/projects/<project>/memory/` is loaded into sessions of *that*
  project. Every project's directory is writable, not only the workspace's own,
  because the transcripts and todos beside them are written as Claude runs.

### Apple Events, if you allow-list osascript

**This one is a complete escape, not a corner case.** `allowAppleEvents: false`
does not stop `osascript` from driving an application that is already running,
and the terminal that launched `claude-seatbelt` is, by definition, running. One
`osascript -e 'tell application "Terminal" to do script "…"'` runs a command in a
new tab of that terminal: outside the sandbox, as you, with your whole
environment and file system. iTerm2 and the other scriptable terminals are no
different. The same goes for any other scriptable application that happens to be
open.

What stands in front of it is the [exec allowlist](#execution): `osascript` is on
no shipped profile, so it does not start. `open` is denied twice over — by the
allowlist, and by srt's Apple Events policy, which is what makes it useless even
when allow-listed.

So this is a gap in what the *sandbox* enforces rather than in what this tool
permits. Putting `osascript` on the allowlist hands it back whole, which is a
reason not to, and a reason to treat a request to allow it as the sandbox asking
to be let out.

`tests/escape.test.ts` asserts both halves: denied by default, and still able to
drive a running application once allow-listed. If the second ever closes, that
test fails — which is the cue to promote it to a real denial assertion and delete
this subsection.

A fix for this is pending upstream: https://github.com/anthropics/sandbox-runtime/pull/557

### An allow-listed interpreter is not a list

`python3`, `node`, `bash` and `awk` run whatever they are handed. Selecting
[node](#node) is the decision that JavaScript may run, not a decision about which
JavaScript. The exec allowlist bounds *which programs start*; what one of them
then does is bounded by the filesystem and domain policy alone.

The same applies to a grant over a tree: [node-modules-exec](#node-modules-exec)
covers files that arrive with a dependency update, and
[workspace-exec](#workspace-exec) covers anything Claude writes.

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

    pnpm test               # unit tests; also running on the CI
    pnpm test:integration   # integration tests; only run on a real machine

Behaviour tests only. Each one runs the real entry point with `CSB_CLAUDE=/bin/sh`
and asserts what the sandboxed process can actually reach — not what the policy
says. A domain being absent from an allowlist is not the claim; the sandboxed
process failing to reach it is. The policy printed at startup is there to be
read, and is deliberately not what these assert against: a rule can be present
and still not bite.

Fixtures go under `~/.cache/claude-seatbelt/test.XXXXXX`, one directory per run,
removed on exit. Under `$HOME` on purpose: that is where a directory beside the
workspace is denied for reading, which several probes rely on, and where
repositories live in practice. The `node` profile tests use this repository
itself as the workspace, and leave their scratch file in the gitignored
`.testenv/`.

| file | asks |
| ---- | ---- |
| `tests/network.test.ts` | what the sandboxed process can reach: exact vs subdomain entries, lookalike suffixes, non-443 ports, proxy bypass, raw TCP, DNS, LAN addresses |
| `tests/filesystem.test.ts` | what it can read and write: workspace, siblings, `.git`, `$HOME`, the keychains, the files `~/.claude.json` is rewritten through, `CSB_EXTRA_READ` |
| `tests/exec.test.ts` | what it can start: an allow-listed binary, the same one through a shell and through a shell below that, a binary copied into the workspace, a symlinked entry, a subtree entry, `./` entries, a shebang script |
| `tests/escape.test.ts` | whether it can get another process to act for it |
| `tests/startup.test.ts` | configurations that must stop it running at all |
| `tests/profiles.test.ts` | what selecting `clipboard`, `gh`, `git`, `git-writable`, `node-modules-exec` or `node-modules-writable` adds, and what it still does not — each probe paired with the same one unselected, and the pairs that are meant to be combined |
| `tests/integration/filesystem.test.ts` | that `~/.claude.json` and `~/.cache/claude` are readable and writable, which needs a Claude that has run here |
| `tests/integration/profiles.test.ts` | what `gh` does with `~/.config/gh`, and what `node` does with a pnpm it reaches: on `PATH`, `pnpm lint` running, the formatter writing, `node_modules` still closed |

Every test sets `CSB_EXTRA_EXEC` to the toolbox its probes are built from. Without
it a probe would report "denied" because `cat` could not start, whatever the
policy under test says.
