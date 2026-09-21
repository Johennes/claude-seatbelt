import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { makeDir, sandboxRun, writeFile } from "./helpers.ts";

const SENTINEL = "SENTINEL_RAN";
const script = `echo ${SENTINEL}`;
const workspace = makeDir("startup-ws");

const run = (extraDomains: string, cwd = workspace, env?: Record<string, string>) =>
  sandboxRun({ extraDomains, cwd, script, ...(env ? { env } : {}) });

// A positive control first: without it every assertion below could pass because
// the harness is broken rather than because the configuration was refused.
describe("positive control", () => {
  it("a valid configuration does run the binary", () => {
    const sandbox = run("example.com");
    assert.ok(
      sandbox.printed(SENTINEL),
      `expected the sandboxed command to run, got:\n${sandbox.output}`,
    );
  });

  it("a valid configuration exits cleanly", () => {
    const sandbox = run("example.com");
    assert.equal(sandbox.status, 0);
  });

  // CSB_EXTRA_DOMAINS is additive, so empty means "nothing beyond the built-in
  // domains" rather than "no network" — it must not stop the run.
  it("an empty CSB_EXTRA_DOMAINS still runs, on the built-in domains alone", () => {
    const sandbox = run("");
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
    assert.equal(sandbox.status, 0);
  });
});

describe("CSB_EXTRA_DOMAINS entries that must stop the run", () => {
  const cases: Array<[label: string, extraDomains: string]> = [
    ["a TLD-wide entry", ".com"],
    ["a bare dot", "."],
    ["a bare wildcard", "*"],
    ["a wildcard entry", "*.example.com"],
    ["a dotless entry", "localhost"],
    ["a trailing-dot entry", "example.com."],
    ["one bad entry among good ones", "example.com .com"],
  ];

  for (const [label, extraDomains] of cases) {
    it(`${label} stops the run`, () => {
      const sandbox = run(extraDomains);
      assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
      assert.notEqual(sandbox.status, 0);
    });
  }
});

describe("workspaces that must stop the run", () => {
  const cases: Array<[label: string, cwd: string]> = [
    ["the home directory as the workspace", os.homedir()],
    ["the root directory as the workspace", "/"],
  ];

  for (const [label, cwd] of cases) {
    it(`${label} stops the run`, () => {
      const sandbox = run("example.com", cwd);
      assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
      assert.notEqual(sandbox.status, 0);
    });
  }
});

describe("CLAUDE_CODE_OAUTH_TOKEN", () => {
  it("an unset token stops the run", () => {
    const sandbox = run("example.com", workspace, { CLAUDE_CODE_OAUTH_TOKEN: "" });
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
    assert.notEqual(sandbox.status, 0);
  });

  it("the refusal says how to get one", () => {
    const sandbox = run("example.com", workspace, { CLAUDE_CODE_OAUTH_TOKEN: "" });
    assert.ok(
      sandbox.printed("claude setup-token"),
      `expected the refusal to name the command, got:\n${sandbox.output}`,
    );
  });
});

describe("awkward characters in CSB_EXTRA_READ and CSB_EXTRA_WRITE", () => {
  it("a quote in CSB_EXTRA_READ does not stop the run", () => {
    const sandbox = run("example.com", workspace, {
      CSB_EXTRA_READ: makeDir('quote"dir'),
    });
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
  });

  it("a backslash in CSB_EXTRA_WRITE does not stop the run", () => {
    const sandbox = run("example.com", workspace, {
      CSB_EXTRA_WRITE: makeDir("back\\slashdir"),
    });
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
  });
});

// npx is npm, and npm reads the manifest of whatever directory it starts in.
// A workspace is entitled to demand a particular package manager of its own
// contributors, and that is no statement about the tool sandboxing it.
describe("a workspace that demands another package manager", () => {
  it("still runs", () => {
    const cwd = makeDir("devengines-ws");
    writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "demands-pnpm",
          devEngines: { packageManager: { name: "pnpm", version: "11.23.0", onFail: "download" } },
        },
        null,
        2,
      )}\n`,
    );
    const sandbox = run("example.com", cwd);
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
    assert.ok(
      !sandbox.printed("EBADDEVENGINES"),
      `expected npm not to apply the workspace manifest to itself, got:\n${sandbox.output}`,
    );
  });
});
