import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App shell', () => {
  it('renders the Up Next heading', () => {
    expect(renderToStaticMarkup(<App />)).toContain('Up Next');
  });
});
