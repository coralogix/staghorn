// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT_PATTERN, createPortScanner } from './discover-port';

describe('createPortScanner', () => {
  it('finds the port in a Vite banner', () => {
    const scanner = createPortScanner();
    expect(scanner.push('  ➜  Local:   http://localhost:5173/\n')).toBe(5173);
    expect(scanner.found).toBe(5173);
  });

  it('finds the port in a Next.js banner', () => {
    expect(createPortScanner().push('- Local:  http://localhost:3000')).toBe(3000);
  });

  it('finds the port in a Rails banner', () => {
    expect(
      createPortScanner().push('* Listening on http://127.0.0.1:3000'),
    ).toBe(3000);
  });

  it('finds the port behind an IPv6 literal', () => {
    expect(createPortScanner().push('Listening on http://[::1]:8080/')).toBe(8080);
  });

  it('reports only the first port it sees', () => {
    const scanner = createPortScanner();
    expect(scanner.push('http://localhost:5173')).toBe(5173);
    expect(scanner.push('http://localhost:9999')).toBeNull();
    expect(scanner.found).toBe(5173);
  });

  // Output arrives in arbitrary chunks; a URL split across two of them must
  // still be found.
  it('finds a port split across two chunks', () => {
    const scanner = createPortScanner();
    expect(scanner.push('  Local: http://local')).toBeNull();
    expect(scanner.push('host:4321/  ready')).toBe(4321);
  });

  // Our own banner prints the proxy's port; scraping it back would register the
  // proxy as its own upstream.
  it('ignores ports it was told to disregard', () => {
    const scanner = createPortScanner({ ignore: [4180] });
    expect(scanner.push('proxy at http://main.myapp.localhost:4180')).toBeNull();
    expect(scanner.push('Local: http://localhost:5173')).toBe(5173);
  });

  it('is not fooled by timestamps or versions', () => {
    const scanner = createPortScanner();
    expect(scanner.push('[12:34:56] starting, node 1:2 ready in 431ms')).toBeNull();
    expect(scanner.found).toBeNull();
  });

  it('rejects an out-of-range port', () => {
    expect(createPortScanner().push('http://localhost:99999')).toBeNull();
  });

  it('can be disabled', () => {
    const scanner = createPortScanner({ pattern: false });
    expect(scanner.push('http://localhost:5173')).toBeNull();
  });

  it('accepts a custom pattern', () => {
    const scanner = createPortScanner({ pattern: /bound=(\d+)/ });
    expect(scanner.push('server bound=7000')).toBe(7000);
  });

  // A global regex carries lastIndex between calls, which would make the scanner
  // skip matches depending on where chunks happened to break.
  it('is unaffected by a global flag on the pattern', () => {
    const scanner = createPortScanner({ pattern: /port (\d+)/g });
    expect(scanner.push('port 1234')).toBe(1234);
  });

  it('matches the documented default pattern', () => {
    expect(DEFAULT_PORT_PATTERN.test('http://localhost:3000')).toBe(true);
    expect(DEFAULT_PORT_PATTERN.test('12:34')).toBe(false);
  });
});
