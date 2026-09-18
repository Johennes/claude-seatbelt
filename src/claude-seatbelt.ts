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

/** Read environment variables and apply default values where needed. */
const config = {
  srtVersion: process.env["CSB_SRT_VERSION"] ?? "latest",
  extraDomains: words(process.env["CSB_EXTRA_DOMAINS"] ?? ""),
  extraRead: words(process.env["CSB_EXTRA_READ"] ?? ""),
  extraWrite: words(process.env["CSB_EXTRA_WRITE"] ?? ""),
  workspace: resolveDir(process.env["CSB_WORKSPACE"] || "."),
  tmpDir: resolveDir(process.env["TMPDIR"] || "/tmp"),
  claude:
    process.env["CSB_CLAUDE"] ||
    which("claude") ||
    die("'claude' not found in PATH (set CSB_CLAUDE)"),
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

  // Construct the srt settings.
  const allowedDomains = buildAllowedDomains([...BASE_DOMAINS, ...config.extraDomains]);
  const settings = buildSrtSettings({
    workdir: config.workspace,
    tmpDir: config.tmpDir,
    allowedDomains,
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
}): SrtSettings {
  const { workdir, tmpDir, allowedDomains } = opts;
  const inHome = (...parts: string[]): string => path.join(homeDir, ...parts);

  return {
    filesystem: {
      // Read is allow-by-default in srt, so the home directory and the other user
      // data roots are denied as whole regions and then re-opened path by path.
      denyRead: [homeDir, "/Users", "/Volumes"],
      allowRead: [
        workdir,
        inHome(".claude"),
        inHome(".claude.json"),
        inHome(".gitconfig"),
        inHome(".zshrc"),
        inHome(".zshenv"),
        inHome(".zprofile"),
        inHome(".bashrc"),
        inHome(".bash_profile"),
        inHome(".profile"),
        inHome(".local/bin"),
        inHome(".local/share/claude"),
        inHome(".local/state/claude"),
        inHome(".nvm"),
        inHome(".cache"),
        inHome(".npm"),
        inHome("Library/Preferences"),
        inHome("Library/Keychains"),
        ...config.extraRead,
      ],
      // Write is deny-by-default,so allowWrite lists what opens and denyWrite
      // re-closes parts of it.
      allowWrite: [
        workdir,
        tmpDir,
        "/private/tmp",
        "/private/var/tmp",
        inHome(".claude"),
        inHome(".claude.json"),
        inHome(".claude.json.backup"),
        inHome(".cache"),
        inHome(".npm"),
        inHome("Library/Keychains"),
        ...config.extraWrite,
      ],
      // srt's own mandatory deny list already blocks writes to .git/hooks,
      // .git/config, .gitconfig, the shell rc files, .mcp.json, .vscode/, .idea/,
      // .claude/commands/ and .claude/agents/ — those need no entry here.
      denyWrite: [
        // Deny writing git metadata (commits, hooks).
        "**/.git",
        "**/.git/**",
        // Deny writing the host-side Claude config.
        inHome(".claude/settings.json"),
        inHome(".claude/hooks"),
        inHome(".claude/hooks/**"),
        inHome(".claude/plugins"),
        inHome(".claude/plugins/**"),
      ],
    },
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding: false,
    },
    allowAppleEvents: false,
    // Claude is a TUI: without this, ioctl on the controlling terminal is denied
    // and setRawMode fails with EPERM, so it never receives a keystroke.
    allowPty: true,
    enableWeakerNetworkIsolation: false,
  };
}

main(); // 🚀
