import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Thrown for any URL an http step must not be allowed to call — always a
 * non-retryable failure (the same URL will resolve the same way every time,
 * so retrying is pointless; see the http step handler).
 */
export class UnsafeExternalUrlError extends Error {}

/** [network base, prefix length] — checked as CIDR ranges, not string prefixes. */
const IPV4_BLOCKED_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

function ipv4ToInt(ip: string): number {
  return (
    ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
  );
}

function isIpv4InRange(
  ip: string,
  base: string,
  prefixLength: number,
): boolean {
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isPrivateIpv4(ip: string): boolean {
  return IPV4_BLOCKED_RANGES.some(([base, bits]) =>
    isIpv4InRange(ip, base, bits),
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
  if (/^f[cd][0-9a-f]{0,2}:/.test(normalized)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10 link-local

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded IPv4 address too.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]);

  return false;
}

function isBlockedAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address);
}

/**
 * Resolves `url`'s hostname and rejects it (throwing UnsafeExternalUrlError)
 * if it resolves to a private/reserved/loopback address — this blocks cloud
 * metadata endpoints (169.254.169.254), RFC1918 ranges, ::1, fc00::/7, etc.
 * DNS-resolve-then-check, not a hostname regex: a hostname can resolve to a
 * private IP without looking like one.
 *
 * Residual limitation (documented, not fixed here): this checks the address
 * at call time; nothing pins the actual outbound connection to that exact
 * resolved IP, so a DNS answer that changes between this check and the real
 * HTTP request (attacker-controlled DNS rebinding) is not fully closed by
 * this function alone. Combined with disabling redirects (maxRedirects: 0
 * on the real request), this covers the two SSRF vectors the assessment
 * calls out; a fully rebinding-proof implementation would need to pin the
 * resolved IP into the actual socket connection, which is out of scope here.
 */
export async function assertSafeExternalUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeExternalUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeExternalUrlError(
      `Unsupported URL protocol: ${url.protocol}`,
    );
  }

  // strip [] from IPv6 literals in a URL's hostname, e.g. "[::1]" -> "::1"
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (hostname.toLowerCase() === 'localhost') {
    throw new UnsafeExternalUrlError(`URL host is not allowed: ${hostname}`);
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedAddress(hostname, literalFamily as 4 | 6)) {
      throw new UnsafeExternalUrlError(
        `URL host is a blocked IP address: ${hostname}`,
      );
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeExternalUrlError(`Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0) {
    throw new UnsafeExternalUrlError(`Could not resolve host: ${hostname}`);
  }

  // Check every resolved address, not just the first — we can't be certain
  // which one the underlying HTTP client will actually connect to.
  for (const { address, family } of addresses) {
    if (isBlockedAddress(address, family as 4 | 6)) {
      throw new UnsafeExternalUrlError(
        `URL host "${hostname}" resolves to a blocked IP address (${address})`,
      );
    }
  }
}
