// Warden self-test: a deliberately weak suite. The Test Warden must flag it.
// Normal test runs skip this folder; the Warden includes it (WARDEN_SELFTEST=1).

import { test, expect } from '../support/fixtures';

test.describe('CARE-142 weak suite (Warden self-test)', () => {
  test('[AC-2] caregiver confirms', async ({ page, loginAs }) => {
    await loginAs('cara.caregiver');
    await page.getByTestId('shift-row-SH-1001').getByRole('button', { name: 'Confirm shift' }).click();
    await page.waitForTimeout(500);
    expect(await page.getByRole('status').isVisible()).toBe(true);
  });

  test('scheduler cannot confirm', async ({ page, loginAs }) => {
    await loginAs('sam.scheduler');
    await expect(page.getByRole('button', { name: 'Confirm shift' }).first()).toHaveCount(0);
  });

  test('[AC-3] other caregiver is rejected', async ({ page, loginAs }) => {
    await loginAs('ben.caregiver');
    const res = await page.request.post('/shifts/SH-1001/confirm', { maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
});
