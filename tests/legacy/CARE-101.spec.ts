import { test, expect } from '../support/fixtures';

// Legacy test, hand-written before this project's tests read IDs from the seed.
// It hard-codes SH-1001, so it breaks when the data is rebuilt (npm run test:reseed).
// It exists to show the Test Warden's triage classifying data drift (rule T2).

test('[CARE-101] caregiver sees shift SH-1001 in My shifts', async ({ page, loginAs }) => {
  await loginAs('cara.caregiver');

  await expect(page.getByTestId('shift-row-SH-1001')).toBeVisible();
  await expect(page.getByTestId('shift-row-SH-1001').getByTestId('shift-status')).toHaveText('Assigned');
});
