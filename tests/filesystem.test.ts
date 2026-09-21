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

// The probes below reach for these with `touch`, which cannot create a file
// whose parent is missing. Without them in place a denial could as easily be
// ENOENT as EPERM, and the assertion would prove nothing.
writeFile(path.join(workspace, "node_modules", ".bin", ".keep"), "");
writeFile(path.join(workspace, "node_modules", "pkg", ".keep"), "");
writeFile(path.join(workspace, "sub", "node_modules", ".keep"), "");

describe("the workspace", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: workspace,
      script: [
        `p read_workspace         'cat existing.txt'`,
        `p write_workspace        'touch created.txt'`,
        `p write_workspace_subdir 'touch sub/created.txt'`,
        `p create_workspace_dir   'mkdir fresh_dir'`,
        `p delete_workspace_file  'rm -f existing.txt'`,

        `p read_sibling           'cat ${outside}/secret.txt'`,
        `p write_sibling          'touch ${outside}/created.txt'`,
        `p list_sibling           'ls ${outside}'`,
        `p read_repo_readme       'cat ${repoRoot}/README.md'`,

        `p read_git_config        'cat .git/config'`,
        `p write_git_config       'touch .git/config'`,
        `p write_git_new_file     'touch .git/hooks_payload'`,

        `p read_etc_hosts         'cat /etc/hosts'`,
        `p read_system_binary     'head -c 1 /usr/bin/curl'`,
        `p write_usr_local        'touch /usr/local/injected'`,
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
        `p write_gitconfig    'touch $HOME/.gitconfig'`,
        `p write_claude_hook  'touch $HOME/.claude/hooks/injected.sh'`,
        `p write_claude_cmd   'touch $HOME/.claude/commands/injected.md'`,
        `p write_claude_agent 'touch $HOME/.claude/agents/injected.md'`,
        `p write_claude_stgs  'touch $HOME/.claude/settings.json'`,
        `p list_keychains     'ls $HOME/Library/Keychains'`,
        `p read_login_kc      'head -c 16 $HOME/Library/Keychains/login.keychain-db'`,
        `p write_keychain_dir 'touch $HOME/Library/Keychains/injected'`,
        `p list_sys_keychains 'ls /Library/Keychains'`,
        `p read_sys_keychain  'head -c 16 /Library/Keychains/System.keychain'`,
        `p read_oauth_secret  'security find-generic-password -a "$USER" -w -s "Claude Code-credentials"'`,
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

  // Read is opened for ~/.gitconfig, write never is, and srt's own mandatory
  // deny list closes it a second time. A commit hook or a credential helper
  // planted there would run outside the sandbox.
  it("the git config cannot be written", () => {
    assert.equal(sandbox.probe("write_gitconfig"), "denied");
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

  // Read access to a legacy keychain file is read access to every secret in it,
  // because the Security framework opens it in the calling process rather than
  // going through securityd. Write access can only be granted on the directory,
  // which also grants deleting the keychain. Neither is given.
  it("this user's keychain directory is not listable", () => {
    assert.equal(sandbox.probe("list_keychains"), "denied");
  });

  it("the login keychain is not readable", () => {
    assert.equal(sandbox.probe("read_login_kc"), "denied");
  });

  it("nothing can be written into the keychain directory", () => {
    assert.equal(sandbox.probe("write_keychain_dir"), "denied");
  });

  // These two sit outside $HOME, /Users and /Volumes, so they are denied by
  // their own rule rather than by any of the broad regions.
  it("the system keychain directory is not listable", () => {
    assert.equal(sandbox.probe("list_sys_keychains"), "denied");
  });

  it("the system keychain is not readable", () => {
    assert.equal(sandbox.probe("read_sys_keychain"), "denied");
  });

  // The claim the file probes exist to support.
  it("the stored OAuth token cannot be read back out of the keychain", () => {
    assert.equal(sandbox.probe("read_oauth_secret"), "denied");
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
        `p write_extra 'touch ${outside}/created.txt'`,
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

describe("gitignored paths inside the workspace", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: workspace,
      script: [
        // The directory itself, which "**/node_modules" covers separately from
        // its contents. It exists already, so this is the utimes path.
        `p write_node_modules     'touch node_modules'`,
        `p write_node_modules_bin 'touch node_modules/.bin/pnpm'`,
        `p write_node_modules_pkg 'touch node_modules/pkg/index.js'`,
        // A nested workspace has its own, which is why the patterns are "**".
        `p write_nested_modules   'touch sub/node_modules/injected.js'`,

        `p write_dotenv           'touch .env'`,
        `p write_dotenv_local     'touch .env.local'`,
        `p write_dotenv_prod      'touch .env.production.local'`,
        `p write_nested_dotenv    'touch sub/.env'`,

        // Tracked, so a change to it lands in the diff. Not denied.
        `p write_dotenv_example   'touch .env.example'`,
        // Neither is anything else in the workspace.
        `p write_ordinary_file    'touch ordinary.ts'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("node_modules is not writable", () => {
    assert.equal(sandbox.probe("write_node_modules"), "denied");
  });

  // The shims here are on PATH for every `pnpm run` typed on the host.
  it("node_modules/.bin is not writable", () => {
    assert.equal(sandbox.probe("write_node_modules_bin"), "denied");
  });

  it("an installed package is not writable", () => {
    assert.equal(sandbox.probe("write_node_modules_pkg"), "denied");
  });

  it("a nested node_modules is not writable either", () => {
    assert.equal(sandbox.probe("write_nested_modules"), "denied");
  });

  it(".env is not writable", () => {
    assert.equal(sandbox.probe("write_dotenv"), "denied");
  });

  it(".env.local is not writable", () => {
    assert.equal(sandbox.probe("write_dotenv_local"), "denied");
  });

  it(".env.<name>.local is not writable", () => {
    assert.equal(sandbox.probe("write_dotenv_prod"), "denied");
  });

  it("a nested .env is not writable either", () => {
    assert.equal(sandbox.probe("write_nested_dotenv"), "denied");
  });

  it(".env.example is still writable", () => {
    assert.equal(sandbox.probe("write_dotenv_example"), "allowed");
  });

  it("the rest of the workspace is still writable", () => {
    assert.equal(sandbox.probe("write_ordinary_file"), "allowed");
  });
});
