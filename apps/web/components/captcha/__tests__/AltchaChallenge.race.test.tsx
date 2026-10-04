// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/client';
import { providerPropsFor } from '@/lib/i18n/catalogue';
import { CaptchaChallenge } from '../CaptchaChallenge';
import type { CaptchaHandle } from '../types';
import { captchaConfig } from './captcha-test-utils';

/**
 * Regression (e2e run): adaptive sign-in mounts the widget and asks for a
 * token at once. `execute()` started a verification while the widget's own
 * `auto="onload"` one was about to start; the two raced, one ended in
 * `error`, and the form said "Complete the security check" next to a
 * widget that then read "Verified".
 *
 * The fake widget below behaves like ALTCHA's where it matters: it starts by
 * itself a moment after connecting, reports state changes asynchronously,
 * and a second `verify()` aborts the first, which ends in `error`.
 */

const altcha = vi.hoisted(() => ({ loadAltcha: vi.fn(), registerAltchaStrings: vi.fn() }));
vi.mock('@/components/captcha/altcha-loader', () => altcha);

type Outcome = 'verified' | 'error';
const plan = { outcomes: [] as Outcome[], autoStart: true, autoDelayMs: 200, verifyCalls: 0 };

class FakeAltcha extends HTMLElement {
  private state = 'unverified';
  private run = 0;

  connectedCallback() {
    if (plan.autoStart && this.getAttribute('auto') === 'onload') setTimeout(() => void this.verify(), plan.autoDelayMs);
  }

  getState() {
    return this.state;
  }

  reset() {
    this.run += 1;
    this.emit('unverified');
  }

  async verify() {
    plan.verifyCalls += 1;
    if (this.state === 'verifying') {
      // Like the widget: the running verification is aborted and fails.
      this.emit('error');
    }
    const run = ++this.run;
    this.emit('verifying');
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (run !== this.run) return null;
    const outcome = plan.outcomes.shift() ?? 'verified';
    if (outcome === 'verified') this.emit('verified', `payload-${plan.verifyCalls}`);
    else this.emit('error');
    return null;
  }

  private emit(state: string, payload: string | null = null) {
    this.state = state;
    void Promise.resolve().then(() => this.dispatchEvent(new CustomEvent('statechange', { detail: { state, payload } })));
  }
}
if (!customElements.get('altcha-widget')) customElements.define('altcha-widget', FakeAltcha);

async function mountAndGetHandle(): Promise<CaptchaHandle> {
  let handle: CaptchaHandle | null = null;
  render(
    <I18nProvider {...providerPropsFor('en')}>
      <CaptchaChallenge surface="login" config={captchaConfig({ surface: 'login' })} onReady={(h) => (handle = h)} />
    </I18nProvider>
  );
  await waitFor(() => expect(handle).not.toBeNull());
  return handle!;
}

beforeEach(() => {
  plan.outcomes = [];
  plan.autoStart = true;
  plan.autoDelayMs = 200;
  plan.verifyCalls = 0;
  altcha.loadAltcha.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ALTCHA: one verification at a time', { timeout: 20_000 }, () => {
  it('a token asked for right after mounting joins the widget’s own start instead of racing it', async () => {
    const handle = await mountAndGetHandle();
    await expect(handle.execute()).resolves.toBe('payload-1');
    expect(plan.verifyCalls).toBe(1);
  });

  it('an error while someone waits is retried once', async () => {
    plan.outcomes = ['error', 'verified'];
    const handle = await mountAndGetHandle();
    await expect(handle.execute()).resolves.toBe('payload-2');
    expect(plan.verifyCalls).toBe(2);
  });

  it('…but only once: a second error gives the caller null', async () => {
    plan.outcomes = ['error', 'error'];
    const handle = await mountAndGetHandle();
    await expect(handle.execute()).resolves.toBeNull();
    expect(plan.verifyCalls).toBe(2);
  });

  it('after a finished verification, a new request starts exactly one more', async () => {
    plan.outcomes = ['error'];
    const handle = await mountAndGetHandle();
    // The widget's own start fails with nobody waiting.
    await waitFor(() => expect(plan.verifyCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(handle.execute()).resolves.toBe('payload-2');
    expect(plan.verifyCalls).toBe(2);
  });

  it('a widget that never starts by itself is started after a short grace period', async () => {
    plan.autoStart = false;
    const handle = await mountAndGetHandle();
    await expect(handle.execute()).resolves.toBe('payload-1');
    expect(plan.verifyCalls).toBe(1);
  });

  it('a widget that started (and failed) before anyone listened is not waited on for nothing', async () => {
    // The e2e timing: the widget's own run begins before the handle exists.
    plan.autoDelayMs = 0;
    plan.outcomes = ['error'];
    const handle = await mountAndGetHandle();
    await waitFor(() => expect(plan.verifyCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const began = performance.now();
    await expect(handle.execute()).resolves.toBe('payload-2');
    expect(plan.verifyCalls).toBe(2);
    // Started at once — not after the grace period meant for a widget that has not begun.
    expect(performance.now() - began).toBeLessThan(1_000);
  });

  it('reset aborts and starts exactly one new verification', async () => {
    const handle = await mountAndGetHandle();
    await expect(handle.execute()).resolves.toBe('payload-1');
    handle.reset();
    await expect(handle.execute()).resolves.toBe('payload-2');
    expect(plan.verifyCalls).toBe(2);
  });
});
