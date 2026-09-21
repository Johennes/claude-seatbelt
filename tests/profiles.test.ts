import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

import {
  makeDir,
  repoRoot,
  type SandboxResult,
  sandboxProbe,
  sandboxRun,
  testTmp,
  writeFile,
} from "./helpers.ts";

const SENTINEL = "SENTINEL_RAN";
const workspace = makeDir("profiles-ws");

// A value, because the gh profile refuses to run without one. Nothing here
// authenticates against GitHub — CSB_CLAUDE is /bin/sh.
const token = { GH_TOKEN: "test-token" };

const run = (env: Record<string, string>, script = `echo ${SENTINEL}`) =>
  sandboxRun({ extraDomains: "", cwd: workspace, script, env });

/** Whether this machine's `pnpm` is one the base policy denies in the first place. */
function pnpmIsUnderHome(): boolean {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    try {
      return fs.realpathSync(path.join(dir, "pnpm")).startsWith(`${os.homedir()}${path.sep}`);
    } catch {
      // Not this directory, keep looking.
    }
  }
  return false;
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
  const ghConfig = path.join(os.homedir(), ".config", "gh");

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

  it("the gh config directory is readable", () => {
    assert.equal(sandbox.probe("read_gh_config"), "allowed");
  });

  // extraRead opens a path to read, not to write, exactly as CSB_EXTRA_READ does.
  it("the gh config directory is not writable", () => {
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
  const ghConfig = path.join(os.homedir(), ".config", "gh");

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

  it("the gh config directory is not readable", () => {
    assert.equal(sandbox.probe("read_gh_config"), "denied");
  });

  it("the GitHub API is not reachable", () => {
    assert.equal(sandbox.probe("reach_api"), "denied");
  });
});

describe("the node profile", () => {
  let sandbox: SandboxResult;
  const messy = path.join(testTmp, "messy.ts");
  const ugly = `export  const   x =   {a:1,b:2}\n`;

  before(() => {
    writeFile(messy, ugly);
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repoRoot,
      env: { CSB_PROFILES: "node" },
      script: [
        `p pnpm_resolves 'command -v pnpm'`,
        `p read_node_cache  'ls "${path.join(os.homedir(), ".cache", "node")}"'`,
        `p write_node_cache 'touch "${path.join(os.homedir(), ".cache", "node", "probe")}"'`,
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

  it("the corepack cache is readable", () => {
    assert.equal(sandbox.probe("read_node_cache"), "allowed");
  });

  // Reading is enough: a version already fetched outside the sandbox runs from
  // here, and fetching a new one would need the network the profile never opens.
  it("the corepack cache is not writable", () => {
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

describe("the node profile, not selected", () => {
  it("pnpm is out of reach without the profile", { skip: !pnpmIsUnderHome() }, () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repoRoot,
      script: `p pnpm_resolves 'command -v pnpm'`,
    });
    assert.equal(sandbox.probe("pnpm_resolves"), "denied");
  });
});
