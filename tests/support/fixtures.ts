import { test as base, expect } from '@playwright/test';

// Shared fixtures for every test in this project.
// - The app is reset to its seed data before each test (automatic).
// - `seed` gives tests the current data, so they never hard-code IDs.
// - `loginAs` signs in as one of the demo users.
// - `readAudit` returns the audit trail as JSON.
// - When the Test Warden runs the suite (WARDEN=1), each test's server request
//   log is attached to its result as evidence for the Warden's review.

export type Role = 'caregiver' | 'scheduler';
export type User = { username: string; name: string; role: Role };
export type Client = { id: string; name: string; address: string; phone: string; careNotes: string };
export type Shift = {
  id: string;
  clientId: string;
  caregiver: string;
  date: string;
  start: string;
  end: string;
  status: 'Assigned' | 'Confirmed' | 'Cancelled';
};
export type Seed = { password: string; users: User[]; clients: Client[]; shifts: Shift[] };
export type AuditEntry = {
  id: number;
  at: string;
  actor: string;
  role: string;
  action: string;
  target: string;
  outcome: 'ALLOWED' | 'DENIED';
  detail: string;
};

type Fixtures = {
  resetApp: void;
  wardenEvidence: void;
  seed: Seed;
  loginAs: (username: string) => Promise<void>;
  readAudit: () => Promise<AuditEntry[]>;
};

export const test = base.extend<Fixtures>({
  resetApp: [
    async ({ request }, use) => {
      const res = await request.post('/__test/reset');
      expect(res.ok()).toBeTruthy();
      await use();
    },
    { auto: true },
  ],

  wardenEvidence: [
    async ({ request, resetApp }, use, testInfo) => {
      void resetApp;
      await use();
      if (process.env.WARDEN !== '1') return;
      const res = await request.get('/__test/requests');
      await testInfo.attach('warden-requests', { body: await res.text(), contentType: 'application/json' });
    },
    { auto: true },
  ],

  seed: async ({ request, resetApp }, use) => {
    void resetApp;
    const res = await request.get('/__test/seed');
    expect(res.ok()).toBeTruthy();
    await use((await res.json()) as Seed);
  },

  loginAs: async ({ page, seed }, use) => {
    await use(async (username: string) => {
      await page.goto('/login');
      await page.getByLabel('Username').fill(username);
      await page.getByLabel('Password').fill(seed.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByTestId('signed-in-as')).toBeVisible();
    });
  },

  readAudit: async ({ request }, use) => {
    await use(async () => {
      const res = await request.get('/__test/audit');
      expect(res.ok()).toBeTruthy();
      return (await res.json()) as AuditEntry[];
    });
  },
});

export { expect };
