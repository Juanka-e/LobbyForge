import { describe, it, expect } from 'vitest';
import {
  APP_NAME,
  createServerEntry,
  listPublicEntries,
  findEntryById,
  normalizeRegistryInstanceUrl,
} from '../index.js';

describe('@lobbyforge/registry', () => {
  it('createServerEntry assigns id and defaults', () => {
    const e = createServerEntry('My Server', 'https://lobby.example.com');
    expect(e.id).toMatch(/[0-9a-f-]{36}/i);
    expect(e.name).toBe('My Server');
    expect(e.publicListed).toBe(false);
    expect(e.tags).toEqual([]);
  });

  it('listPublicEntries filters by publicListed', () => {
    const a = createServerEntry('A', 'https://a.example');
    const b = createServerEntry('B', 'https://b.example');
    b.publicListed = true;
    expect(listPublicEntries([a, b])).toEqual([b]);
  });

  it('findEntryById returns matching entry or undefined', () => {
    const a = createServerEntry('A', 'https://a.example');
    const list = [a];
    expect(findEntryById(list, a.id)?.name).toBe('A');
    expect(findEntryById(list, 'nope')).toBeUndefined();
  });

  it('exposes APP_NAME', () => {
    expect(APP_NAME).toBe('LobbyForge Registry');
  });

  it('accepts only public HTTPS origins for registry entries', () => {
    expect(normalizeRegistryInstanceUrl('https://community.example/')).toBe('https://community.example');
    expect(() => normalizeRegistryInstanceUrl('http://community.example')).toThrow(/HTTPS/);
    expect(() => normalizeRegistryInstanceUrl('https://127.0.0.1')).toThrow(/Private network/);
    expect(() => normalizeRegistryInstanceUrl('https://user:pass@community.example')).toThrow(/credentials/);
    expect(() => normalizeRegistryInstanceUrl('https://community.example/admin')).toThrow(/origin/);
  });

  it('allows explicit loopback HTTP only for local development', () => {
    expect(normalizeRegistryInstanceUrl('http://localhost:3000', { allowLoopbackHttp: true }))
      .toBe('http://localhost:3000');
    expect(() => normalizeRegistryInstanceUrl('http://192.168.1.2', { allowLoopbackHttp: true }))
      .toThrow(/HTTPS/);
  });
});
