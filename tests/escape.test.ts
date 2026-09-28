import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { makeDir, sandboxProbe, type SandboxResult } from "./helpers.ts";

const script = [
  `p open_dir       'open -g .'`,
  `p open_app       'open -g -a Finder .'`,
  String.raw`p osascript_app  'osascript -e "tell application \"Finder\" to get name"'`,
  `p osascript_eval 'osascript -e "return 1"'`,
].join("\n");

// The exec allowlist is the first thing in the way: neither command is on it, so
// neither starts, whatever the Apple Events policy behind them says.
describe("handing work to a process outside the sandbox", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: makeDir("escape-ws"),
      script,
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("open cannot run", () => {
    assert.equal(sandbox.probe("open_dir"), "denied");
  });

  it("open cannot launch a named application", () => {
    assert.equal(sandbox.probe("open_app"), "denied");
  });

  it("osascript cannot run", () => {
    assert.equal(sandbox.probe("osascript_eval"), "denied");
  });

  it("osascript cannot drive an already-running application", () => {
    assert.equal(sandbox.probe("osascript_app"), "denied");
  });
});

// What is left once someone puts those two on the allowlist themselves, which is
// where the sandbox's own Apple Events policy is all that remains.
describe("the same commands, allow-listed on purpose", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: makeDir("escape-allowed-ws"),
      script,
      env: { CSB_EXTRA_EXEC: "/usr/bin/open:/usr/bin/osascript:/bin/sleep" },
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("open still cannot hand a path to LaunchServices", () => {
    assert.equal(sandbox.probe("open_dir"), "denied");
  });

  it("open still cannot launch a named application", () => {
    assert.equal(sandbox.probe("open_app"), "denied");
  });

  // Evaluating AppleScript in-process is not an escape: it stays inside the
  // sandbox. Only talking to another application is. This is here so the gap
  // below is not mistaken for "osascript is blocked".
  it("evaluating AppleScript in-process works", () => {
    assert.equal(sandbox.probe("osascript_eval"), "allowed");
  });

  // KNOWN GAP, and the one that matters: `allowAppleEvents: false` does not stop
  // osascript driving an application that is already running. Anything that
  // application can do is outside the sandbox. The exec allowlist is what keeps
  // this out of reach by default; allow-listing osascript gives it back.
  //
  // Asserted as it actually behaves, so the gap is reported on every run rather
  // than sitting in a comment, and so the suite stays green on a known state. If
  // it ever stops being reachable this DOES fail, which is the point: that is
  // the signal to promote it to `assert.equal(..., "denied")` and drop the
  // "Known gap" section from the README.
  //
  // Upstream fix: github.com/anthropics/sandbox-runtime/pull/557
  it("osascript can still drive an already-running application (known gap)", (t) => {
    const actual = sandbox.probe("osascript_app");
    assert.equal(
      actual,
      "allowed",
      `known gap has closed: osascript now reports "${actual}" — promote this to assert.equal(..., "denied") and update the README`,
    );
    t.diagnostic("known gap: allowAppleEvents:false does not block Apple Events to a running app");
  });
});
