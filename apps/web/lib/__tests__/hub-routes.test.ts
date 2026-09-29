import { describe, expect, it } from 'vitest';
import { hubHomeDestination, officialAuthDestination, rootDestination } from '../hub-routes';

describe('rootDestination (/)', () => {
  it('sends a signed-in official user to the hub home', () => {
    expect(rootDestination({ official: true, signedIn: true })).toBe('/home');
  });

  it('sends everyone else on the official hub to the landing page', () => {
    expect(rootDestination({ official: true, signedIn: false })).toBe('/landing');
  });

  it('keeps the self-hosted entry rules: lobby when signed in, else the instance sign-in', () => {
    expect(rootDestination({ official: false, signedIn: true })).toBe('/lobby');
    expect(rootDestination({ official: false, signedIn: false })).toBe('/login');
  });
});

describe('officialAuthDestination (/login, /register on the official hub)', () => {
  it('moves a signed-in visitor on to the hub home', () => {
    expect(officialAuthDestination(true)).toBe('/home');
  });

  it('lets a signed-out visitor stay and sign in', () => {
    expect(officialAuthDestination(false)).toBeNull();
  });
});

describe('hubHomeDestination (/home)', () => {
  it('renders for a signed-in official user', () => {
    expect(hubHomeDestination({ official: true, signedIn: true })).toBeNull();
  });

  it('asks a signed-out visitor to sign in first', () => {
    expect(hubHomeDestination({ official: true, signedIn: false })).toBe('/login');
  });

  it('does not exist on a self-hosted instance, signed in or not', () => {
    expect(hubHomeDestination({ official: false, signedIn: true })).toBe('/lobby');
    expect(hubHomeDestination({ official: false, signedIn: false })).toBe('/lobby');
  });
});
