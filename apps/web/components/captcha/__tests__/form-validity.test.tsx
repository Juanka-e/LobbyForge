// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportFormValidity } from '../form-validity';

/**
 * e2e regression: ALTCHA's checkbox is `required`, so the browser blocked a
 * submit made before the check had finished ("Please check this box…") and
 * the gate never got to wait for the token. Forms now use `noValidate` plus
 * this helper: our own fields keep their native validation, the widget's
 * checkbox does not count.
 */
function form(html: string): HTMLFormElement {
  document.body.innerHTML = `<form novalidate>${html}</form>`;
  return document.querySelector('form')!;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('reportFormValidity', () => {
  it('ignores the captcha widget’s required checkbox', () => {
    const el = form(`
      <input name="email" type="email" required value="ada@example.com" />
      <altcha-widget><input type="checkbox" required /></altcha-widget>
      <div data-captcha-provider="turnstile"><input name="cf" required /></div>
    `);
    expect(reportFormValidity(el)).toBe(true);
  });

  it('still reports our own invalid field, with the browser’s message', () => {
    const el = form(`
      <input name="email" type="email" required value="" />
      <altcha-widget><input type="checkbox" required /></altcha-widget>
    `);
    const email = el.querySelector<HTMLInputElement>('input[name=email]')!;
    const report = vi.spyOn(email, 'reportValidity');
    expect(reportFormValidity(el)).toBe(false);
    expect(report).toHaveBeenCalled();
  });

  it('keeps a required agreement checkbox required', () => {
    const el = form(`<input type="checkbox" name="agree" required />`);
    expect(reportFormValidity(el)).toBe(false);
    el.querySelector<HTMLInputElement>('input[name=agree]')!.checked = true;
    expect(reportFormValidity(el)).toBe(true);
  });
});
