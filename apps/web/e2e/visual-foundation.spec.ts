import { expect, test } from '@playwright/test';

test('material symbols load locally without leaking ligature text', async ({ page }) => {
  await page.goto('/setup', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const probe = document.createElement('span');
    probe.className = 'material-symbols-outlined';
    probe.textContent = 'settings';
    document.body.appendChild(probe);

    await document.fonts.load('24px "Material Symbols Outlined"');
    await document.fonts.ready;

    const style = getComputedStyle(probe);
    const response = {
      fontLoaded: document.fonts.check('24px "Material Symbols Outlined"'),
      fontFamily: style.fontFamily,
      width: probe.getBoundingClientRect().width,
      overflow: style.overflow,
      externalGoogleStyles: [...document.styleSheets]
        .map((sheet) => sheet.href)
        .filter((href): href is string => Boolean(href))
        .filter((href) => href.includes('fonts.googleapis.com')),
    };
    probe.remove();
    return response;
  });

  expect(result.fontLoaded).toBe(true);
  expect(result.fontFamily).toContain('Material Symbols Outlined');
  expect(result.width).toBeLessThanOrEqual(24);
  expect(result.overflow).toBe('hidden');
  expect(result.externalGoogleStyles).toEqual([]);
});
