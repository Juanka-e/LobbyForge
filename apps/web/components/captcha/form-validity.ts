/**
 * Native form validation, minus the captcha widget.
 *
 * ALTCHA's checkbox is `required`, so the browser's own validation blocks a
 * submit until the proof of work has finished — the person sees "Please
 * check this box" and nothing is sent, although the form would happily wait
 * for the token (`useCaptchaGate.submit`). Forms with a challenge therefore
 * set `noValidate` and call this from their submit handler: every other
 * field is still checked, with the browser's own message, exactly as before.
 */
const CAPTCHA_SCOPE = 'altcha-widget, [data-captcha-provider]';

export function reportFormValidity(form: HTMLFormElement): boolean {
  for (const element of Array.from(form.elements)) {
    if (
      !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
    ) {
      continue;
    }
    if (element.closest(CAPTCHA_SCOPE)) continue;
    if (typeof element.checkValidity === 'function' && !element.checkValidity()) {
      element.reportValidity?.();
      return false;
    }
  }
  return true;
}
