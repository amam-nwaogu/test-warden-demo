import { test, expect } from './support/fixtures';

// Smoke test: proves the app and the test runner can talk to each other.
// This is NOT the demo test. The demo test is generated from the CARE-142 spec.

test('a scheduler can sign in and see all shifts', async ({ page, seed, loginAs }) => {
  await loginAs('sam.scheduler');

  await expect(page.getByRole('heading', { name: 'All shifts' })).toBeVisible();
  await expect(page.getByTestId(/^shift-row-/)).toHaveCount(seed.shifts.length);
});
