// What the sandboxed process can actually read and write.

import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { makeDir, repoRoot, sandboxProbe, type SandboxResult, writeFile } from "./helpers.ts";

// The workspace, and a sibling that is not it. Both are outside every path the
// policy opens up, so the sibling is denied for the reason under test.
const workspace = makeDir("fs-ws");
const outside = makeDir("fs-outside");

writeFile(path.join(workspace, "existing.txt"), "workspace file\n");
writeFile(path.join(workspace, ".git", "config"), "tracked\n");
writeFile(path.join(workspace, "sub", ".keep"), "");
writeFile(path.join(outside, "secret.txt"), "sibling secret\n");

describe("the workspace", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: workspace,
      script: [
        `p read_workspace         'cat existing.txt'`,
        `p write_workspace        'echo x > created.txt'`,
        `p write_workspace_subdir 'echo x > sub/created.txt'`,
        `p create_workspace_dir   'mkdir fresh_dir'`,
        `p delete_workspace_file  'rm -f existing.txt'`,

        `p read_sibling           'cat ${outside}/secret.txt'`,
        `p write_sibling          'echo x > ${outside}/created.txt'`,
        `p list_sibling           'ls ${outside}'`,
        `p read_repo_readme       'cat ${repoRoot}/README.md'`,

        `p read_git_config        'cat .git/config'`,
        `p write_git_config       'echo x >> .git/config'`,
        `p write_git_new_file     'echo x > .git/hooks_payload'`,

        `p read_etc_hosts         'cat /etc/hosts'`,
        `p read_system_binary     'head -c 1 /usr/bin/curl'`,
        `p write_usr_local        'echo x > /usr/local/injected'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("the workspace is readable", () => {
    assert.equal(sandbox.probe("read_workspace"), "allowed");
  });

  it("the workspace is writable", () => {
    assert.equal(sandbox.probe("write_workspace"), "allowed");
  });

  it("a workspace subdirectory is writable", () => {
    assert.equal(sandbox.probe("write_workspace_subdir"), "allowed");
  });

  it("directories can be created in the workspace", () => {
    assert.equal(sandbox.probe("create_workspace_dir"), "allowed");
  });

  it("workspace files can be deleted", () => {
    assert.equal(sandbox.probe("delete_workspace_file"), "allowed");
  });

  it("a sibling directory is not readable", () => {
    assert.equal(sandbox.probe("read_sibling"), "denied");
  });

  it("a sibling directory is not writable", () => {
    assert.equal(sandbox.probe("write_sibling"), "denied");
  });

  it("a sibling directory cannot be listed", () => {
    assert.equal(sandbox.probe("list_sibling"), "denied");
  });

  it("files outside the workspace are not readable", () => {
    assert.equal(sandbox.probe("read_repo_readme"), "denied");
  });

  it("git metadata is readable", () => {
    assert.equal(sandbox.probe("read_git_config"), "allowed");
  });

  it("git metadata cannot be overwritten", () => {
    assert.equal(sandbox.probe("write_git_config"), "denied");
  });

  it("new files cannot be planted in .git", () => {
    assert.equal(sandbox.probe("write_git_new_file"), "denied");
  });

  it("system config is readable", () => {
    assert.equal(sandbox.probe("read_etc_hosts"), "allowed");
  });

  it("system binaries are readable", () => {
    assert.equal(sandbox.probe("read_system_binary"), "allowed");
  });

  it("system locations are not writable", () => {
    assert.equal(sandbox.probe("write_usr_local"), "denied");
  });
});

describe("the home directory", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: workspace,
      script: [
        `p read_app_support   'ls "$HOME/Library/Application Support"'`,
        `p read_ssh           'ls $HOME/.ssh'`,
        `p read_aws           'cat $HOME/.aws/credentials'`,
        `p read_claude_config 'cat $HOME/.claude.json'`,
        `p read_gitconfig     'cat $HOME/.gitconfig'`,
        `p write_claude_hook  'echo x > $HOME/.claude/hooks/injected.sh'`,
        `p write_claude_cmd   'echo x > $HOME/.claude/commands/injected.md'`,
        `p write_claude_agent 'echo x > $HOME/.claude/agents/injected.md'`,
        `p write_claude_stgs  'echo x > $HOME/.claude/settings.json'`,
      ].join("\n"),
    });
  });

  it("unlisted home directories are not readable", () => {
    assert.equal(sandbox.probe("read_app_support"), "denied");
  });

  it("ssh keys are not readable", () => {
    assert.equal(sandbox.probe("read_ssh"), "denied");
  });

  it("cloud credentials are not readable", () => {
    assert.equal(sandbox.probe("read_aws"), "denied");
  });

  it("the claude config is readable", () => {
    assert.equal(sandbox.probe("read_claude_config"), "allowed");
  });

  it("the git config is readable", () => {
    assert.equal(sandbox.probe("read_gitconfig"), "allowed");
  });

  // ~/.claude is writable as a whole, so these four have to be denied by the
  // later rules rather than by the absence of an allow.
  it("host hooks cannot be written", () => {
    assert.equal(sandbox.probe("write_claude_hook"), "denied");
  });

  it("host commands cannot be written", () => {
    assert.equal(sandbox.probe("write_claude_cmd"), "denied");
  });

  it("host agents cannot be written", () => {
    assert.equal(sandbox.probe("write_claude_agent"), "denied");
  });

  it("host settings cannot be written", () => {
    assert.equal(sandbox.probe("write_claude_stgs"), "denied");
  });
});

describe("CSB_EXTRA_READ", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: workspace,
      env: { CSB_EXTRA_READ: outside },
      script: [
        `p read_extra  'cat ${outside}/secret.txt'`,
        `p write_extra 'echo x > ${outside}/created.txt'`,
      ].join("\n"),
    });
  });

  it("CSB_EXTRA_READ opens a path for reading", () => {
    assert.equal(sandbox.probe("read_extra"), "allowed");
  });

  it("CSB_EXTRA_READ does not also open it for writing", () => {
    assert.equal(sandbox.probe("write_extra"), "denied");
  });
});
