// What the gh and node profiles add on a machine that has the tool they are for.
//
// Integration rather than unit: a CI runner has no ~/.config/gh, and its pnpm
// lives in ~/setup-pnpm, which is no version manager's root and so nothing the
// node profile reaches. What those profiles do on *any* macOS — domains, the
// write override, the shell it takes to start a shim — is in
// tests/profiles.test.ts.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  inHome,
  makeDir,
  repoRoot,
  type SandboxResult,
  sandboxProbe,
  skipUnlessPresent,
  skipUnlessProfileReachesPnpm,
} from "../helpers.ts";

// A value, because the gh profile refuses to run without one. Nothing here
// authenticates against GitHub — CSB_CLAUDE is /bin/sh.
const token = { GH_TOKEN: "test-token" };

const ghConfigDir = inHome(".config", "gh");
const corepackCache = inHome(".cache", "node");
const workspace = makeDir("integration-profiles-ws");

describe("the gh profile and ~/.config/gh", { skip: skipUnlessPresent(ghConfigDir) }, () => {
  // extraRead opens a path to read, not to write, exactly as CSB_EXTRA_READ does.
  it("is readable with the profile, and not writable", () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      env: { ...token, CSB_PROFILES: "gh" },
      script: [
        `p read_gh_config  'ls "${ghConfigDir}"'`,
        `p write_gh_config 'touch "${ghConfigDir}/injected"'`,
      ].join("\n"),
    });
    assert.equal(sandbox.probe("read_gh_config"), "allowed");
    assert.equal(sandbox.probe("write_gh_config"), "denied");
  });

  it("is not readable without the profile", () => {
    const sandbox = sandboxProbe({
      extraDomains: "",
      cwd: workspace,
      script: `p read_gh_config 'ls "${ghConfigDir}"'`,
    });
    assert.equal(sandbox.probe("read_gh_config"), "denied");
  });
});

describe("the node profile", { skip: skipUnlessProfileReachesPnpm() }, () => {
  let sandbox: SandboxResult;
  // Where the formatter probe puts its scratch file. Inside this repository,
  // since that is the workspace here, and gitignored.
  const scratch = path.join(repoRoot, ".testenv");

  before(() => {
    // The probes below use `touch`, which cannot create a file whose parent is
    // missing — without this a denial could as easily be ENOENT as EPERM. This
    // is the directory vite makes for itself in a project that uses it.
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".vite-temp"), { recursive: true });
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: repoRoot,
      env: { CSB_PROFILES: "node node-modules-exec" },
      script: [
        `p pnpm_resolves 'command -v pnpm'`,
        // The base deny, which this profile no longer lifts. That is
        // node-modules-writable's job, and it is not selected here.
        `p write_vite_temp 'touch node_modules/.vite-temp/probe.mjs'`,
        `p write_nm_pkg    'touch node_modules/probe.js'`,
        `p write_nm_bin    'touch node_modules/.bin/probe'`,
        `p read_node_cache  'ls "${corepackCache}"'`,
        `p write_node_cache 'touch "${corepackCache}/probe"'`,
        `p pnpm_lint     'pnpm lint'`,
        `p pnpm_format   'pnpm format:check'`,
        // `pnpm format` differs from `format:check` only in writing, so the
        // write is proven on a scratch file rather than by reformatting the
        // repository from inside a test. Written, formatted and checked inside
        // the sandbox, so the probe's exit status is the whole claim.
        `p oxfmt_writes  'mkdir -p .testenv && printf "export  const   x =   {a:1,b:2}\\n" > .testenv/messy.ts && pnpm exec oxfmt .testenv/messy.ts && grep -q "const x = { a: 1, b: 2 }" .testenv/messy.ts'`,
      ].join("\n"),
    });
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
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
  });
});
