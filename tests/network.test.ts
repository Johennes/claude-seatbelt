import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { makeDir, sandboxProbe, type SandboxResult } from "./helpers.ts";

/**
 * curl through the proxy environment that claude-seatbelt sets for the sandboxed process.
 *
 * --fail matters: without it curl exits 0 after printing a proxy's 403 refusal,
 * because an error page is still a completed HTTP transaction. A plain http://
 * denial would then read as "reachable".
 */
const curlViaProxy = "curl -sS -f -o /dev/null --max-time 20";

/** curl told to ignore that proxy, to see whether the sandbox itself blocks egress. */
const curlDirect = 'curl -sS -f -o /dev/null --max-time 8 --noproxy "*"';

describe("an exact allowlist entry", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "example.com",
      cwd: makeDir("ws"),
      script: [
        `p allowed_host     '${curlViaProxy} https://example.com/'`,
        `p subdomain        '${curlViaProxy} https://www.example.com/'`,
        `p unrelated_host   '${curlViaProxy} https://not-allowed.example.org/'`,
        `p lookalike_suffix '${curlViaProxy} https://notexample.com/'`,
        `p nonstandard_port '${curlViaProxy} https://example.com:8443/'`,
        `p ssh_port         '${curlViaProxy} https://example.com:22/'`,
        `p direct_by_name   '${curlDirect} https://example.com/'`,
        `p direct_by_ip     '${curlDirect} https://1.1.1.1/'`,
        `p raw_tcp          'nc -z -w 5 1.1.1.1 443'`,
        `p dns_lookup       'nslookup -timeout=2 -retry=1 example.com'`,
      ].join("\n"),
    });
  });

  it("the sandbox ran and reported", () => {
    assert.equal(sandbox.status, 0);
  });

  it("an allowlisted host is reachable", () => {
    assert.equal(sandbox.probe("allowed_host"), "allowed");
  });

  it("a host that is not on the allowlist is unreachable", () => {
    assert.equal(sandbox.probe("unrelated_host"), "denied");
  });

  it("an exact entry does not let its subdomains through", () => {
    assert.equal(sandbox.probe("subdomain"), "denied");
  });

  it("a lookalike suffix does not get through", () => {
    assert.equal(sandbox.probe("lookalike_suffix"), "denied");
  });

  it("an allowlisted host is unreachable on a port other than 443", () => {
    assert.equal(sandbox.probe("nonstandard_port"), "denied");
  });

  it("an allowlisted host is unreachable on port 22", () => {
    assert.equal(sandbox.probe("ssh_port"), "denied");
  });

  // The allowlist only means anything if the proxy cannot be stepped around.
  it("bypassing the proxy by name does not reach the network", () => {
    assert.equal(sandbox.probe("direct_by_name"), "denied");
  });

  it("bypassing the proxy by IP does not reach the network", () => {
    assert.equal(sandbox.probe("direct_by_ip"), "denied");
  });

  it("a raw TCP connection off the machine is refused", () => {
    assert.equal(sandbox.probe("raw_tcp"), "denied");
  });

  it("DNS resolution inside the sandbox is refused", () => {
    assert.equal(sandbox.probe("dns_lookup"), "denied");
  });
});

// The built-in list is not configurable, so it is worth pinning that it is
// actually in force on its own — and that it does not quietly widen anything.
describe("the built-in domains, with no extras", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "",
      cwd: makeDir("ws"),
      script: [
        `p built_in       '${curlViaProxy} https://claude.com/'`,
        `p unrelated_host '${curlViaProxy} https://not-allowed.example.org/'`,
        `p example_com    '${curlViaProxy} https://example.com/'`,
      ].join("\n"),
    });
  });

  // claude.com rather than api.anthropic.com: the probe uses curl --fail, so a
  // host that answers 404 or 403 to an unauthenticated GET would read as denied.
  it("a built-in domain is reachable without CSB_EXTRA_DOMAINS", () => {
    assert.equal(sandbox.probe("built_in"), "allowed");
  });

  it("an unrelated host is still unreachable", () => {
    assert.equal(sandbox.probe("unrelated_host"), "denied");
  });

  it("a host that is only ever an extra is not reachable by default", () => {
    assert.equal(sandbox.probe("example_com"), "denied");
  });
});

describe("a subdomain-inclusive allowlist entry", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: ".example.com",
      cwd: makeDir("ws"),
      script: [
        `p bare_domain      '${curlViaProxy} https://example.com/'`,
        `p subdomain        '${curlViaProxy} https://www.example.com/'`,
        `p unrelated_host   '${curlViaProxy} https://not-allowed.example.org/'`,
        `p lookalike_suffix '${curlViaProxy} https://notexample.com/'`,
      ].join("\n"),
    });
  });

  it("the bare domain is reachable", () => {
    assert.equal(sandbox.probe("bare_domain"), "allowed");
  });

  it("a subdomain is reachable", () => {
    assert.equal(sandbox.probe("subdomain"), "allowed");
  });

  it("an unrelated host is still unreachable", () => {
    assert.equal(sandbox.probe("unrelated_host"), "denied");
  });

  it("a lookalike suffix is still unreachable", () => {
    assert.equal(sandbox.probe("lookalike_suffix"), "denied");
  });
});

// Allowlisting an address inside the LAN is the case srt's resolved-address
// check exists for. Using literal addresses keeps this offline and keeps what
// the names resolve to out of anyone else's hands.
describe("an allowlist entry pointed at this machine or its network", () => {
  let sandbox: SandboxResult;

  before(() => {
    sandbox = sandboxProbe({
      extraDomains: "127.0.0.1 192.168.7.7 169.254.7.7",
      cwd: makeDir("ws"),
      script: [
        `p loopback   '${curlViaProxy} http://127.0.0.1/'`,
        `p rfc1918    '${curlViaProxy} http://192.168.7.7/'`,
        `p link_local '${curlViaProxy} http://169.254.7.7/'`,
      ].join("\n"),
    });
  });

  it("an allowlisted loopback address is unreachable", () => {
    assert.equal(sandbox.probe("loopback"), "denied");
  });

  it("an allowlisted private address is unreachable", () => {
    assert.equal(sandbox.probe("rfc1918"), "denied");
  });

  it("an allowlisted link-local address is unreachable", () => {
    assert.equal(sandbox.probe("link_local"), "denied");
  });
});
