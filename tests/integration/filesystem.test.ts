import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  inHome,
  makeDir,
  sandboxProbe,
  type SandboxResult,
  skipUnlessPresent,
} from "../helpers.ts";

const claudeConfig = inHome(".claude.json");
const claudeCache = inHome(".cache", "claude");
const workspace = makeDir("integration-fs-ws");

describe("~/.claude.json", { skip: skipUnlessPresent(claudeConfig) }, () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script: [
        `p read_claude_config 'cat "${claudeConfig}"'`,
        // `touch` on the real file, which only moves its mtime: the account
        // record, the MCP server definitions and the per-project history are
        // rewritten by Claude on every start, and denying that brings the trust
        // dialog back each time.
        `p write_config 'touch "${claudeConfig}"'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("is readable", () => {
    assert.equal(sandbox.probe("read_claude_config"), "allowed");
  });

  it("is writable", () => {
    assert.equal(sandbox.probe("write_config"), "allowed");
  });
});

describe("~/.cache/claude", { skip: skipUnlessPresent(claudeCache) }, () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script: [
        `p read_claude_cache 'ls "${claudeCache}"'`,
        // Cleaned up again, so the real cache is left as it was found.
        `p write_claude_cache 'touch "${claudeCache}/probe" && rm "${claudeCache}/probe"'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("is readable", () => {
    assert.equal(sandbox.probe("read_claude_cache"), "allowed");
  });

  it("is writable", () => {
    assert.equal(sandbox.probe("write_claude_cache"), "allowed");
  });
});
