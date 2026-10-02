import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Figure out where the binary is.
export const repoRoot = path.resolve(import.meta.dirname, "..");
export const entryPoint = path.join(repoRoot, "dist", "claude-seatbelt.js");
if (!fs.existsSync(entryPoint)) {
  throw new Error(`${entryPoint} is missing — run \`pnpm build\` first`);
}

// Everything a test writes goes under one directory in this user's cache, not
// under the repo, so nothing depends on where the checkout sits. Inside $HOME on
// purpose: read is allow-by-default, and $HOME is the region the policy denies, so
// a sibling of the workspace is unreadable here for the reason the probes test,
// and here is where repositories live in practice. Not a system temp directory:
// $TMPDIR, /private/tmp and /private/var/tmp are opened wholesale, and so is
// ~/.cache/claude, which is why this is a directory beside it.
const testEnv = path.join(os.homedir(), ".cache", "claude-seatbelt");
fs.mkdirSync(testEnv, { recursive: true });

// One directory per test process so that tests can run in parallel.
export const testTmp = fs.mkdtempSync(path.join(testEnv, "test."));
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
  /** What the invocation wrote to STDOUT, which belongs to the sandboxed command. */
  readonly stdout: string;
  /** What it wrote to STDERR, where this tool says everything it has to say. */
  readonly stderr: string;
  /** Both together, for a claim that does not care which stream carried it. */
  readonly output: string;
  /** The exit status, or null if the process died from a signal. */
  readonly status: number | null;

  constructor(stdout: string, stderr: string, status: number | null) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.output = `${stdout}${stderr}`;
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

/**
 * What every test may execute, on top of the base allowlist.
 *
 * Execution is denied by default, so a probe that runs `cat` on a denied file
 * would otherwise report "denied" whatever the filesystem policy says, and the
 * probes that must come back "allowed" could not pass at all. These are the
 * commands the probes themselves are built from — `sleep`, which the timeout
 * loop needs, among them. A test about the exec allowlist sets CSB_EXTRA_EXEC
 * to something of its own instead.
 */
export const PROBE_EXEC = [
  "/bin/cat",
  "/bin/ls",
  "/bin/mkdir",
  "/bin/rmdir",
  "/bin/rm",
  "/bin/cp",
  "/bin/mv",
  "/bin/ln",
  "/bin/echo",
  "/bin/sleep",
  "/bin/date",
  "/bin/chmod",
  "/bin/test",
  "/usr/bin/touch",
  "/usr/bin/head",
  "/usr/bin/tail",
  "/usr/bin/find",
  "/usr/bin/grep",
  "/usr/bin/env",
  "/usr/bin/which",
  "/usr/bin/printf",
  "/usr/bin/stat",
  "/usr/bin/true",
  "/usr/bin/false",
  // The probes for the boundaries themselves: the network, the keychain and the
  // pasteboard. Being able to start them is what lets a test tell a denial from
  // a missing command.
  "/usr/bin/curl",
  "/usr/bin/nc",
  "/usr/bin/security",
  "/usr/bin/pbcopy",
  "/usr/bin/pbpaste",
].join(":");

/** Run one claude-seatbelt invocation and collect everything it wrote. */
export function sandboxRun(options: SandboxOptions): SandboxResult {
  const result = spawnSync(process.execPath, [entryPoint, "-c", options.script], {
    cwd: options.cwd,
    encoding: "utf8",
    // Long enough for srt to bring its proxy up plus a 15s probe cap, short
    // enough that a genuine hang fails the run instead of stalling it.
    timeout: 180_000,
    env: sandboxEnv(options),
  });
  return new SandboxResult(result.stdout ?? "", result.stderr ?? "", result.status);
}

/** The environment every invocation starts from, with the test's own on top. */
function sandboxEnv(options: SandboxOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Each test picks its workspace with `cwd`. An ambient CSB_WORKSPACE would
    // override that for every one of them and still let them pass, so it is
    // cleared unless a test sets it deliberately.
    CSB_WORKSPACE: "",
    // Likewise for everything else ambient that would widen or narrow a run.
    CSB_PROFILES: "",
    CSB_EXTRA_READ: "",
    CSB_EXTRA_WRITE: "",
    CSB_UNSET_ENV: "",
    CSB_EXTRA_EXEC: PROBE_EXEC,
    CSB_EXTRA_DOMAINS: options.extraDomains,
    CSB_CLAUDE: "/bin/sh",
    // Required, and never actually authenticated against: CSB_CLAUDE is
    // /bin/sh. A test that is about the requirement itself clears it again
    // through `env`.
    CLAUDE_CODE_OAUTH_TOKEN: "test-token",
    ...options.env,
  };
}

/** A claude-seatbelt invocation that is still running. */
export interface RunningSandbox {
  /** Send a signal to claude-seatbelt itself — not to the sandboxed command. */
  kill(signal: NodeJS.Signals): void;
  /** Resolves once the run has printed the marker, or rejects after 60s. */
  printed(marker: string): Promise<void>;
  /** The result, once the run has ended. */
  finished: Promise<SandboxResult>;
}

/**
 * Start one claude-seatbelt invocation and hand back the means to act on it
 * while it runs. For claims about what happens to a run *during* the run —
 * a signal, for one — where sandboxRun's wait-for-the-end cannot get a word in.
 */
export function sandboxStart(options: SandboxOptions): RunningSandbox {
  const child = spawn(process.execPath, [entryPoint, "-c", options.script], {
    cwd: options.cwd,
    env: sandboxEnv(options),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const watchers: Array<() => void> = [];
  const notify = (): void => {
    for (const watcher of watchers) watcher();
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    notify();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    notify();
  });

  const finished = new Promise<SandboxResult>((resolve) => {
    child.on("exit", (status) => {
      resolve(new SandboxResult(stdout, stderr, status));
    });
  });

  return {
    kill: (signal) => {
      child.kill(signal);
    },
    printed: (marker) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`never printed: ${marker}`)), 60_000);
        const check = (): void => {
          if (stdout.includes(marker) || stderr.includes(marker)) {
            clearTimeout(timer);
            resolve();
          }
        };
        watchers.push(check);
        check();
      }),
    finished,
  };
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

/** A path in this user's home. */
export function inHome(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

/** Write a file to the given path. */
export function writeFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/**
 * A skip reason when a path the test depends on is not on this machine, and
 * undefined when it is.
 */
export function skipUnlessPresent(...targets: string[]): string | undefined {
  const absent = targets.filter((target) => !fs.existsSync(target));
  return absent.length === 0 ? undefined : warnSkip(`not on this machine: ${absent.join(", ")}`);
}

/** The real path of the first `pnpm` on PATH, or undefined when there is none. */
export function resolvePnpm(): string | undefined {
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
export function skipUnlessPnpmIsUnderHome(): string | undefined {
  const pnpm = resolvePnpm();
  if (pnpm?.startsWith(`${os.homedir()}${path.sep}`)) return undefined;
  return warnSkip(`pnpm is not under $HOME on this machine (${pnpm ?? "none on PATH"})`);
}

/** The pnpm-bearing roots of the `node` profile. */
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
 * and undefined when it does. A CI runner's pnpm lives in ~/setup-pnpm, which is
 * no version manager's root, so this is what keeps the node suite out of CI.
 */
export function skipUnlessProfileReachesPnpm(): string | undefined {
  const roots = NODE_PROFILE_ROOTS.map((suffix) => inHome(suffix));
  const pnpm = resolvePnpm();
  if (pnpm !== undefined && roots.some((root) => pnpm.startsWith(`${root}${path.sep}`))) {
    return undefined;
  }
  return warnSkip(
    `the node profile does not reach this machine's pnpm (${pnpm ?? "none on PATH"})`,
  );
}

/** Warn about skipped tests. */
export function warnSkip(reason: string): string {
  if (process.env["GITHUB_ACTIONS"] === "true") {
    // Workflow commands are read off stdout, and the message has to survive the
    // parser: percent first, or it would eat the escapes that follow.
    const escaped = reason.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    process.stdout.write(`::warning title=Test skipped::${escaped}\n`);
  } else {
    process.stderr.write(`⚠ test skipped: ${reason}\n`);
  }
  return reason;
}
