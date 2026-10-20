import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('defaults the port to 3300', () => {
    expect(loadConfig({}).PORT).toBe(3300);
  });
  it('refuses a nonsense port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
  });
});
