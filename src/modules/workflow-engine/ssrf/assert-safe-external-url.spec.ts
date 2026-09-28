import {
  assertSafeExternalUrl,
  UnsafeExternalUrlError,
} from './assert-safe-external-url';

describe('assertSafeExternalUrl', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/'],
    ['loopback, other 127.x', 'http://127.0.0.5:8080/'],
    ['private 10.x', 'http://10.1.2.3/'],
    ['private 172.16.x', 'http://172.16.0.1/'],
    ['private 192.168.x', 'http://192.168.1.1/'],
    ['link-local / cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['literal localhost', 'http://localhost/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unique-local', 'http://[fd00::1]/'],
  ])('rejects %s (%s)', async (_label, url) => {
    await expect(assertSafeExternalUrl(url)).rejects.toBeInstanceOf(
      UnsafeExternalUrlError,
    );
  });

  it('rejects a hostname that DNS-resolves to a private/loopback IP', async () => {
    // localtest.me is a real, publicly-documented domain that resolves to
    // 127.0.0.1 — exercises the DNS-lookup path (not the literal-IP path).
    await expect(
      assertSafeExternalUrl('http://localtest.me/'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('rejects an unresolvable host', async () => {
    await expect(
      assertSafeExternalUrl('http://this-host-does-not-exist.invalid/'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('rejects a non-http(s) protocol', async () => {
    await expect(
      assertSafeExternalUrl('file:///etc/passwd'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertSafeExternalUrl('not a url')).rejects.toBeInstanceOf(
      UnsafeExternalUrlError,
    );
  });

  it.each([
    ['a public literal IPv4', 'http://1.1.1.1/'],
    ['a public literal IPv4 with a path', 'https://8.8.8.8/resolve'],
  ])('accepts %s (%s)', async (_label, url) => {
    await expect(assertSafeExternalUrl(url)).resolves.toBeUndefined();
  });
});
