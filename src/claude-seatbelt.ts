#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxManager, SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";

// Ensure the node version before anything else as the rest of this module leans
// on it.
ensureNodeJsVersion(20, 11);

/** Ensure that we're on a specific version of Node.js or exit otherwise. */
function ensureNodeJsVersion(major: number, minor: number): void {
  const parts = process.versions.node.split(".").map(Number);
  const [haveMajor = 0, haveMinor = 0] = parts;
  if (haveMajor < major || (haveMajor === major && haveMinor < minor)) {
    die(`Node >= ${major}.${minor} required, running ${process.versions.node}`);
  }
}

/** The user's home folder. */
const homeDir = fs.realpathSync(os.homedir());

/** What Claude itself needs to function. */
const BASE_DOMAINS = [
  "api.anthropic.com",
  "platform.claude.com",
  "claude.com",
  "claude.ai",
  "mcp-proxy.anthropic.com",
  "downloads.claude.ai",
] as const;

/** What ports are allowed on domains. */
const PERMITTED_PORTS = [80, 443] as const;

/** What an environment variable may be called, for CSB_UNSET_ENV and requiredEnv alike. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The regions denied for reading. Read is allow-by-default in srt, so these are
 * closed as a whole and then re-opened path by path in buildSrtSettings.
 */
const DENY_READ = [
  // This user's home.
  homeDir,
  // Every other account's home, and /Users/Shared with it.
  "/Users",
  // External disks, network shares and mounted images, any of which can
  // carry a second home directory.
  "/Volumes",
  // The system keychains. Unlike this user's keychains, they do not sit
  // under any of the regions above, and System.keychain is mode 0644.
  "/Library/Keychains",
] as const;

/** The profiles shipped with the tool, beside dist/ in an installed package. */
const BUILT_IN_PROFILES = path.join(import.meta.dirname, "..", "profiles.jsonc");

/** Read environment variables and apply default values where needed. */
const config = {
  extraDomains: words(process.env["CSB_EXTRA_DOMAINS"] ?? ""),
  extraRead: paths("CSB_EXTRA_READ"),
  extraWrite: paths("CSB_EXTRA_WRITE"),
  extraExec: paths("CSB_EXTRA_EXEC", true),
  profiles: words(process.env["CSB_PROFILES"] ?? ""),
  unsetEnv: words(process.env["CSB_UNSET_ENV"] ?? ""),
  workspace: resolveDir(process.env["CSB_WORKSPACE"] || "."),
  tmpDir: resolveDir(process.env["TMPDIR"] || "/tmp"),
  claude: resolveClaude(process.env["CSB_CLAUDE"] ?? ""),
  token: process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "",
  shell: loginShell(),
} as const;

/** Split a space-separated list the way the shell would, dropping empties. */
function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/** The paths in a colon-separated variable (PATH-style) with "~/" expanded. */
function paths(variable: string, allowRelative = false): string[] {
  const entries = (process.env[variable] ?? "").split(":").filter(Boolean);
  const rejections: string[] = [];
  for (const entry of entries) {
    if (!isValidPathEntry(entry, allowRelative)) {
      rejections.push(`'${entry}' is ${validPathEntryForms(allowRelative)}`);
    }
    // Only an exec entry is a pattern this tool matches itself; the others go
    // to srt, which has its own idea of a glob.
    const unsupported = allowRelative ? unsupportedGlob(entry) : undefined;
    if (unsupported) {
      rejections.push(`'${entry}' uses '${unsupported}': a glob here is '*', '**' or '?' only`);
    }
  }
  if (rejections.length > 0) {
    for (const rejection of rejections) {
      note(`${variable}: ${rejection}`);
    }
    die(`refusing to run: ${rejections.length} invalid entry/entries in ${variable}`);
  }
  return entries.map(expandHome);
}

/** Whether a path entry is valid (absolute, under $HOME or, if allowed, relative). */
function isValidPathEntry(entry: string, allowRelative = false): boolean {
  if (allowRelative && entry.startsWith("./")) return true;
  return entry.startsWith("/") || entry.startsWith("~/");
}

/** How a rejected path entry failed. */
function validPathEntryForms(allowRelative: boolean): string {
  return allowRelative
    ? "neither absolute nor under '~/' or './'"
    : "neither absolute nor under '~/";
}

/** Locate a binary from PATH. */
function which(command: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    // Only consider absolute entries to avoid accidentally resolving against
    // the working directory.
    if (!dir.startsWith("/")) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here, keep looking.
    }
  }
  return null;
}

/**
 * The binary this run is pointed at, in a form the exec allowlist can name:
 * absolute, under "~/", or a bare name to find on PATH — which is how `claude`
 * itself is found when CSB_CLAUDE is unset. A relative path is refused: the
 * allowlist would carry it as a literal that matches nothing, and it would be
 * run from wherever the wrapper happened to be started rather than from the
 * workspace. Something that is not an executable file is refused for the same
 * reason a missing profile is: better one line now than a sandbox that starts
 * and has nothing to run.
 */
function resolveClaude(requested: string): string {
  const name = requested || "claude";
  if (!name.includes("/")) {
    return which(name) ?? die(`'${name}' not found in PATH${requested ? "" : " (set CSB_CLAUDE)"}`);
  }
  if (!isValidPathEntry(name)) {
    die(`CSB_CLAUDE: '${name}' is neither absolute, under '~/', nor a bare name to find on PATH`);
  }
  const claude = expandHome(name);
  try {
    fs.accessSync(claude, fs.constants.X_OK);
    if (!fs.statSync(claude).isFile()) throw new Error("not a file");
  } catch {
    die(`CSB_CLAUDE: '${claude}' is not an executable file`);
  }
  return claude;
}

/** Determines this account's login shell by resolving $SHELL. */
function loginShell(): string {
  const shell = process.env["SHELL"] ?? "";
  if (!shell) return "";
  return shell.startsWith("/") ? shell : (which(shell) ?? "");
}

/**
 * What a script's shebang line execs, for a CSB_CLAUDE that is a script rather
 * than a binary: an npm or Homebrew install of Claude is `#!/usr/bin/env node`.
 * The interpreter is an exec of its own, checked against the allowlist before
 * the script runs a line, so it has to be on the list too. `/usr/bin/env X` is
 * two execs — env, then whatever X resolves to on PATH — and both are named.
 *
 * Empty for a binary, which has no shebang, and for a script whose interpreter
 * is not there to be found: nothing to allow, and the run fails the way it would
 * have without this.
 */
function shebangInterpreters(file: string): string[] {
  let head: string;
  try {
    // Only the first line matters, and 256 bytes is more than any shebang.
    const fd = fs.openSync(realPath(file), "r");
    try {
      const buffer = Buffer.alloc(256);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.toString("utf8", 0, length);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  if (!head.startsWith("#!")) return [];

  const line = head.slice(2).split("\n")[0] ?? "";
  const [interpreter = "", argument = ""] = line.trim().split(/\s+/);
  if (!interpreter.startsWith("/")) return [];

  const interpreters = [interpreter];
  // `#!/usr/bin/env node`: env is what the kernel execs, node is what env then
  // execs. A flag in that position (`env -S …`) is not a name to look up.
  if (path.basename(interpreter) === "env" && argument && !argument.startsWith("-")) {
    const target = which(argument);
    if (target) interpreters.push(target);
  }
  return interpreters;
}

/** Resolve a directory, failing with one line rather than a stack trace. */
function resolveDir(target: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    die(`does not exist: ${target}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    die(`not a directory: ${target}`);
  }
  return resolved;
}

/** Print a message to STDERR and exit. */
function die(message: string): never {
  note(message);
  process.exit(1);
}

/** Print a message to STDERR. */
function note(message: string): void {
  console.error(`claude-seatbelt: ${message}`);
}

/** The ... well ... main function. */
async function main(): Promise<never> {
  // Ensure we can run on this platform.
  if (!SandboxManager.isSupportedPlatform() || process.platform !== "darwin") {
    die(`unsupported platform: ${process.platform}`);
  }

  // Ensure we have a Claude token.
  ensureToken();

  // Deny a workspace that is, or holds, a region denied for reading. Otherwise
  // allowRead and allowWrite would open it again as a whole.
  if (DENY_READ.find((region) => isAtOrUnder(region, config.workspace))) {
    die(`refusing to run with ${config.workspace} as the workspace`);
  }

  // Move into the workspace before srt builds anything. srt anchors its own
  // mandatory write denies — .mcp.json, .claude/commands, .vscode, .git/hooks —
  // at process.cwd() when the profile is built.
  process.chdir(config.workspace);

  // Load the selected profiles.
  const profiles = applyProfiles(config.profiles);

  // Ensure that what CSB_UNSET_ENV names can be unset.
  ensureUnsetEnv(config.unsetEnv, profiles.requiredEnv);

  // Construct the srt settings.
  const allowedDomains = buildAllowedDomains([
    ...BASE_DOMAINS,
    ...config.extraDomains,
    ...profiles.extraDomains,
  ]);
  const settings = buildSrtSettings({
    workdir: config.workspace,
    tmpDir: config.tmpDir,
    allowedDomains,
    extraRead: [...config.extraRead, ...profiles.extraRead],
    extraWrite: [...config.extraWrite, ...profiles.extraWrite],
    denyWriteOverrides: profiles.denyWriteOverrides,
    allowMachLookup: profiles.allowMachLookup,
    unsetEnv: config.unsetEnv,
  });

  // Validate the srt settings before passing them on.
  const parsed = SandboxRuntimeConfigSchema.safeParse(settings);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      note(`settings: ${issue.path.join(".")}: ${issue.message}`);
    }
    die(`refusing to run: ${parsed.error.issues.length} problem(s) in the generated settings`);
  }

  // Collect all allowed executable paths.
  const allowExec = [
    // The shell srt starts INSIDE the sandbox, which then starts Claude. Also
    // what Claude itself falls back to for running commands when $SHELL is unset.
    "/bin/bash",
    // This account's login shell, which is what Claude runs commands with.
    ...(config.shell ? [config.shell] : []),
    // The (Claude) binary this run is pointed at, and — when it is a script
    // rather than a binary — whatever its shebang line hands over to.
    config.claude,
    ...shebangInterpreters(config.claude),
    // ~/.local/bin/claude symlinks into one of these directories. We allow-list
    // the entire folder so that an in-place update does not lock the user out.
    "~/.local/share/claude/versions/**",
    // Whatever is explicitly requested through CSB_EXTRA_EXEC.
    ...config.extraExec,
    // Whatever the profiles selected through CSB_PROFILES add on top.
    ...profiles.extraExec,
  ];

  // Announce where and how we're running.
  note(`workspace ${config.workspace}`);
  if (config.unsetEnv.length > 0) {
    note(`unset ${config.unsetEnv.join(" ")}`);
  }
  note(`srt settings: ${JSON.stringify(parsed.data, null, 2)}\n`);
  note(`exec rules: ${buildExecRules(allowExec)}`);

  // Bring up the proxy and the rest of srt's session state.
  await SandboxManager.initialize(parsed.data);

  // Signals, in two parts.
  //
  // Claude owns the terminal and handles Ctrl-C itself. A terminal-generated
  // signal goes to the whole foreground process group, so the child already has
  // its own copy; this process only has to survive it so that the proxy stays up
  // and the teardown below runs after the child is gone.
  //
  // But initialize() has just registered `process.once("SIGINT" | "SIGTERM",
  // reset)` of its own, and reset() closes the proxies. Node runs every
  // listener, so a no-op beside it would not help: a SIGTERM to this process, or
  // a Ctrl-C reaching it while Claude is not in raw mode, would tear the proxy
  // down under a child that keeps running, and every request from then on would
  // fail with ECONNREFUSED. So srt's listeners come out again. Its "exit"
  // listener is left alone: by then there is nothing left to serve.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.removeAllListeners(signal);
    process.on(signal, () => {});
  }

  // Construct the plain shell command to launch the binary.
  const command = quoteShellArgs([config.claude, ...process.argv.slice(2)]);

  // Wrap the command to run in the sandbox. The shell argument is what srt launches
  // inside the sandbox and has to be in the allowed executables injected below. We
  // pick bash here because `bash -c` sources nothing and Claude falls back to bash
  // when $SHELL cannot be resolved anyway.
  const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash");

  // Inject our own execution policy into the generated seatbelt profile. srt itself
  // just emits a blanket `(allow process-exec)` which our spliced rules override to
  // take precedence.
  const sandboxed = spliceExecRules(wrapped, allowExec);

  // Spawn it the combined command.
  const result = await run("/bin/sh", ["-c", sandboxed]);

  // We're done, time to clean up.
  SandboxManager.cleanupAfterCommand();
  await SandboxManager.reset();

  // Re-raise if spawning failed with an error.
  if (result.error) {
    die(`failed to run the sandboxed command: ${result.error.message}`);
  }

  // Report a signal death the way a shell would, so `$?` means the same thing
  // whichever of the two entry points started it.
  if (result.signal) {
    process.exit(128 + (os.constants.signals[result.signal] ?? 0));
  }
  process.exit(result.status ?? 1);
}

/** What a finished child process leaves behind, whichever way it ended. */
interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** Run a command to completion without blocking the event loop the proxy runs on. */
function run(file: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      stdio: "inherit",
      // Inherited from this process, which moved into the workspace before srt
      // built the profile. Named anyway, so that it is a decision here and not a
      // consequence of the chdir above.
      cwd: config.workspace,
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
    });
    child.on("error", (error) => {
      resolve({ status: null, signal: null, error });
    });
    child.on("exit", (status, signal) => {
      resolve({ status, signal });
    });
  });
}

/** Ensure that a token was supplied for Claude, or exit explaining how to get one. */
function ensureToken(): void {
  if (config.token) return;
  note(
    "CLAUDE_CODE_OAUTH_TOKEN is not set, and the sandbox denies the macOS keychain. " +
      "Create a token outside the sandbox with `claude setup-token`, then export it " +
      "before running claude-seatbelt.",
  );
  die("refusing to run without a token");
}

/**
 * Check the variables named in CSB_UNSET_ENV, or exit saying what is wrong with
 * them. A name that is not set is no error. A name a selected profile requires is
 * refused.
 */
function ensureUnsetEnv(unset: string[], required: string[]): void {
  const rejections: string[] = [];
  for (const name of unset) {
    if (!ENV_NAME.test(name)) {
      rejections.push(`'${name}' is not a valid environment variable name`);
    } else if (required.includes(name)) {
      rejections.push(`'${name}' is required by a selected profile`);
    }
  }
  if (rejections.length > 0) {
    for (const rejection of rejections) {
      note(rejection);
    }
    die(`refusing to run: ${rejections.length} invalid entry/entries in CSB_UNSET_ENV`);
  }
}

/** Whether `target` is `dir` itself or lies below it, by path segment. */
function isAtOrUnder(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir === "/" ? "/" : `${dir}/`);
}

/**
 * A profile: a named bundle of additions, on top of what the base policy and
 * the CSB_EXTRA_* variables already grant.
 */
interface Profile {
  /** One line, for the reader of the profiles file. */
  description?: string;
  /** Appended to CSB_EXTRA_DOMAINS. */
  extraDomains?: string[];
  /** Appended to CSB_EXTRA_READ. */
  extraRead?: string[];
  /** Appended to CSB_EXTRA_WRITE. */
  extraWrite?: string[];
  /** Appended to CSB_EXTRA_EXEC. */
  extraExec?: string[];
  /** denyWrite entries to replace in the base policy. An empty list drops the entry outright. */
  denyWriteOverrides?: Record<string, string[]>;
  /** XPC/Mach services to open, srt's `network.allowMachLookup`. */
  allowMachLookup?: string[];
  /** Environment variables the profile needs, by name. */
  requiredEnv?: string[];
}

/** The list-valued keys of a profile, all optional and all additive. */
const PROFILE_LISTS = [
  "extraDomains",
  "extraRead",
  "extraWrite",
  "extraExec",
  "allowMachLookup",
  "requiredEnv",
] as const;

/** What CSB_PROFILES adds up to, once the named profiles are applied in order. */
interface ProfileAdditions {
  extraDomains: string[];
  extraRead: string[];
  extraWrite: string[];
  extraExec: string[];
  denyWriteOverrides: Record<string, string[]>;
  allowMachLookup: string[];
  requiredEnv: string[];
}

/**
 * Apply the profiles named in CSB_PROFILES, in the order given.
 *
 * Nothing is deduplicated. A path or domain listed twice is harmless in srt, and
 * collapsing them would only make the generated settings file harder to match up
 * against the profiles that produced it.
 */
function applyProfiles(profiles: string[]): ProfileAdditions {
  const additions: ProfileAdditions = {
    extraDomains: [],
    extraRead: [],
    extraWrite: [],
    extraExec: [],
    denyWriteOverrides: {},
    allowMachLookup: [],
    requiredEnv: [],
  };

  if (profiles.length === 0) {
    return additions;
  }

  const available = readProfiles(BUILT_IN_PROFILES);
  const missingEnv: string[] = [];

  for (const name of profiles) {
    const profile = available.get(name);
    if (!profile) {
      const known = [...available.keys()].toSorted().join(", ") || "none";
      die(`unknown profile '${name}' (known: ${known})`);
    }

    additions.extraDomains.push(...(profile.extraDomains ?? []));
    additions.extraRead.push(...(profile.extraRead ?? []).map(expandHome));
    additions.extraWrite.push(...(profile.extraWrite ?? []).map(expandHome));
    additions.extraExec.push(...(profile.extraExec ?? []).map(expandHome));

    // The later profile wins on a key both name.
    Object.assign(additions.denyWriteOverrides, profile.denyWriteOverrides ?? {});
    additions.allowMachLookup.push(...(profile.allowMachLookup ?? []));
    additions.requiredEnv.push(...(profile.requiredEnv ?? []));

    for (const variable of profile.requiredEnv ?? []) {
      if (!process.env[variable]) {
        missingEnv.push(`${variable} (needed by profile '${name}')`);
      }
    }
  }

  if (missingEnv.length > 0) {
    for (const missing of missingEnv) {
      note(`environment variable is not set: ${missing}`);
    }
    die(`refusing to run: ${missingEnv.length} required environment variable(s) unset`);
  }

  note(`profiles ${profiles.join(" ")}`);
  return additions;
}

/** Parse and validate the profiles file, or exit saying what is wrong with it. */
function readProfiles(file: string): Map<string, Profile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
  } catch (error) {
    die(`cannot read profiles from ${file}: ${error instanceof Error ? error.message : error}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    die(`${file} must contain a JSON object mapping profile names to profiles`);
  }

  const profiles = new Map<string, Profile>();
  const rejections: string[] = [];

  for (const [name, value] of Object.entries(parsed)) {
    const where = `${file}: profile '${name}'`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      rejections.push(`${where} is not an object`);
      continue;
    }

    // Unknown keys are refused rather than ignored. A typo in a security
    // boundary should stop the run, not quietly grant nothing.
    const profile: Profile = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "description") {
        if (typeof entry !== "string") rejections.push(`${where}: 'description' must be a string`);
        else profile.description = entry;
        continue;
      }
      if (key === "denyWriteOverrides") {
        const replacements = parseDenyWriteOverrides(entry, where, rejections);
        if (replacements) {
          profile.denyWriteOverrides = replacements;
        }
        continue;
      }
      if (!(PROFILE_LISTS as readonly string[]).includes(key)) {
        rejections.push(`${where}: unknown key '${key}'`);
        continue;
      }
      if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string" || !item)) {
        rejections.push(`${where}: '${key}' must be an array of non-empty strings`);
        continue;
      }
      profile[key as (typeof PROFILE_LISTS)[number]] = entry as string[];
    }

    // Paths reach srt verbatim, and srt takes absolute paths and "~" only. An
    // extraExec entry never reaches srt — it is written into the Seatbelt
    // profile here — so it may also be "./", the workspace this run was given.
    for (const key of ["extraRead", "extraWrite", "extraExec"] as const) {
      const allowRelative = key === "extraExec";
      for (const entry of profile[key] ?? []) {
        if (!isValidPathEntry(entry, allowRelative)) {
          rejections.push(
            `${where}: '${key}' entry '${entry}' is ${validPathEntryForms(allowRelative)}`,
          );
        }
        const unsupported = allowRelative ? unsupportedGlob(entry) : undefined;
        if (unsupported) {
          rejections.push(
            `${where}: '${key}' entry '${entry}' uses '${unsupported}': a glob here is '*', '**' or '?' only`,
          );
        }
      }
    }

    for (const variable of profile.requiredEnv ?? []) {
      if (!ENV_NAME.test(variable)) {
        rejections.push(`${where}: '${variable}' is not a valid environment variable name`);
      }
    }

    profiles.set(name, profile);
  }

  if (rejections.length > 0) {
    for (const rejection of rejections) {
      note(rejection);
    }
    die(`refusing to run: ${rejections.length} problem(s) in ${file}`);
  }

  return profiles;
}

/** Replace line and block comments in the source string with nothing. */
function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index++) {
    // charAt rather than indexing: it yields "" past the end instead of
    // undefined, which keeps the comparisons below honest.
    const char = source.charAt(index);
    const next = source.charAt(index + 1);

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      } else if (char === "\n") {
        result += char;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (char === "\\") {
        // Whatever follows a backslash is literal, including a quote.
        result += next;
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Validate a profile's denyWriteOverrides, or add to `rejections` and give nothing
 * back. Whether the keys name denies that exist is settled later, against the
 * list they are applied to.
 */
function parseDenyWriteOverrides(
  entry: unknown,
  where: string,
  rejections: string[],
): Record<string, string[]> | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    rejections.push(`${where}: 'denyWriteOverrides' must be an object`);
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const [pattern, replacements] of Object.entries(entry)) {
    if (
      !Array.isArray(replacements) ||
      replacements.some((item) => typeof item !== "string" || !item)
    ) {
      rejections.push(
        `${where}: 'denyWriteOverrides' entry '${pattern}' must be an array of non-empty strings`,
      );
      continue;
    }
    result[pattern] = replacements as string[];
  }
  return result;
}

/**
 * Put each replacment in place of the entry it names, keeping the rest of the list
 * as it stands. An empty replacement drops the entry and denies nothing in its
 * stead. A key that matches nothing stops the run.
 */
function replaceDenyWrite(replacements: Record<string, string[]>, denyWrite: string[]): string[] {
  const unmatched = Object.keys(replacements).filter((pattern) => !denyWrite.includes(pattern));
  if (unmatched.length > 0) {
    for (const pattern of unmatched) {
      note(`denyWriteOverrides names '${pattern}', which is not a denyWrite entry`);
    }
    die(`refusing to run: ${unmatched.length} denyWriteOverrides entry/entries match nothing`);
  }
  return denyWrite.flatMap((pattern) => replacements[pattern] ?? [pattern]);
}

/** Expand a leading "~/" the way srt would, so the two agree on what a path is. */
function expandHome(target: string): string {
  return target.startsWith("~/") ? path.join(homeDir, target.slice(2)) : target;
}

/**
 * Build the list of allowed domains with ports.
 *
 * Grammar: ".example.com" is the host and all its subdomains, "example.com" is that host
 * exactly. A host is two or more labels of letters, digits and inner hyphens, so an
 * IPv4 address passes and "*", a port, a path, ".com" and "localhost" do not. Case is
 * folded: DNS does not care, and srt compares against what curl sends.
 *
 * Each entry is emitted once per permitted port instead: plain HTTP on 80, HTTPS on 443.
 */
function buildAllowedDomains(entries: string[]): string[] {
  const allowed: string[] = [];
  const rejections: string[] = [];

  const addDomain = (host: string): void => {
    for (const port of PERMITTED_PORTS) {
      allowed.push(`${host}:${port}`);
    }
  };

  for (const entry of entries) {
    // A "*" anywhere is refused.
    if (entry.includes("*")) {
      rejections.push(
        `'${entry}' contains '*'; use a leading '.' for subdomains, e.g. '.example.com'`,
      );
      continue;
    }

    // A leading dot means the host and all its subdomains; without it, the host
    // exactly. Either way the host has to be at least two labels, or ".com" would
    // open every host under a TLD and "localhost" would name this machine.
    const subdomains = entry.startsWith(".");
    const host = (subdomains ? entry.slice(1) : entry).toLowerCase();
    if (!isHostName(host)) {
      rejections.push(
        subdomains
          ? `invalid subdomain entry: '${entry}' (need at least two labels after the leading dot, e.g. '.example.com')`
          : `invalid entry: '${entry}' (need a host name of at least two labels, e.g. 'example.com')`,
      );
      continue;
    }

    addDomain(host);
    // Both spellings are needed: srt matches the bare host and the wildcard separately.
    if (subdomains) {
      addDomain(`*.${host}`);
    }
  }

  // Quit if we've hit any rejections.
  if (rejections.length > 0) {
    for (const rejection of rejections) {
      note(rejection);
    }
    die(`refusing to run: ${rejections.length} invalid domain entry/entries`);
  }

  return allowed;
}

/** Whether `host`, already lowercased, is two or more labels of letters, digits and inner hyphens. */
function isHostName(host: string): boolean {
  const labels = host.split(".");
  return (
    labels.length >= 2 && labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
  );
}

/** Interface used for serialising settings for srt. */
interface SrtSettings {
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    allowMachLookup: string[];
  };
  credentials: {
    envVars: Array<{ name: string; mode: "deny" }>;
  };
  allowAppleEvents: boolean;
  allowPty: boolean;
  enableWeakerNetworkIsolation: boolean;
}

/**
 * Build the settings for srt.
 *
 * Paths are serialised with JSON.stringify, so one containing a quote or a
 * backslash needs no special handling.
 */
function buildSrtSettings(opts: {
  workdir: string;
  tmpDir: string;
  allowedDomains: string[];
  extraRead: string[];
  extraWrite: string[];
  denyWriteOverrides: Record<string, string[]>;
  allowMachLookup: string[];
  unsetEnv: string[];
}): SrtSettings {
  const {
    workdir,
    tmpDir,
    allowedDomains,
    extraRead,
    extraWrite,
    denyWriteOverrides,
    allowMachLookup,
    unsetEnv,
  } = opts;
  const inHome = (...parts: string[]): string => path.join(homeDir, ...parts);

  return {
    filesystem: {
      // Read is allow-by-default in srt, so the home directory and the other user
      // data roots are denied as whole regions and then re-opened path by path.
      denyRead: [...DENY_READ],
      allowRead: [
        // The repository being worked on.
        workdir,
        // Claude's own configuration: settings, agents, commands, skills, etc.
        inHome(".claude"),
        // The account record, the MCP server definitions and the per-project
        // history, all read at startup. Claude writes to this file via a lock
        // and temporary files so these need to be allow-listed as well.
        inHome(".claude.json"),
        inHome(".claude.json.lock"),
        inHome(".claude.json.tmp.*"),
        // Git identity, aliases, includes and the credential helper, read by
        // every git invocation. Writing it is denied by srt itself.
        inHome(".gitconfig"),
        // The shell startup files, sourced whenever a command is run. Without
        // them the shell starts with neither PATH nor the rest of the
        // environment the user expects.
        inHome(".zshrc"),
        inHome(".zshenv"),
        inHome(".zprofile"),
        inHome(".bashrc"),
        inHome(".bash_profile"),
        inHome(".profile"),
        // Where the native installer puts the `claude` symlink, alongside the
        // user's other command line tools.
        inHome(".local/bin"),
        // One directory per installed Claude version. Denying it leaves Claude unable to start.
        inHome(".local/share/claude"),
        // Claude's runtime state, the lock files among it.
        inHome(".local/state/claude"),
        // Claude's own cache.
        inHome(".cache/claude"),
        // macOS preference plists, read on startup by the system libraries the
        // native binary links against.
        inHome("Library/Preferences"),
        // Whatever else CSB_EXTRA_READ and the selected profiles ask for.
        ...extraRead,
      ],
      // Write is deny-by-default,so allowWrite lists what opens and denyWrite
      // re-closes parts of it.
      allowWrite: [
        // The repository being worked on, which is the point of the exercise.
        workdir,
        // $TMPDIR, where Claude and the tools it runs put their scratch files.
        tmpDir,
        // The system temp directories, which $TMPDIR is not. /tmp resolves to
        // the first of them and plenty of tools hardcode it.
        "/private/tmp",
        "/private/var/tmp",
        // Session transcripts, todos and project state, all written as Claude
        // runs. The denyWrite entries below close the dangerous parts again.
        inHome(".claude"),
        // Rewritten as projects are opened, trusted and MCP servers are added.
        // Claude writes to this file via a lock and temporary files so these
        // need to be allow-listed as well.
        inHome(".claude.json"),
        inHome(".claude.json.lock"),
        inHome(".claude.json.tmp.*"),
        // Claude's own cache.
        inHome(".cache/claude"),
        // Whatever else CSB_EXTRA_WRITE and the selected profiles ask for.
        ...extraWrite,
      ],
      // srt's own mandatory deny list already blocks writes to .git/hooks,
      // .git/config, .gitconfig, .gitmodules, the shell rc files, .ripgreprc,
      // .mcp.json, .vscode/, .idea/, .claude/commands/ and .claude/agents/ —
      // those need no entry here. srt emits its denies after every allow, and the
      // last matching rule in a Seatbelt profile wins, so extraWrite cannot
      // reopen them either.
      denyWrite: replaceDenyWrite(denyWriteOverrides, [
        // Git metadata, anywhere below the workspace. A hook planted here runs
        // on the host the next time git is invoked, and history is not Claude's
        // to rewrite behind the user's back.
        "**/.git",
        // The host-side settings, which grant permissions and can name hooks.
        inHome(".claude/settings.json"),
        // The project-side settings, at any depth in the workspace, which do the
        // same. srt denies .mcp.json beside them for the same reason but leaves
        // these open.
        "**/.claude/settings.json",
        "**/.claude/settings.local.json",
        // The user-level memory file, loaded into every host session.
        inHome(".claude/CLAUDE.md"),
        // User-level skills, offered to every host session and able to carry
        // scripts. srt already denies .claude/commands and .claude/agents.
        inHome(".claude/skills"),
        // Hook scripts, which the host Claude runs outside the sandbox.
        inHome(".claude/hooks"),
        // Plugin code, which the host Claude loads and runs the same way.
        inHome(".claude/plugins"),
        // Installed packages, at any depth in the workspace. `node_modules/.bin`
        // is on PATH for every `pnpm run` typed on the host, and a package's
        // entry point runs on the next command that imports it, so a file
        // planted here executes outside the sandbox.
        "**/node_modules",
        // Environment files, which are gitignored for the same reason and read
        // by the host toolchain. NODE_OPTIONS="--require ./evil.js" in one of
        // them runs on the next `node` invoked outside the sandbox.
        "**/.env",
        "**/.env.local",
        "**/.env.*.local",
      ]),
    },
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding: false,
      allowMachLookup,
    },
    credentials: {
      // Unset in the sandboxed process by srt.
      envVars: unsetEnv.map((name) => ({ name, mode: "deny" })),
    },
    allowAppleEvents: false,
    // Claude is a TUI: without this, ioctl on the controlling terminal is denied
    // and setRawMode fails with EPERM, so it never receives a keystroke.
    allowPty: true,
    enableWeakerNetworkIsolation: false,
  };
}

/**
 * Constructs the Seatbelt rules that close execution and then open it again for
 * the supplied entries.
 *
 * An entry is a path to a binary, or a directory with "/**" after it for the
 * whole tree below. Both the entry and what it resolves to are emitted. Seatbelt
 * matches the path the kernel arrived at. For instance, /usr/bin/git is a shim that
 * re-execs the real binary under /Library/Developer, and Homebrew command is a
 * symlink into its Cellar.
 *
 * An entry starting with "./" is taken from the workspace. Nothing in there is
 * executable by default — a file Claude wrote is a file Claude could run — so
 * this is how a repository's own tooling is let through on purpose.
 *
 * Note that `process-exec*` is checked on every execve, in the sandboxed process
 * and in every descendant of it. So allowing a shell does not influence what the
 * shell can launch itself.
 *
 */
function buildExecRules(entries: string[]): string {
  const filters = new Set<string>();

  for (const entry of entries) {
    const expanded = entry.startsWith("./")
      ? path.join(config.workspace, entry.slice(2))
      : expandHome(entry);
    const subtree = expanded.endsWith("/**");
    const target = subtree ? expanded.slice(0, -3) : expanded;

    // A glob anywhere but a trailing "/**" is a pattern, and a pattern has no
    // real path to resolve: it is matched as written against the path the
    // kernel arrived at. So a glob over a symlinked directory has to be written
    // for where the symlink points, not for the symlink.
    if (/[*?]/.test(target)) {
      filters.add(`(regex ${sbplString(globToRegex(expanded))})`);
      continue;
    }
    for (const resolved of [target, realPath(target)]) {
      filters.add(`(${subtree ? "subpath" : "literal"} ${sbplString(resolved)})`);
    }
  }

  return ["", "(deny process-exec*)", `(allow process-exec* ${[...filters].join(" ")})`, ""].join(
    "\n",
  );
}

/**
 * A glob as the anchored regex Seatbelt matches a path against: a double star
 * spans directories, a single star and "?" stop at a slash, and everything else
 * is itself. Verified against sandbox-exec: the character class, the dot-star
 * and an optional group for "zero or more directories" all behave, which is
 * what lets a node_modules pattern reach a monorepo's nested ones.
 */
function globToRegex(glob: string): string {
  let regex = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob.charAt(index);
    if (char === "*" && glob.charAt(index + 1) === "*") {
      index++;
      // "**/" is zero or more whole directories, so that "a/**/b" matches "a/b"
      // too; a "**" not followed by a slash is simply anything.
      if (glob.charAt(index + 1) === "/") {
        index++;
        regex += "(.*/)?";
      } else {
        regex += ".*";
      }
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += /[.+()[\]{}^$|\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return `^${regex}$`;
}

/** The character in an exec entry that no glob here understands, if any. */
function unsupportedGlob(entry: string): string | undefined {
  return /[[\]{}]/.exec(entry)?.[0];
}

/** Where a path really is, or the path itself when it is not on this machine. */
function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    // An allowlist entry for something not yet installed is no error.
    return target;
  }
}

/** A path as a Seatbelt string literal, which is double-quoted and backslash-escaped. */
function sbplString(target: string): string {
  return `"${target.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Quote one argument so a POSIX shell parses it back to exactly these bytes. */
function quoteShellArg(argument: string): string {
  // Single quotes make every byte literal, so a quote is the only thing needing
  // handling: close, emit an escaped quote, reopen.
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

/** Quote a whole argument list into one command string. */
function quoteShellArgs(args: string[]): string {
  return args.map(quoteShellArg).join(" ");
}

/**
 * Append the exec rules to the Seatbelt profile inside srt's wrapped command.
 *
 * srt hands back a shell command of the form `env ... /usr/bin/sandbox-exec -p
 * <profile> <shell> -c <command>`, with the profile as one single-quoted
 * argument, and offers no way to influence the process rules it contains. So the
 * argument is read back out, extended and re-quoted.
 *
 * Anything unexpected about the shape stops the run. A profile that silently
 * failed to gain the rules would be a sandbox that permits every binary on the
 * machine while reporting that it does not.
 */
function spliceExecRules(wrapped: string, entries: string[]): string {
  const SANDBOX_EXEC = "/usr/bin/sandbox-exec -p ";
  const marker = wrapped.indexOf(SANDBOX_EXEC);
  if (marker < 0) {
    die("sandbox-runtime did not produce a sandbox-exec command; refusing to run unsandboxed");
  }

  const start = marker + SANDBOX_EXEC.length;
  const profile = readShellArg(wrapped, start);
  if (!profile) {
    die("cannot read the Seatbelt profile out of the sandbox-runtime command");
  }
  if (!profile.value.trimStart().startsWith("(version 1)")) {
    die("what sandbox-runtime passes to sandbox-exec is not a Seatbelt profile");
  }

  const rules = buildExecRules(entries);
  return (
    wrapped.slice(0, start) + quoteShellArg(profile.value + rules) + wrapped.slice(profile.end)
  );
}

/**
 * Read one shell argument starting at `start`, and say where it ends. Only the
 * two forms srt's quoting produces are understood: a single-quoted string, with
 * `'"'"'` standing for a quote, and a bare word of characters that need none.
 */
function readShellArg(source: string, start: number): { value: string; end: number } | undefined {
  if (source.charAt(start) !== "'") {
    const end = source.indexOf(" ", start);
    const word = source.slice(start, end < 0 ? undefined : end);
    return word ? { value: word, end: start + word.length } : undefined;
  }

  let value = "";
  let index = start + 1;
  while (index < source.length) {
    if (source.charAt(index) !== "'") {
      value += source.charAt(index);
      index++;
      continue;
    }
    // A closing quote, either ending the argument or opening the `'"'"'` that
    // stands in for a quote inside it.
    if (source.startsWith(`'"'"'`, index)) {
      value += "'";
      index += 5;
      continue;
    }
    return { value, end: index + 1 };
  }

  // Ran off the end without a closing quote.
  return undefined;
}

main().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
