/**
 * Unit tests for the SSRF-blocker introduced in the 2026-04-23
 * security pass. These cover only the SYNC `isPublicHttpsUrl` path
 * (write-time validation) — the async `assertPublicHttpsUrl` does
 * real DNS lookups and is exercised in production code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublicHttpsUrl } from '../url-safety';

test('isPublicHttpsUrl: legitimate public https URL passes', () => {
  const r = isPublicHttpsUrl('https://api.example.com/webhook');
  assert.equal(r.ok, true);
});

test('isPublicHttpsUrl: legitimate public https URL with path + query passes', () => {
  const r = isPublicHttpsUrl('https://api.example.com/webhook?tenant=abc&v=2');
  assert.equal(r.ok, true);
});

test('isPublicHttpsUrl: http:// scheme rejected', () => {
  const r = isPublicHttpsUrl('http://api.example.com/x');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /https:/);
});

test('isPublicHttpsUrl: invalid URL string rejected', () => {
  const r = isPublicHttpsUrl('not a url');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /Invalid URL/);
});

test('isPublicHttpsUrl: data: / file: / javascript: rejected', () => {
  for (const url of ['data:text/plain,hello', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const r = isPublicHttpsUrl(url);
    assert.equal(r.ok, false, `url should be blocked: ${url}`);
  }
});

test('isPublicHttpsUrl: localhost variants rejected', () => {
  for (const host of ['localhost', 'LOCALHOST', 'metadata', 'metadata.google.internal']) {
    const r = isPublicHttpsUrl(`https://${host}/x`);
    assert.equal(r.ok, false, `should be blocked: ${host}`);
  }
});

test('isPublicHttpsUrl: .local + .internal suffixes rejected', () => {
  for (const host of ['srv.local', 'admin.internal', 'kube-control-plane.svc.cluster.internal']) {
    const r = isPublicHttpsUrl(`https://${host}/x`);
    assert.equal(r.ok, false, `should be blocked: ${host}`);
  }
});

test('isPublicHttpsUrl: IPv4 loopback rejected', () => {
  for (const ip of ['127.0.0.1', '127.255.0.1']) {
    const r = isPublicHttpsUrl(`https://${ip}/x`);
    assert.equal(r.ok, false, `should be blocked: ${ip}`);
  }
});

test('isPublicHttpsUrl: IPv4 link-local + AWS IMDS rejected', () => {
  const r = isPublicHttpsUrl('https://169.254.169.254/latest/meta-data/');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /private|loopback|link-local/);
});

test('isPublicHttpsUrl: IPv4 RFC1918 ranges rejected', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255']) {
    const r = isPublicHttpsUrl(`https://${ip}/x`);
    assert.equal(r.ok, false, `should be blocked: ${ip}`);
  }
});

test('isPublicHttpsUrl: IPv4 CGNAT 100.64/10 rejected', () => {
  const r = isPublicHttpsUrl('https://100.64.0.1/');
  assert.equal(r.ok, false);
});

test('isPublicHttpsUrl: IPv4 multicast / reserved rejected', () => {
  for (const ip of ['224.0.0.1', '239.255.255.255', '240.0.0.1']) {
    const r = isPublicHttpsUrl(`https://${ip}/x`);
    assert.equal(r.ok, false, `should be blocked: ${ip}`);
  }
});

test('isPublicHttpsUrl: legitimate public IPv4 passes', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.1' /* though TEST-NET... still passes */, '52.84.220.1']) {
    const r = isPublicHttpsUrl(`https://${ip}/x`);
    assert.equal(r.ok, true, `should pass: ${ip}`);
  }
});

test('isPublicHttpsUrl: IPv6 loopback ::1 rejected', () => {
  const r = isPublicHttpsUrl('https://[::1]/x');
  assert.equal(r.ok, false);
});

test('isPublicHttpsUrl: IPv6 unspecified :: rejected', () => {
  const r = isPublicHttpsUrl('https://[::]/x');
  assert.equal(r.ok, false);
});

test('isPublicHttpsUrl: IPv6 unique-local fc00::/7 rejected', () => {
  for (const ip of ['fc00::1', 'fd12:3456::1']) {
    const r = isPublicHttpsUrl(`https://[${ip}]/x`);
    assert.equal(r.ok, false, `should be blocked: ${ip}`);
  }
});

test('isPublicHttpsUrl: IPv6 link-local fe80::/10 rejected', () => {
  const r = isPublicHttpsUrl('https://[fe80::1]/x');
  assert.equal(r.ok, false);
});

test('isPublicHttpsUrl: IPv6 IPv4-mapped loopback ::ffff:127.0.0.1 rejected', () => {
  const r = isPublicHttpsUrl('https://[::ffff:127.0.0.1]/x');
  assert.equal(r.ok, false);
});

test('isPublicHttpsUrl: IPv6 multicast ff00::/8 rejected', () => {
  const r = isPublicHttpsUrl('https://[ff02::1]/x');
  assert.equal(r.ok, false);
});

test('isPublicHttpsUrl: legitimate IPv6 public address passes', () => {
  // Google's public DNS over IPv6
  const r = isPublicHttpsUrl('https://[2001:4860:4860::8888]/x');
  assert.equal(r.ok, true);
});
