import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Figure out where the binary is.
export const repoRoot = path.resolve(import.meta.dirname, "..");
export const entryPoint = path.join(repoRoot, "dist", "claude-seatbelt.js");
if (!fs.existsSync(entryPoint)) {
  throw new Error(`${entryPoint} is missing — run \`pnpm build\` first`);
}

// Create a temporary folder inside the repo root for the workspace. This must sit
// outside of $TMPDIR, /private/tmp and /private/var/tmp. The policy opens those up
// wholesale which would interfere with our tests.
export const testTmp = fs.mkdtempSync(path.join(repoRoot, ".test-tmp."));
process.on("exit", () => {
  fs.rmSync(testTmp, { recursive: true, force: true });
});

/** Options to pass to binary. */
export interface SandboxOptions {
  /** Value for CSB_EXTRA_DOMAINS. */
  extraDomains: string;
  /** Working directory, which becomes the sandbox workspace. */
  cwd: string;
  /** Shell snippet to run under the sandbox. */
  script: string;
  /** Extra environment for claude-seatbelt itself, e.g. CSB_EXTRA_READ. */
  env?: Record<string, string>;
}

/** Result of calling the binary. */
export class SandboxResult {
  /** Everything the invocation wrote, stdout and stderr together. */
  readonly output: string;
  /** The exit status, or null if the process died from a signal. */
  readonly status: number | null;

  constructor(output: string, status: number | null) {
    this.output = output;
    this.status = status;
  }

  /** What a named probe reported, or "missing" if it never got that far. */
  probe(name: string): ProbeResult {
    const match = this.output.match(new RegExp(`^PROBE ${name} (allowed|denied|timeout)$`, "m"));
    return (match?.[1] as ProbeResult | undefined) ?? "missing";
  }

  /** Whether the sandboxed command produced the given marker. */
  printed(marker: string): boolean {
    return this.output.includes(marker);
  }
}

/**
 * A blocked mach-lookup can hang the caller rather than fail it, so every probe
 * runs under a 15s cap. A timeout is reported as its own result: waiting forever
 * is not the same as being denied, and must not be scored as one.
 *
 * The probe's own output is discarded. Only reachable vs. not is the claim, and a
 * denied read and a missing file must not be told apart by whatever the command
 * happened to write.
 */
const PROBE_PRELUDE = `p() {
    n=$1; shift
    ( eval "$*" >/dev/null 2>&1 ) &
    _pid=$!
    _i=0
    while kill -0 $_pid 2>/dev/null; do
        _i=$((_i + 1))
        if [ $_i -gt 150 ]; then
            kill -9 $_pid 2>/dev/null
            wait $_pid 2>/dev/null
            echo "PROBE $n timeout"
            return
        fi
        sleep 0.1
    done
    if wait $_pid 2>/dev/null; then echo "PROBE $n allowed"; else echo "PROBE $n denied"; fi
}`;

/** Whether the sandboxed process could reach the thing, or why we cannot say. */
export type ProbeResult = "allowed" | "denied" | "timeout" | "missing";

/** Run one claude-seatbelt invocation and collect everything it wrote. */
export function sandboxRun(options: SandboxOptions): SandboxResult {
  const result = spawnSync(process.execPath, [entryPoint, "-c", options.script], {
    cwd: options.cwd,
    encoding: "utf8",
    // Long enough for an npx fetch of srt plus a 15s probe cap, short enough
    // that a genuine hang fails the run instead of stalling it.
    timeout: 180_000,
    env: {
      ...process.env,
      // Each test picks its workspace with `cwd`. An ambient CSB_WORKSPACE would
      // override that for every one of them and still let them pass, so it is
      // cleared unless a test sets it deliberately.
      CSB_WORKSPACE: "",
      CSB_EXTRA_DOMAINS: options.extraDomains,
      CSB_CLAUDE: "/bin/sh",
      // Required, and never actually authenticated against: CSB_CLAUDE is
      // /bin/sh. A test that is about the requirement itself clears it again
      // through `env`.
      CLAUDE_CODE_OAUTH_TOKEN: "test-token",
      ...options.env,
    },
  });
  return new SandboxResult(`${result.stdout ?? ""}${result.stderr ?? ""}`, result.status);
}

/** Run a probe script, with the `p` helper already defined. */
export function sandboxProbe(options: SandboxOptions): SandboxResult {
  return sandboxRun({
    ...options,
    script: `${PROBE_PRELUDE}\n${options.script}`,
  });
}

/** Make a workspace directory under the test root. */
export function makeDir(...parts: string[]): string {
  const dir = path.join(testTmp, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a file to the given path. */
export function writeFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
