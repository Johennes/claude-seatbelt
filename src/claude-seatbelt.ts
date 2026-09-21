#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** The profiles shipped with the tool, beside dist/ in an installed package. */
const BUILT_IN_PROFILES = path.join(import.meta.dirname, "..", "profiles.jsonc");

/** Read environment variables and apply default values where needed. */
const config = {
  srtVersion: process.env["CSB_SRT_VERSION"] ?? "latest",
  extraDomains: words(process.env["CSB_EXTRA_DOMAINS"] ?? ""),
  extraRead: words(process.env["CSB_EXTRA_READ"] ?? ""),
  extraWrite: words(process.env["CSB_EXTRA_WRITE"] ?? ""),
  profiles: words(process.env["CSB_PROFILES"] ?? ""),
  workspace: resolveDir(process.env["CSB_WORKSPACE"] || "."),
  tmpDir: resolveDir(process.env["TMPDIR"] || "/tmp"),
  claude:
    process.env["CSB_CLAUDE"] ||
    which("claude") ||
    die("'claude' not found in PATH (set CSB_CLAUDE)"),
  token: process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "",
} as const;

/** Split a space-separated list the way the shell would, dropping empties. */
function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/** Locate a binary from PATH. */
function which(command: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
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
function main(): never {
  // Ensure that we're at least on Node.js 20.11 which srt itself needs.
  ensureNodeJsVersion(20, 11);

  // Ensure npx is available.
  const npx = which("npx") ?? die("'npx' not found in PATH; it fetches sandbox-runtime");

  // Ensure we have a Claude token.
  ensureToken();

  // Deny running in the user's home folder or the file system root.
  if (config.workspace === homeDir || config.workspace === "/") {
    die(`refusing to run with ${config.workspace} as the workspace`);
  }

  // Prepare a temporary directory for running srt and a clean-up handler.
  const rundir = fs.mkdtempSync(path.join(config.tmpDir, "claude-seatbelt."));
  let cleanedUp = false;
  const cleanup = (): void => {
    if (!cleanedUp) {
      cleanedUp = true;
      fs.rmSync(rundir, { recursive: true, force: true });
    }
  };
  process.on("exit", cleanup);

  // Claude owns the terminal and handles Ctrl-C itself. A terminal-generated
  // signal goes to the whole foreground process group, so the child already has
  // its own copy; these handlers only stop Node from dying first and skipping
  // the cleanup above.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});

  // Load the selected profiles.
  const profiles = applyProfiles(config.profiles);

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
    allowMachLookup: profiles.allowMachLookup,
  });

  // Write the srt settings file.
  const settingsPath = path.join(rundir, "srt-settings.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  // Announce where and how we're running.
  note(`workspace ${config.workspace}`);
  note(`settings ${settingsPath}`);

  // Spawn srt.
  const result = spawnSync(
    npx,
    [
      "--yes",
      // Use the temporary running directory as prefix so that npm doesn't infer
      // settings from the workspace for npx.
      "--prefix",
      rundir,
      `@anthropic-ai/sandbox-runtime@${config.srtVersion}`,
      "--settings",
      settingsPath,
      config.claude,
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      // Both srt and Claude have to start in the workspace. srt anchors its own mandatory
      // write denies at its process.cwd().
      cwd: config.workspace,
      env: { ...process.env, DISABLE_AUTOUPDATER: "1" },
    },
  );

  // We're done, time to clean up.
  cleanup();

  // Re-raise if spawning failed with an error.
  if (result.error) {
    die(`failed to run ${npx}: ${result.error.message}`);
  }

  // Report a signal death the way a shell would, so `$?` means the same thing
  // whichever of the two entry points started it.
  if (result.signal) {
    process.exit(128 + (os.constants.signals[result.signal] ?? 0));
  }
  process.exit(result.status ?? 1);
}

/** Ensure that we're on a specific version of Node.js or exit otherwise. */
function ensureNodeJsVersion(major: number, minor: number): void {
  const parts = process.versions.node.split(".").map(Number);
  const [haveMajor = 0, haveMinor = 0] = parts;
  if (haveMajor < major || (haveMajor === major && haveMinor < minor)) {
    die(`Node >= ${major}.${minor} required, running ${process.versions.node}`);
  }
}

/** Ensure that a token was supplied for Claude, or exit explaining how to get one. */
function ensureToken(): void {
  if (config.token) return;
  note(
    "CLAUDE_CODE_OAUTH_TOKEN is not set, and the sandbox denies the macOS keychain." +
      "Create a token outside the sandbox with `claude setup-token`, then export it" +
      "before running claude-seatbelt.",
  );
  die("refusing to run without a token");
}

/**
 * A profile: a named bundle of additions, on top of what the base policy and
 * the CSB_EXTRA_* variables already grant.
 */
interface Profile {
  /** One line, for the reader of the profiles file. */
  description?: string;
  /** Appended to CSB_EXTRA_DOMAINS, and validated the same way. */
  extraDomains?: string[];
  /** Appended to CSB_EXTRA_READ. */
  extraRead?: string[];
  /** Appended to CSB_EXTRA_WRITE. */
  extraWrite?: string[];
  /** Environment variables the profile needs, by name. */
  requiredEnv?: string[];
  /** XPC/Mach services to open, srt's `network.allowMachLookup`. */
  allowMachLookup?: string[];
}

/** The list-valued keys of a profile, all optional and all additive. */
const PROFILE_LISTS = [
  "extraDomains",
  "extraRead",
  "extraWrite",
  "requiredEnv",
  "allowMachLookup",
] as const;

/** What CSB_PROFILES adds up to, once the named profiles are applied in order. */
interface ProfileAdditions {
  extraDomains: string[];
  extraRead: string[];
  extraWrite: string[];
  allowMachLookup: string[];
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
    allowMachLookup: [],
  };

  if (profiles.length === 0) {
    return additions;
  }

  const available = readProfiles(BUILT_IN_PROFILES);
  const missingEnv: string[] = [];

  for (const name of config.profiles) {
    const profile = available.get(name);
    if (!profile) {
      const known = [...available.keys()].toSorted().join(", ") || "none";
      die(`unknown profile '${name}' (known: ${known})`);
    }

    additions.extraDomains.push(...(profile.extraDomains ?? []));
    additions.extraRead.push(...(profile.extraRead ?? []).map(expandHome));
    additions.extraWrite.push(...(profile.extraWrite ?? []).map(expandHome));
    additions.allowMachLookup.push(...(profile.allowMachLookup ?? []));

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

  note(`profiles ${config.profiles.join(" ")}`);
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

    // Paths reach srt verbatim, and srt takes absolute paths and "~" only.
    for (const key of ["extraRead", "extraWrite"] as const) {
      for (const entry of profile[key] ?? []) {
        if (!entry.startsWith("/") && !entry.startsWith("~/")) {
          rejections.push(`${where}: '${key}' entry '${entry}' is neither absolute nor under '~/'`);
        }
      }
    }

    for (const variable of profile.requiredEnv ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
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

/** Expand a leading "~/" the way srt would, so the two agree on what a path is. */
function expandHome(target: string): string {
  return target.startsWith("~/") ? path.join(homeDir, target.slice(2)) : target;
}

/**
 * Build the list of allowed domains with ports.
 *
 * Grammar: ".example.com" is the host and all its subdomains, "example.com" is that host
 * exactly. Refused: anything containing "*", TLD-wide entries like ".com" and anything
 * without a dot.
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

    // Subdomain wildcard. At least two labels have to follow the leading dot,
    // or ".com" would open every host under a TLD.
    if (entry.startsWith(".")) {
      const suffix = entry.slice(1);
      if (!suffix.includes(".") || suffix.startsWith(".") || suffix.endsWith(".")) {
        rejections.push(
          `invalid subdomain entry: '${entry}' (need at least two labels after the leading dot, e.g. '.example.com')`,
        );
      } else {
        // Both spellings are needed: srt matches the bare host and the wildcard separately.
        addDomain(suffix);
        addDomain(`*.${suffix}`);
      }
      continue;
    }

    // Exact host.
    if (entry.includes(".")) {
      if (entry.endsWith(".")) {
        rejections.push(`malformed entry: '${entry}'`);
      } else {
        addDomain(entry);
      }
      continue;
    }

    // Anything else doesn't contain a dot and is rejected.
    rejections.push(`invalid entry: '${entry}' (must contain a dot)`);
  }

  // Quit if we've hit any rejections.
  if (rejections.length > 0) {
    for (const rejection of rejections) {
      note(rejection);
    }
    die(`refusing to run: ${rejections.length} invalid entry/entries in CSB_EXTRA_DOMAINS`);
  }

  return allowed;
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
  allowMachLookup: string[];
}): SrtSettings {
  const { workdir, tmpDir, allowedDomains, extraRead, extraWrite, allowMachLookup } = opts;
  const inHome = (...parts: string[]): string => path.join(homeDir, ...parts);

  return {
    filesystem: {
      // Read is allow-by-default in srt, so the home directory and the other user
      // data roots are denied as whole regions and then re-opened path by path.
      denyRead: [
        // This user's home, resolved through symlinks so that a HOME outside
        // /Users is covered too.
        homeDir,
        // Every other account's home, and /Users/Shared with it.
        "/Users",
        // External disks, network shares and mounted images, any of which can
        // carry a second home directory.
        "/Volumes",
        // The system keychains. Unlike this user's keychains, they do not sit
        // under any of the regions above, and System.keychain is mode 0644.
        "/Library/Keychains",
      ],
      allowRead: [
        // The repository being worked on.
        workdir,
        // Claude's own configuration: settings, agents, commands, skills, etc.
        inHome(".claude"),
        // The account record, the MCP server definitions and the per-project
        // history, all read at startup.
        inHome(".claude.json"),
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
        // Updated in place as projects are opened and MCP servers are added.
        inHome(".claude.json"),
        // The copy Claude writes beside it before rewriting the config.
        inHome(".claude.json.backup"),
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
      denyWrite: [
        // Git metadata, anywhere below a writable root. A hook planted here runs
        // on the host the next time git is invoked, and history is not Claude's
        // to rewrite behind the user's back. The directory and its contents are
        // separate patterns because one does not imply the other.
        "**/.git",
        "**/.git/**",
        // The host-side settings, which grant permissions and can name hooks.
        inHome(".claude/settings.json"),
        // Hook scripts, which the host Claude runs outside the sandbox.
        inHome(".claude/hooks"),
        inHome(".claude/hooks/**"),
        // Plugin code, which the host Claude loads and runs the same way.
        inHome(".claude/plugins"),
        inHome(".claude/plugins/**"),
        // Installed packages, at any depth: a nested workspace has its own.
        // node_modules/.bin is on PATH for every `pnpm run` typed on the host,
        // and a package's entry point runs on the next command that imports it,
        // so a file planted here executes outside the sandbox.
        "**/node_modules",
        "**/node_modules/**",
        // Environment files, which are gitignored for the same reason and read
        // by the host toolchain. NODE_OPTIONS="--require ./evil.js" in one of
        // them runs on the next `node` invoked outside the sandbox.
        "**/.env",
        "**/.env.local",
        "**/.env.*.local",
      ],
    },
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding: false,
      allowMachLookup,
    },
    allowAppleEvents: false,
    // Claude is a TUI: without this, ioctl on the controlling terminal is denied
    // and setRawMode fails with EPERM, so it never receives a keystroke.
    allowPty: true,
    enableWeakerNetworkIsolation: false,
  };
}

main(); // 🚀
