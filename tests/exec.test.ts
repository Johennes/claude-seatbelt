import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

import {
  fakeClaude,
  makeDir,
  type SandboxResult,
  sandboxProbe,
  sandboxRun,
  skipUnlessPresent,
  writeFile,
} from "./helpers.ts";

const SENTINEL = "SENTINEL_RAN";

// Every probe script runs under a timeout loop built on `sleep`, so a suite that
// replaces the default allowlist has to keep it. Without it a denial reads as a
// timeout, which is a different claim.
const SLEEP = "/bin/sleep";

/** Run probes with an allowlist of exactly these entries, plus what the loop needs. */
function probeWithExec(cwd: string, allowExec: string[], script: string): SandboxResult {
  return sandboxProbe({
    extraDomains: "",
    cwd,
    script,
    env: { CSB_EXTRA_EXEC: [SLEEP, ...allowExec].join(":") },
  });
}

describe("the exec allowlist", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-ws");

  before(() => {
    // A binary of its own inside the workspace: the workspace is writable, so
    // this is the file Claude could have written itself.
    fs.copyFileSync("/bin/date", path.join(workspace, "copied-date"));

    sandbox = probeWithExec(
      workspace,
      ["/bin/date"],
      [
        `p allowed       '/bin/date'`,
        `p denied        '/bin/echo hello'`,
        // The same denial, reached through the shell that is on the list. A
        // shell is not a way around the allowlist: the binary it starts is
        // checked in its own right.
        `p denied_via_sh '/bin/sh -c /bin/echo'`,
        // And through a second shell below that one.
        `p denied_nested 'sh -c "sh -c /bin/echo"'`,
        `p copied_binary './copied-date'`,
      ].join("\n"),
    );
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("an allow-listed binary runs", () => {
    assert.equal(sandbox.probe("allowed"), "allowed");
  });

  it("a binary that is not allow-listed does not", () => {
    assert.equal(sandbox.probe("denied"), "denied");
  });

  it("a shell cannot start what the allowlist denies", () => {
    assert.equal(sandbox.probe("denied_via_sh"), "denied");
  });

  it("nor can a shell below that one", () => {
    assert.equal(sandbox.probe("denied_nested"), "denied");
  });

  // The point of the exercise: the workspace is the one place Claude can write,
  // and writing something is not the same as being able to run it.
  it("a binary copied into the workspace does not run", () => {
    assert.equal(sandbox.probe("copied_binary"), "denied");
  });
});

describe("what an entry resolves to", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-resolve-ws");
  // In the workspace, which is the one region a test can put a file in and have
  // the sandbox able to read it back.
  const link = path.join(workspace, "date-link");

  before(() => {
    fs.rmSync(link, { force: true });
    fs.symlinkSync("/bin/date", link);
    sandbox = probeWithExec(
      workspace,
      [link],
      [
        // Seatbelt matches the path the kernel resolved, so allow-listing the
        // symlink alone would deny the binary behind it.
        `p through_link '${link}'`,
        // Naming the link does not open the directory it points into.
        `p not_the_dir  '/bin/ls /'`,
      ].join("\n"),
    );
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("a symlinked entry runs the binary it points at", () => {
    assert.equal(sandbox.probe("through_link"), "allowed");
  });

  it("and nothing else beside it", () => {
    assert.equal(sandbox.probe("not_the_dir"), "denied");
  });
});

describe("a subtree entry", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-subtree-ws");

  before(() => {
    sandbox = probeWithExec(
      workspace,
      ["/bin/**"],
      [
        `p in_tree     '/bin/date'`,
        `p also_in_tree '/bin/echo tree'`,
        `p out_of_tree '/usr/bin/true'`,
      ].join("\n"),
    );
  });

  it("opens every binary below it", () => {
    assert.equal(sandbox.probe("in_tree"), "allowed");
    assert.equal(sandbox.probe("also_in_tree"), "allowed");
  });

  it("and nothing outside it", () => {
    assert.equal(sandbox.probe("out_of_tree"), "denied");
  });
});

describe("workspace-relative entries", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-relative-ws");

  before(() => {
    const tool = path.join(workspace, "tools", "run.sh");
    writeFile(tool, "#!/bin/sh\necho SCRIPT_RAN\n");
    fs.chmodSync(tool, 0o755);
    fs.copyFileSync("/bin/date", path.join(workspace, "tools", "date"));
    fs.copyFileSync("/bin/date", path.join(workspace, "elsewhere-date"));

    sandbox = probeWithExec(
      workspace,
      ["./tools/**", "/bin/sh"],
      [
        `p in_workspace     './tools/date'`,
        // A script is two execs: the file itself, and the interpreter its
        // shebang names. Both are on the list here, so the grant over the
        // directory is what decides.
        `p workspace_script './tools/run.sh'`,
        `p outside_the_grant './elsewhere-date'`,
      ].join("\n"),
    );
  });

  it("a './' entry is taken from the workspace", () => {
    assert.equal(sandbox.probe("in_workspace"), "allowed");
  });

  it("a script in the granted directory runs", () => {
    assert.equal(sandbox.probe("workspace_script"), "allowed");
  });

  it("the rest of the workspace stays closed", () => {
    assert.equal(sandbox.probe("outside_the_grant"), "denied");
  });
});

describe("a script in the workspace, with nothing granted over it", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-script-ws");

  before(() => {
    const script = path.join(workspace, "build.sh");
    writeFile(script, "#!/bin/sh\necho SCRIPT_RAN\n");
    fs.chmodSync(script, 0o755);

    sandbox = probeWithExec(
      workspace,
      ["/bin/sh"],
      [
        `p shebang     './build.sh'`,
        // The same file handed to the interpreter as an argument. The shell is
        // allow-listed and the script is only ever read, so this does run: the
        // allowlist is about which binaries start, not about which bytes they
        // are pointed at.
        `p interpreted 'sh ./build.sh'`,
      ].join("\n"),
    );
  });

  it("cannot be run through its shebang", () => {
    assert.equal(sandbox.probe("shebang"), "denied");
  });

  it("but an allow-listed interpreter still reads it", () => {
    assert.equal(sandbox.probe("interpreted"), "allowed");
  });
});

// The base list is what runs with no profile selected. It is the shells Claude
// needs and the Claude binary, and deliberately not /bin/sh: nothing Claude does
// on its own reaches for it, while `pnpm test` and every `#!/bin/sh` script do —
// which is a profile's business rather than the base policy's.
describe("the base list", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-base-ws");

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      // The harness's shim execs bash, not sh, so CSB_CLAUDE — allow-listed for
      // execution — does not grant the very thing under test here.
      env: { CSB_EXTRA_EXEC: SLEEP },
      script: [`p bash '/bin/bash -c "exit 0"'`, `p sh '/bin/sh -c "exit 0"'`].join("\n"),
    });
  });

  it("carries the shell Claude falls back to", () => {
    assert.equal(sandbox.probe("bash"), "allowed");
  });

  it("does not carry /bin/sh", () => {
    assert.equal(sandbox.probe("sh"), "denied");
  });

  it("which the unix profile grants", () => {
    const withUnix = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      env: { CSB_EXTRA_EXEC: SLEEP, CSB_PROFILES: "unix" },
      script: `p sh '/bin/sh -c "exit 0"'`,
    });
    assert.equal(withUnix.probe("sh"), "allowed");
  });
});

// The login shell is the one Claude runs a command with, and it is read rather
// than assumed. /bin/zsh stands in for it here because it is on every macOS and
// on no other list, so allowed-vs-denied is this grant and nothing else.
describe("the login shell", { skip: skipUnlessPresent("/bin/zsh") }, () => {
  const workspace = makeDir("exec-shell-ws");
  const script = `p login_shell '/bin/zsh -c "exit 0"'`;

  const withShell = (shell: string): SandboxResult =>
    sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script,
      env: { CSB_EXTRA_EXEC: SLEEP, SHELL: shell },
    });

  it("is allow-listed from $SHELL", () => {
    assert.equal(withShell("/bin/zsh").probe("login_shell"), "allowed");
  });

  it("is not assumed when $SHELL says otherwise", () => {
    assert.equal(withShell("/bin/bash").probe("login_shell"), "denied");
  });

  it("nor when $SHELL is unset", () => {
    assert.equal(withShell("").probe("login_shell"), "denied");
  });

  // $SHELL is an absolute path on every macOS account, POSIX says so, and a bare
  // name is a broken environment rather than a hostile one. It is resolved the
  // way the sandboxed process would have to resolve it.
  it("is resolved on PATH when $SHELL is a bare name", () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script,
      env: { CSB_EXTRA_EXEC: SLEEP, SHELL: "zsh", PATH: "/bin:/usr/bin" },
    });
    assert.equal(sandbox.probe("login_shell"), "allowed");
  });

  it("and a name that is on no PATH is passed over rather than refused", () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script,
      env: { CSB_EXTRA_EXEC: SLEEP, SHELL: "no-such-shell" },
    });
    assert.equal(sandbox.status, 0);
    assert.equal(sandbox.probe("login_shell"), "denied");
  });
});

// What `which` answers is executed, and is allow-listed for execution so that it
// can be. A relative PATH entry would let the workspace answer that question,
// and the workspace is the one place the sandboxed Claude can write.
describe("finding claude on PATH", () => {
  const workspace = makeDir("exec-which-ws");
  const script = `echo ${SENTINEL}`;

  before(() => {
    // Something that behaves like Claude for the length of one `-c`. A script
    // rather than a copied /bin/sh: macOS launch constraints SIGKILL a system
    // shell that runs from anywhere but its own path, sandbox or no sandbox.
    fakeClaude(path.join(workspace, "claude"));
  });

  it("an absolute PATH entry answers", () => {
    const sandbox = sandboxRun({
      extraDomains: "",
      cwd: workspace,
      script,
      env: { CSB_CLAUDE: "", PATH: `${workspace}:/usr/bin:/bin` },
    });
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
  });

  it("a relative one does not, even with the binary right there", () => {
    const sandbox = sandboxRun({
      extraDomains: "",
      cwd: workspace,
      script,
      env: { CSB_CLAUDE: "", PATH: ".:/usr/bin:/bin" },
    });
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
    assert.ok(
      sandbox.printed("not found in PATH"),
      `expected the refusal to say so, got:\n${sandbox.output}`,
    );
  });

  // CSB_CLAUDE takes the same three forms as any other path the allowlist has
  // to name, plus a bare name, which is looked up the way `claude` itself is.
  const runAs = (claude: string, extra: Record<string, string> = {}): SandboxResult =>
    sandboxRun({ extraDomains: "", cwd: workspace, script, env: { CSB_CLAUDE: claude, ...extra } });

  it("CSB_CLAUDE as a bare name is looked up on PATH", () => {
    const sandbox = runAs("claude", { PATH: `${workspace}:/usr/bin:/bin` });
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
  });

  it("CSB_CLAUDE under '~/' is expanded", () => {
    // The fixture lives under $HOME, which is where the test root is.
    const fake = path.join(workspace, "claude");
    assert.ok(fake.startsWith(`${os.homedir()}/`), `fixture not under $HOME: ${fake}`);
    const sandbox = runAs(`~/${path.relative(os.homedir(), fake)}`);
    assert.ok(sandbox.printed(SENTINEL), `expected the run to proceed, got:\n${sandbox.output}`);
  });

  it("CSB_CLAUDE as a relative path stops the run", () => {
    const sandbox = runAs("./claude");
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
    assert.ok(
      sandbox.printed("neither absolute"),
      `expected the refusal to say why, got:\n${sandbox.output}`,
    );
  });

  it("CSB_CLAUDE that is not an executable file stops the run", () => {
    const sandbox = runAs(path.join(workspace, "no-such-claude"));
    assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
    assert.ok(
      sandbox.printed("not an executable file"),
      `expected the refusal to say why, got:\n${sandbox.output}`,
    );
  });
});

// An npm or Homebrew install of Claude is a `#!/usr/bin/env node` script, and
// the interpreter a shebang names is an exec of its own. Both fixtures use
// /bin/sh, which is on no base list, so what passes here is the shebang being
// read — not an interpreter that happened to be allowed anyway.
describe("a claude that is a script", () => {
  const workspace = makeDir("exec-shebang-ws");
  const script = `echo ${SENTINEL}`;

  const fake = (name: string, shebang: string): string =>
    fakeClaude(path.join(workspace, name), shebang, "/bin/sh");

  const runAs = (claude: string): SandboxResult =>
    sandboxRun({
      extraDomains: "",
      cwd: workspace,
      script,
      // Nothing beyond the base list, or /usr/bin/env would be on it already.
      env: { CSB_CLAUDE: claude, CSB_EXTRA_EXEC: "" },
    });

  it("gets its interpreter allow-listed", () => {
    const sandbox = runAs(fake("direct", "#!/bin/sh"));
    assert.ok(sandbox.printed(SENTINEL), `expected the script to run, got:\n${sandbox.output}`);
  });

  it("through /usr/bin/env, gets both env and what env finds", () => {
    const sandbox = runAs(fake("via-env", "#!/usr/bin/env sh"));
    assert.ok(sandbox.printed(SENTINEL), `expected the script to run, got:\n${sandbox.output}`);
  });
});

// A glob is a pattern matched against the resolved path, translated into a
// Seatbelt regex here. The only characters with meaning are "*", "**" and "?";
// anything else that looks like a glob is refused rather than emitted as a
// literal that could never match.
describe("glob entries", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-glob-ws");

  before(() => {
    // A monorepo's shape: one node_modules at the root, one per package.
    fs.copyFileSync(
      "/bin/date",
      path.join(makeDir("exec-glob-ws", "node_modules", ".bin"), "tool"),
    );
    fs.copyFileSync(
      "/bin/date",
      path.join(makeDir("exec-glob-ws", "packages", "app", "node_modules", ".bin"), "tool"),
    );
    fs.copyFileSync("/bin/date", path.join(workspace, "elsewhere"));

    sandbox = probeWithExec(
      workspace,
      ["/bin/d*", "./**/node_modules/**"],
      [
        `p star_match    '/bin/date'`,
        `p star_no_match '/bin/echo x'`,
        `p root_modules   './node_modules/.bin/tool'`,
        `p nested_modules './packages/app/node_modules/.bin/tool'`,
        `p outside        './elsewhere'`,
      ].join("\n"),
    );
  });

  it("a '*' matches within one path segment", () => {
    assert.equal(sandbox.probe("star_match"), "allowed");
    assert.equal(sandbox.probe("star_no_match"), "denied");
  });

  it("a '**' spans directories, so a nested node_modules is reached", () => {
    assert.equal(sandbox.probe("root_modules"), "allowed");
    assert.equal(sandbox.probe("nested_modules"), "allowed");
  });

  it("and grants nothing beside the pattern", () => {
    assert.equal(sandbox.probe("outside"), "denied");
  });

  for (const [label, entry] of [
    ["a character class", "/bin/d[a-z]te"],
    ["a brace group", "/bin/{date,echo}"],
  ] as const) {
    it(`${label} stops the run`, () => {
      const refused = sandboxRun({
        extraDomains: "",
        cwd: workspace,
        script: `echo ${SENTINEL}`,
        env: { CSB_EXTRA_EXEC: entry },
      });
      assert.ok(!refused.printed(SENTINEL), `expected nothing to run, got:\n${refused.output}`);
      assert.ok(
        refused.printed("a glob here is"),
        `expected the refusal to say why, got:\n${refused.output}`,
      );
    });
  }
});

// The node-modules-exec profile is a glob for the reason above: a pnpm, npm or
// yarn workspace keeps a node_modules per package as well as the root one.
describe("the node-modules-exec profile, in a monorepo", () => {
  const workspace = makeDir("exec-monorepo-ws");

  before(() => {
    fs.copyFileSync(
      "/bin/date",
      path.join(makeDir("exec-monorepo-ws", "packages", "app", "node_modules", ".bin"), "tool"),
    );
  });

  it("reaches a package's own node_modules", () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      env: { CSB_PROFILES: "node-modules-exec", CSB_EXTRA_EXEC: SLEEP },
      script: `p nested './packages/app/node_modules/.bin/tool'`,
    });
    assert.equal(sandbox.probe("nested"), "allowed");
  });
});

describe("the workspace-exec profile", () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-profile-ws");

  before(() => {
    fs.copyFileSync("/bin/date", path.join(workspace, "copied-date"));
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      env: { CSB_PROFILES: "workspace-exec", CSB_EXTRA_EXEC: SLEEP },
      script: [`p copied_binary './copied-date'`, `p still_denied  '/bin/echo hello'`].join("\n"),
    });
  });

  it("opens the workspace for execution", () => {
    assert.equal(sandbox.probe("copied_binary"), "allowed");
  });

  it("and leaves the rest of the machine as it was", () => {
    assert.equal(sandbox.probe("still_denied"), "denied");
  });
});

describe("the unix profile", { skip: skipUnlessPresent("/usr/bin/sed", "/bin/ls") }, () => {
  let sandbox: SandboxResult;
  const workspace = makeDir("exec-unix-ws");

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      env: { CSB_PROFILES: "unix", CSB_EXTRA_EXEC: "" },
      script: [
        `p toolbox 'ls / | sed -n 1p'`,
        // /usr/bin/strings is an xcselect stub that re-execs the developer
        // tools' copy, so this is two execs, and the profile has to name both.
        `p strings 'strings /bin/ls'`,
        // Not in the toolbox, and the profile is not a way to get at it.
        `p curl    'curl --version'`,
        `p python  'python3 -c "print(1)"'`,
      ].join("\n"),
    });
  });

  it("brings the everyday commands", () => {
    assert.equal(sandbox.probe("toolbox"), "allowed");
  });

  it("including the one that is a stub for the developer tools", () => {
    assert.equal(sandbox.probe("strings"), "allowed");
  });

  it("without bringing curl", () => {
    assert.equal(sandbox.probe("curl"), "denied");
  });

  it("or an interpreter", () => {
    assert.equal(sandbox.probe("python"), "denied");
  });
});

describe("CSB_EXTRA_EXEC entries that must stop the run", () => {
  const workspace = makeDir("exec-invalid-ws");
  const cases: Array<[label: string, value: string]> = [
    ["a bare command name", "date"],
    ["a relative path without './'", "tools/date"],
    ["a bare tilde", "~"],
    ["one bad entry among good ones", "/bin/date:date"],
  ];

  for (const [label, value] of cases) {
    it(`${label} stops the run`, () => {
      const sandbox = sandboxRun({
        extraDomains: "",
        cwd: workspace,
        script: `echo ${SENTINEL}`,
        env: { CSB_EXTRA_EXEC: value },
      });
      assert.ok(!sandbox.printed(SENTINEL), `expected nothing to run, got:\n${sandbox.output}`);
      assert.notEqual(sandbox.status, 0);
    });
  }
});
