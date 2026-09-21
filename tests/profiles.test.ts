import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

import {
  inHome,
  makeDir,
  repoRoot,
  type SandboxResult,
  sandboxProbe,
  sandboxRun,
  skipUnlessPresent,
  warnSkip,
  testTmp,
  writeFile,
} from "./helpers.ts";

const SENTINEL = "SENTINEL_RAN";
const workspace = makeDir("profiles-ws");

// A value, because the gh profile refuses to run without one. Nothing here
// authenticates against GitHub — CSB_CLAUDE is /bin/sh.
const token = { GH_TOKEN: "test-token" };

const ghConfigDir = inHome(".config", "gh");
const corepackCache = inHome(".cache", "node");

const run = (env: Record<string, string>, script = `echo ${SENTINEL}`) =>
  sandboxRun({ extraDomains: "", cwd: workspace, script, env });

/** The real path of the first `pnpm` on PATH, or undefined when there is none. */
function resolvePnpm(): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    try {
      return fs.realpathSync(path.join(dir, "pnpm"));
    } catch {
      // Not this directory, keep looking.
    }
  }
  return undefined;
}

/** Whether this machine's `pnpm` is one the base policy denies in the first place. */
function skipUnlessPnpmIsUnderHome(): string | undefined {
  const pnpm = resolvePnpm();
  if (pnpm?.startsWith(`${os.homedir()}${path.sep}`)) return undefined;
  return warnSkip(`pnpm is not under $HOME on this machine (${pnpm ?? "none on PATH"})`);
}

/**
 * The pnpm-bearing roots of `node` profile.
 */
const NODE_PROFILE_ROOTS = [
  ".nvm",
  ".config/nvm",
  ".nodenv",
  ".local/share/pnpm",
  "Library/pnpm",
  ".npm-global",
  ".npm-packages",
];

/**
 * A skip reason when the `node` profile does not cover this machine's `pnpm`,
 * and undefined when it does.
 */
function skipUnlessProfileReachesPnpm(): string | undefined {
  const roots = NODE_PROFILE_ROOTS.map((suffix) => inHome(suffix));
  const pnpm = resolvePnpm();
  if (pnpm !== undefined && roots.some((root) => pnpm.startsWith(`${root}${path.sep}`))) {
    return undefined;
  }
  return warnSkip(
    `the node profile does not reach this machine's pnpm (${pnpm ?? "none on PATH"})`,
  );
}

describe("selecting profiles", () => {
  it("no CSB_PROFILES runs, and says nothing about profiles", () => {
    const sandbox = run({});
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
    assert.ok(
      !sandbox.printed("claude-seatbelt: profiles"),
      `expected no profile line, got:\n${sandbox.output}`,
    );
  });

  it("a named profile is reported", () => {
    const sandbox = run({ ...token, CSB_PROFILES: "gh" });
    assert.ok(sandbox.printed("profiles gh"), `expected a profile line, got:\n${sandbox.output}`);
  });

  // The order is the caller's and is preserved, so the settings file can be read
  // back against the profiles that produced it.
  it("a repeated profile is reported in the order given", () => {
    const sandbox = run({ ...token, CSB_PROFILES: "gh gh" });
    assert.ok(
      sandbox.printed("profiles gh gh"),
      `expected the order kept, got:\n${sandbox.output}`,
    );
  });

  it("an unknown profile stops the run", () => {
    const sandbox = run({ CSB_PROFILES: "nope" });
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
    assert.notEqual(sandbox.status, 0);
  });

  it("the refusal lists the profiles that do exist", () => {
    const sandbox = run({ CSB_PROFILES: "nope" });
    assert.ok(sandbox.printed("gh"), `expected the known names, got:\n${sandbox.output}`);
  });

  it("one unknown profile among known ones stops the run", () => {
    const sandbox = run({ ...token, CSB_PROFILES: "gh nope" });
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
  });
});

describe("requiredEnv", () => {
  it("an unset variable stops the run", () => {
    const sandbox = run({ CSB_PROFILES: "gh", GH_TOKEN: "" });
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
    assert.notEqual(sandbox.status, 0);
  });

  it("the refusal names the variable and the profile", () => {
    const sandbox = run({ CSB_PROFILES: "gh", GH_TOKEN: "" });
    assert.ok(
      sandbox.printed("GH_TOKEN") && sandbox.printed("gh"),
      `expected both to be named, got:\n${sandbox.output}`,
    );
  });

  it("a set variable lets the run proceed", () => {
    const sandbox = run({ ...token, CSB_PROFILES: "gh" });
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
  });

  // Declaring a variable does not carry it; it is inherited like any other, and
  // the declaration only decides whether the run happens at all.
  it("the variable reaches the sandboxed process", () => {
    const sandbox = run(
      { CSB_PROFILES: "gh", GH_TOKEN: "carried-through" },
      `echo "GOT $GH_TOKEN"`,
    );
    assert.ok(
      sandbox.printed("GOT carried-through"),
      `expected it through, got:\n${sandbox.output}`,
    );
  });
});

describe("the gh profile, selected", () => {
  let sandbox: SandboxResult;
  const ghConfig = inHome(".config", "gh");

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      env: { ...token, CSB_PROFILES: "gh" },
      script: [
        `p read_gh_config  'ls "${ghConfig}"'`,
        `p write_gh_config 'touch "${ghConfig}/injected"'`,
        `p reach_api       'curl -sS -o /dev/null --max-time 15 https://api.github.com'`,
        // The host the OAuth device flow lives on. Not opened, so no new token
        // can be minted from inside.
        `p reach_github    'curl -sS -o /dev/null --max-time 15 https://github.com'`,
        `p reach_device    'curl -sS -o /dev/null --max-time 15 https://github.com/login/device/code'`,
        // The profile grants trustd for TLS verification; it must not have
        // brought the keychain along with it.
        `p read_login_kc   'head -c 16 "$HOME/Library/Keychains/login.keychain-db"'`,
        `p read_gh_secret  'security find-generic-password -s "gh:github.com" -w'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("the gh config directory is readable", { skip: skipUnlessPresent(ghConfigDir) }, () => {
    assert.equal(sandbox.probe("read_gh_config"), "allowed");
  });

  // extraRead opens a path to read, not to write, exactly as CSB_EXTRA_READ does.
  it("the gh config directory is not writable", { skip: skipUnlessPresent(ghConfigDir) }, () => {
    assert.equal(sandbox.probe("write_gh_config"), "denied");
  });

  it("the GitHub API is reachable", () => {
    assert.equal(sandbox.probe("reach_api"), "allowed");
  });

  it("github.com itself is not reachable", () => {
    assert.equal(sandbox.probe("reach_github"), "denied");
  });

  it("the OAuth device endpoint is not reachable", () => {
    assert.equal(sandbox.probe("reach_device"), "denied");
  });

  it("the keychain is still denied", () => {
    assert.equal(sandbox.probe("read_login_kc"), "denied");
  });

  it("gh's own stored token is still out of reach", () => {
    assert.equal(sandbox.probe("read_gh_secret"), "denied");
  });
});

describe("the gh profile, not selected", () => {
  let sandbox: SandboxResult;
  const ghConfig = inHome(".config", "gh");

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script: [
        `p read_gh_config 'ls "${ghConfig}"'`,
        `p reach_api      'curl -sS -o /dev/null --max-time 15 https://api.github.com'`,
      ].join("\n"),
    });
  });

  it("the gh config directory is not readable", { skip: skipUnlessPresent(ghConfigDir) }, () => {
    assert.equal(sandbox.probe("read_gh_config"), "denied");
  });

  it("the GitHub API is not reachable", () => {
    assert.equal(sandbox.probe("reach_api"), "denied");
  });
});

// An identity on the command line, so the probes do not depend on whatever this
// machine's ~/.gitconfig happens to say.
const gitIdentity =
  "-c user.name=probe -c user.email=probe@example.invalid -c commit.gpgsign=false";

/** Run git outside the sandbox, with the same identity the probes use. */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", [...gitIdentity.split(" "), ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr ?? ""}`);
  }
}

/**
 * A repository for the git-writable probes, built out here because `git init`
 * writes .git/config, which stays denied inside the sandbox.
 *
 * It carries a real submodule, so that .git/modules/<name>/ is a working gitdir
 * rather than a shape made with mkdir: the profile's claim is that a commit
 * there still goes through while the hooks and config beside it do not.
 */
function makeGitWorkspace(name: string): string {
  // The submodule's origin. A path rather than a URL, since the network is the
  // one thing this profile does not open.
  const origin = makeDir(`${name}-origin`);
  writeFile(path.join(origin, "origin.txt"), "one\n");
  git(origin, "init", "-q");
  git(origin, "add", "origin.txt");
  git(origin, "commit", "-q", "-m", "origin");

  const repo = makeDir(name);
  writeFile(path.join(repo, "tracked.txt"), "one\n");
  git(repo, "init", "-q");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-q", "-m", "base");
  // file:// submodules are refused by default since CVE-2022-39253.
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "sub");
  git(repo, "commit", "-q", "-m", "submodule");

  // A worktree gitdir to aim the deny probes at, so that a denial is EPERM
  // rather than the ENOENT `touch` reports for a missing parent.
  git(repo, "worktree", "add", "-q", path.join(repo, "wt-fixture"));

  // Where the pointer probe puts its ".git" file.
  makeDir(path.join(name, "pointed"));

  // A second repository, nested and untracked, for the `git worktree add` probe.
  // It has to be one without submodules: see the probe for why.
  const plain = makeDir(path.join(name, "plain"));
  writeFile(path.join(plain, "plain.txt"), "one\n");
  git(plain, "init", "-q");
  git(plain, "add", "plain.txt");
  git(plain, "commit", "-q", "-m", "base");

  return repo;
}

/** Whether `git` is on PATH at all, since every probe below needs it. */
function skipUnlessGitPresent(): string | undefined {
  const version = spawnSync("git", ["--version"], { encoding: "utf8" });
  return version.status === 0 ? undefined : warnSkip("git is not on PATH");
}

describe("the git-writable profile", { skip: skipUnlessGitPresent() }, () => {
  let sandbox: SandboxResult;
  const repo = makeGitWorkspace("git-ws");

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repo,
      env: { CSB_PROFILES: "git-writable" },
      script: [
        `p git_add    'echo two > new.txt && git add new.txt'`,
        `p git_commit 'git ${gitIdentity} commit -q -m probe'`,
        `p git_branch 'git branch probe-branch'`,
        // The two gitdirs the profile denies by name rather than by region, so
        // that what surrounds the names stays usable.
        `p submodule_commit 'git -C sub ${gitIdentity} commit -q --allow-empty -m probe'`,
        `p worktree_add     'git -C plain worktree add -q wt-probe'`,
        `p write_worktree_gitdir 'touch .git/worktrees/wt-fixture/probe'`,
        // Not the profile's doing: checking out a repository that has submodules
        // means creating .gitmodules in the new worktree, and .gitmodules is on
        // srt's mandatory deny list, which no override reaches past.
        `p worktree_add_super 'git worktree add -q wt-super'`,

        // srt's own mandatory denies, which the override must not have reached.
        `p write_git_hook   'touch .git/hooks/pre-commit'`,
        `p write_git_config 'touch .git/config'`,
        // The names srt's two patterns do not reach, which the override keeps
        // closed itself.
        `p write_module_hook     'touch .git/modules/sub/hooks/pre-commit'`,
        `p write_module_config   'touch .git/modules/sub/config'`,
        `p write_worktree_hook   'mkdir .git/worktrees/wt-fixture/hooks'`,
        `p write_worktree_config 'touch .git/worktrees/wt-fixture/config.worktree'`,
        `p write_config_worktree 'touch .git/config.worktree'`,

        // A writable .git is not a route to the remote: no forge host is opened.
        // GIT_TERMINAL_PROMPT=0 so that a credential prompt fails rather than
        // hanging until the probe cap and reporting a timeout.
        `p push_https 'GIT_TERMINAL_PROMPT=0 git push https://github.com/o/r HEAD:probe'`,
        `p reach_github 'curl -sS -o /dev/null --max-time 15 https://github.com'`,

        // The gap this profile opens, recorded rather than wished away: every
        // hook deny is by path, and a gitdir does not have to be called .git. A
        // ".git" file pointing at a directory that is not one puts hooks
        // somewhere no pattern covers.
        `p plant_pointer 'mkdir -p notgit/hooks && echo payload > notgit/hooks/pre-commit && printf "gitdir: ../notgit\\n" > pointed/.git'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("files can be staged", () => {
    assert.equal(sandbox.probe("git_add"), "allowed");
  });

  it("commits can be made", () => {
    assert.equal(sandbox.probe("git_commit"), "allowed");
  });

  it("branches can be created", () => {
    assert.equal(sandbox.probe("git_branch"), "allowed");
  });

  it("a submodule can be committed to", () => {
    assert.equal(sandbox.probe("submodule_commit"), "allowed");
  });

  it("a linked worktree can be added", () => {
    assert.equal(sandbox.probe("worktree_add"), "allowed");
  });

  // srt denies writing .gitmodules anywhere, so the checkout a new worktree
  // performs cannot reproduce it. Recorded because it is a real limit, and not
  // one this profile can lift.
  it("a worktree of a repository with submodules cannot be added", () => {
    assert.equal(sandbox.probe("worktree_add_super"), "denied");
  });

  it("a worktree gitdir is writable beside the names that are not", () => {
    assert.equal(sandbox.probe("write_worktree_gitdir"), "allowed");
  });

  it("git hooks stay closed", () => {
    assert.equal(sandbox.probe("write_git_hook"), "denied");
  });

  it("the repository config stays closed", () => {
    assert.equal(sandbox.probe("write_git_config"), "denied");
  });

  it("a submodule's hooks stay closed", () => {
    assert.equal(sandbox.probe("write_module_hook"), "denied");
  });

  it("a submodule's config stays closed", () => {
    assert.equal(sandbox.probe("write_module_config"), "denied");
  });

  it("a worktree gitdir grows no hooks directory", () => {
    assert.equal(sandbox.probe("write_worktree_hook"), "denied");
  });

  it("a worktree's per-worktree config stays closed", () => {
    assert.equal(sandbox.probe("write_worktree_config"), "denied");
  });

  it("the per-worktree config stays closed", () => {
    assert.equal(sandbox.probe("write_config_worktree"), "denied");
  });

  it("pushing over HTTPS is denied", () => {
    assert.equal(sandbox.probe("push_https"), "denied");
  });

  it("the forge host is not reachable", () => {
    assert.equal(sandbox.probe("reach_github"), "denied");
  });

  // Asserted as it behaves, the way tests/escape.test.ts does for the AppleEvents
  // gap: if srt ever closes it, this test fails, which is the cue to turn it into
  // a denial assertion and drop the warning from the README.
  it("a gitdir can still be planted outside any .git (known gap)", () => {
    assert.equal(sandbox.probe("plant_pointer"), "allowed");
  });
});

// The pairing the README warns about: gh opens api.github.com, and nothing about
// a writable .git changes what that host will do for a read-only token.
describe("the git-writable and gh profiles together", { skip: skipUnlessGitPresent() }, () => {
  let sandbox: SandboxResult;
  const repo = makeGitWorkspace("git-gh-ws");

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repo,
      env: { ...token, CSB_PROFILES: "gh git-writable" },
      script: [
        `p git_commit 'echo two > new.txt && git add new.txt && git ${gitIdentity} commit -q -m probe'`,
        `p reach_api  'curl -sS -o /dev/null --max-time 15 https://api.github.com'`,
        `p push_https 'GIT_TERMINAL_PROMPT=0 git push https://github.com/o/r HEAD:probe'`,
        `p push_api   'GIT_TERMINAL_PROMPT=0 git push https://api.github.com/o/r HEAD:probe'`,
      ].join("\n"),
    });
  });

  it("committing still works", () => {
    assert.equal(sandbox.probe("git_commit"), "allowed");
  });

  it("the GitHub API is still reachable", () => {
    assert.equal(sandbox.probe("reach_api"), "allowed");
  });

  it("pushing to the forge host is still denied", () => {
    assert.equal(sandbox.probe("push_https"), "denied");
  });

  // The one host that is open serves no git endpoint, so it is no way round the
  // line above.
  it("the API host is no route for a push", () => {
    assert.equal(sandbox.probe("push_api"), "denied");
  });
});

describe("the node profile", { skip: skipUnlessProfileReachesPnpm() }, () => {
  let sandbox: SandboxResult;
  const messy = path.join(testTmp, "messy.ts");
  const ugly = `export  const   x =   {a:1,b:2}\n`;

  before(() => {
    writeFile(messy, ugly);
    // The probes below use `touch`, which cannot create a file whose parent is
    // missing — without this a denial could as easily be ENOENT as EPERM. This
    // is the directory vite makes for itself in a project that uses it.
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".vite-temp"), { recursive: true });
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repoRoot,
      env: { CSB_PROFILES: "node" },
      script: [
        `p pnpm_resolves 'command -v pnpm'`,
        // The base deny, which this profile no longer lifts. That is
        // node-modules-writable's job, and it is not selected here.
        `p write_vite_temp 'touch node_modules/.vite-temp/probe.mjs'`,
        `p write_nm_pkg    'touch node_modules/probe.js'`,
        `p write_nm_bin    'touch node_modules/.bin/probe'`,
        `p read_node_cache  'ls "${inHome(".cache", "node")}"'`,
        `p write_node_cache 'touch "${inHome(".cache", "node", "probe")}"'`,
        `p pnpm_lint     'pnpm lint'`,
        `p pnpm_format   'pnpm format:check'`,
        // `pnpm format` differs from `format:check` only in writing, so the
        // write is proven on a scratch file rather than by reformatting the
        // repository from inside a test.
        `p oxfmt_writes  'pnpm exec oxfmt "${messy}"'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("pnpm is on PATH", () => {
    assert.equal(sandbox.probe("pnpm_resolves"), "allowed");
  });

  it("a build tool's scratch directory under node_modules stays closed", () => {
    assert.equal(sandbox.probe("write_vite_temp"), "denied");
  });

  it("package code under node_modules stays closed", () => {
    assert.equal(sandbox.probe("write_nm_pkg"), "denied");
  });

  it("node_modules/.bin stays closed", () => {
    assert.equal(sandbox.probe("write_nm_bin"), "denied");
  });

  it("the corepack cache is readable", { skip: skipUnlessPresent(corepackCache) }, () => {
    assert.equal(sandbox.probe("read_node_cache"), "allowed");
  });

  // Reading is enough: a version already fetched outside the sandbox runs from
  // here, and fetching a new one would need the network the profile never opens.
  it("the corepack cache is not writable", { skip: skipUnlessPresent(corepackCache) }, () => {
    assert.equal(sandbox.probe("write_node_cache"), "denied");
  });

  it("pnpm lint runs", () => {
    assert.equal(sandbox.probe("pnpm_lint"), "allowed");
  });

  it("pnpm format:check runs", () => {
    assert.equal(sandbox.probe("pnpm_format"), "allowed");
  });

  it("the formatter can rewrite a file in the workspace", () => {
    assert.equal(sandbox.probe("oxfmt_writes"), "allowed");
    assert.notEqual(fs.readFileSync(messy, "utf8"), ugly);
  });
});

// Selected beside `node`, which is how it is meant to be used: the override is
// no use on its own to a toolchain the base policy cannot reach.
describe("the node-modules-writable profile", () => {
  let sandbox: SandboxResult;

  before(() => {
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".vite-temp"), { recursive: true });
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repoRoot,
      env: { CSB_PROFILES: "node node-modules-writable" },
      script: [
        `p write_vite_temp 'touch node_modules/.vite-temp/probe.mjs'`,
        // srt cannot deny a path inside a region it has opened, so the whole of
        // node_modules comes with it. Asserted rather than hoped for, because
        // these two are what the base deny existed to close.
        `p write_nm_pkg 'touch node_modules/probe.js'`,
        `p write_nm_bin 'touch node_modules/.bin/probe'`,
        // What it must not have taken with it.
        `p write_git    'touch .git/probe'`,
        `p write_dotenv 'touch .env'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("a build tool can write its scratch directory under node_modules", () => {
    assert.equal(sandbox.probe("write_vite_temp"), "allowed");
  });

  it("package code under node_modules becomes writable too", () => {
    assert.equal(sandbox.probe("write_nm_pkg"), "allowed");
  });

  it("node_modules/.bin becomes writable too", () => {
    assert.equal(sandbox.probe("write_nm_bin"), "allowed");
  });

  it("git metadata is unaffected", () => {
    assert.equal(sandbox.probe("write_git"), "denied");
  });

  it("environment files are unaffected", () => {
    assert.equal(sandbox.probe("write_dotenv"), "denied");
  });
});

describe("the node profile, not selected", () => {
  it("pnpm is out of reach without the profile", { skip: skipUnlessPnpmIsUnderHome() }, () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repoRoot,
      script: `p pnpm_resolves 'command -v pnpm'`,
    });
    assert.equal(sandbox.probe("pnpm_resolves"), "denied");
  });
});
