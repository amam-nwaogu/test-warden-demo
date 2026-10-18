import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { test, expect } from '../../support/fixtures';
import type { Client, Seed, Shift } from '../../support/fixtures';

const CARA = 'cara.caregiver';
const BEN = 'ben.caregiver';
const SAM = 'sam.scheduler';

function findShift(seed: Seed, caregiver: string, status: Shift['status']): Shift {
  const shift = seed.shifts.find((s) => s.caregiver === caregiver && s.status === status);
  if (!shift) throw new Error(`Seed has no ${status} shift for ${caregiver}`);
  return shift;
}

function findClient(seed: Seed, clientId: string): Client {
  const client = seed.clients.find((c) => c.id === clientId);
  if (!client) throw new Error(`Seed has no client ${clientId}`);
  return client;
}

function phiValues(seed: Seed): string[] {
  return seed.clients.flatMap((c) => [c.name, c.address, c.phone, c.careNotes]);
}

// Reads the app's current data, so a test can prove what was saved.
async function readData(request: APIRequestContext): Promise<Seed> {
  const res = await request.get('/__test/seed');
  if (!res.ok()) throw new Error(`Could not read app data: HTTP ${res.status()}`);
  return (await res.json()) as Seed;
}

async function readShift(request: APIRequestContext, id: string): Promise<Shift> {
  const shift = (await readData(request)).shifts.find((s) => s.id === id);
  if (!shift) throw new Error(`Shift ${id} is missing from the app data`);
  return shift;
}

// A direct confirm request with the signed-in user's session, bypassing the UI.
function sendConfirm(page: Page, shiftId: string): Promise<APIResponse> {
  return page.request.post(`/shifts/${encodeURIComponent(shiftId)}/confirm`, { maxRedirects: 0 });
}

test.describe('CARE-142: Caregiver confirms an assigned shift', () => {
  test('[AC-1] caregiver sees only their own shifts with date, time, client, and status', async ({ page, seed, loginAs }) => {
    // Arrange
    const ownShifts = seed.shifts.filter((s) => s.caregiver === CARA);
    const otherShifts = seed.shifts.filter((s) => s.caregiver !== CARA);
    if (ownShifts.length === 0) throw new Error(`Seed has no shifts for ${CARA}`);
    if (otherShifts.length === 0) throw new Error(`Seed has no shifts for anyone other than ${CARA}`);
    const ownClientIds = new Set(ownShifts.map((s) => s.clientId));
    const otherOnlyClients = seed.clients.filter((c) => !ownClientIds.has(c.id) && otherShifts.some((s) => s.clientId === c.id));
    if (otherOnlyClients.length === 0) throw new Error(`Seed has no client served only by caregivers other than ${CARA}`);

    // Act
    await loginAs(CARA);
    await page.goto('/shifts');

    // Assert
    await expect(page.getByRole('heading', { name: 'My shifts' })).toBeVisible();
    await expect(page.getByTestId(/^shift-row-/)).toHaveCount(ownShifts.length);
    for (const shift of ownShifts) {
      const row = page.getByTestId(`shift-row-${shift.id}`);
      await expect(row).toContainText(shift.date);
      await expect(row).toContainText(shift.start);
      await expect(row).toContainText(shift.end);
      await expect(row).toContainText(findClient(seed, shift.clientId).name);
      await expect(row.getByTestId('shift-status')).toHaveText(shift.status);
    }
    for (const shift of otherShifts) {
      await expect(page.getByTestId(`shift-row-${shift.id}`)).toHaveCount(0);
    }
    for (const client of otherOnlyClients) {
      await expect(page.getByRole('main')).not.toContainText(client.name);
    }
  });

  test('[AC-2] caregiver confirms an assigned shift', { tag: '@smoke' }, async ({ page, request, seed, loginAs }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(CARA);
    await page.goto('/shifts');
    const row = page.getByTestId(`shift-row-${shift.id}`);
    const status = row.getByTestId('shift-status');
    const confirmButton = row.getByRole('button', { name: 'Confirm shift' });
    await expect(status).toHaveText('Assigned');

    // Act
    await confirmButton.click();

    // Assert
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    await expect(status).toHaveText('Confirmed');
    await page.goto('/shifts');
    await expect(status).toHaveText('Confirmed');
    await expect(confirmButton).toHaveCount(0);
    expect((await readShift(request, shift.id)).status).toBe('Confirmed');
  });

  test('[AC-2] caregiver with an expired session is returned to sign-in and nothing changes', async ({ page, context, request, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(CARA);
    await page.goto('/shifts');
    const row = page.getByTestId(`shift-row-${shift.id}`);
    await expect(row.getByTestId('shift-status')).toHaveText('Assigned');
    const staleCookies = await context.cookies();
    await page.request.post('/logout');
    await context.addCookies(staleCookies);

    // Act
    await row.getByRole('button', { name: 'Confirm shift' }).click();

    // Assert
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect((await readShift(request, shift.id)).status).toBe('Assigned');
    const confirmations = (await readAudit()).filter((e) => e.action === 'SHIFT_CONFIRM' && e.outcome === 'ALLOWED');
    expect(confirmations).toHaveLength(0);
  });

  test('[AC-3] caregiver is denied when confirming another caregiver\'s shift by direct request', async ({ page, request, seed, loginAs, readAudit }) => {
    // Arrange
    const otherShift = findShift(seed, BEN, 'Assigned');
    await loginAs(CARA);
    expect((await readShift(request, otherShift.id)).status).toBe('Assigned');

    // Act
    const response = await sendConfirm(page, otherShift.id);

    // Assert
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    expect((await readShift(request, otherShift.id)).status).toBe('Assigned');
    const entries = (await readAudit()).filter((e) => e.action === 'SHIFT_CONFIRM' && e.target === otherShift.id);
    expect(entries).toEqual([expect.objectContaining({ actor: CARA, role: 'caregiver', outcome: 'DENIED' })]);
  });

  test('[AC-4] scheduler sees every shift and its status with no Confirm shift action', async ({ page, seed, loginAs }) => {
    // Arrange
    if (seed.shifts.length === 0) throw new Error('Seed has no shifts');

    // Act
    await loginAs(SAM);
    await page.goto('/shifts');

    // Assert
    await expect(page.getByRole('heading', { name: 'All shifts' })).toBeVisible();
    await expect(page.getByTestId(/^shift-row-/)).toHaveCount(seed.shifts.length);
    for (const shift of seed.shifts) {
      const row = page.getByTestId(`shift-row-${shift.id}`);
      await expect(row).toContainText(shift.caregiver);
      await expect(row.getByTestId('shift-status')).toHaveText(shift.status);
    }
    await expect(page.getByRole('button', { name: 'Confirm shift' })).toHaveCount(0);
  });

  test('[AC-4] scheduler is denied when confirming a shift by direct request', async ({ page, request, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(SAM);
    expect((await readShift(request, shift.id)).status).toBe('Assigned');

    // Act
    const response = await sendConfirm(page, shift.id);

    // Assert
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    expect((await readShift(request, shift.id)).status).toBe('Assigned');
    const entries = (await readAudit()).filter((e) => e.action === 'SHIFT_CONFIRM' && e.target === shift.id);
    expect(entries).toEqual([expect.objectContaining({ actor: SAM, role: 'scheduler', outcome: 'DENIED' })]);
  });

  for (const startStatus of ['Confirmed', 'Cancelled'] as const) {
    test(`[AC-5] caregiver cannot confirm a ${startStatus} shift`, async ({ page, request, seed, loginAs }) => {
      // Arrange
      const shift = findShift(seed, CARA, startStatus);
      await loginAs(CARA);
      await page.goto('/shifts');
      const row = page.getByTestId(`shift-row-${shift.id}`);
      await expect(row.getByTestId('shift-status')).toHaveText(startStatus);

      // Act
      const response = await sendConfirm(page, shift.id);

      // Assert
      await expect(row.getByRole('button', { name: 'Confirm shift' })).toHaveCount(0);
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect(response.status()).toBeLessThan(500);
      expect(await response.text()).toContain(startStatus);
      expect((await readShift(request, shift.id)).status).toBe(startStatus);
      await page.goto('/shifts');
      await expect(row.getByTestId('shift-status')).toHaveText(startStatus);
    });
  }

  test('[AC-5] caregiver confirming the same shift from two tabs succeeds only once', async ({ page, context, request, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(CARA);
    await page.goto('/shifts');
    const secondTab = await context.newPage();
    await secondTab.goto('/shifts');
    const firstRow = page.getByTestId(`shift-row-${shift.id}`);
    const secondRow = secondTab.getByTestId(`shift-row-${shift.id}`);
    await expect(firstRow.getByTestId('shift-status')).toHaveText('Assigned');
    await expect(secondRow.getByTestId('shift-status')).toHaveText('Assigned');

    // Act
    await firstRow.getByRole('button', { name: 'Confirm shift' }).click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    await secondRow.getByRole('button', { name: 'Confirm shift' }).click();

    // Assert
    await expect(secondTab.getByRole('alert')).toContainText('Confirmed');
    expect((await readShift(request, shift.id)).status).toBe('Confirmed');
    const confirmations = (await readAudit()).filter(
      (e) => e.action === 'SHIFT_CONFIRM' && e.target === shift.id && e.outcome === 'ALLOWED',
    );
    expect(confirmations).toHaveLength(1);
  });

  test('[AC-5] two simultaneous confirm requests for one shift succeed only once', async ({ page, request, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(CARA);
    expect((await readShift(request, shift.id)).status).toBe('Assigned');

    // Act
    const responses = await Promise.all([sendConfirm(page, shift.id), sendConfirm(page, shift.id)]);

    // Assert
    const outcomes = responses.map((r) => (r.status() < 400 ? 'accepted' : r.status() < 500 ? 'rejected' : 'error')).sort();
    expect(outcomes).toEqual(['accepted', 'rejected']);
    const rejected = responses.find((r) => r.status() >= 400);
    expect(await rejected?.text()).toContain('Confirmed');
    expect((await readShift(request, shift.id)).status).toBe('Confirmed');
    const confirmations = (await readAudit()).filter(
      (e) => e.action === 'SHIFT_CONFIRM' && e.target === shift.id && e.outcome === 'ALLOWED',
    );
    expect(confirmations).toHaveLength(1);
  });

  test('[AC-5] caregiver confirming a shift ID that does not exist sees not found and nothing changes', async ({ page, request, seed, loginAs, readAudit }) => {
    // Arrange
    const missingId = 'SH-DOES-NOT-EXIST';
    if (seed.shifts.some((s) => s.id === missingId)) throw new Error(`Seed unexpectedly has a shift ${missingId}`);
    await loginAs(CARA);

    // Act
    const response = await sendConfirm(page, missingId);

    // Assert
    expect(response.status()).toBe(404);
    expect(await response.text()).toMatch(/not found/i);
    expect((await readData(request)).shifts).toEqual(seed.shifts);
    const confirmations = (await readAudit()).filter((e) => e.action === 'SHIFT_CONFIRM' && e.outcome === 'ALLOWED');
    expect(confirmations).toHaveLength(0);
  });

  test('[AC-6] caregiver opens details for a client they serve', async ({ page, seed, loginAs }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    const client = findClient(seed, shift.clientId);
    await loginAs(CARA);
    await page.goto('/shifts');
    const row = page.getByTestId(`shift-row-${shift.id}`);
    await expect(row).toBeVisible();

    // Act
    await row.getByRole('link', { name: client.name }).click();

    // Assert
    await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
    await expect(page.getByTestId('client-card')).toContainText(client.address);
    await expect(page.getByTestId('client-card')).toContainText(client.careNotes);
  });

  test('[AC-6] caregiver is denied details for a client they do not serve', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const otherClient = seed.clients.find((c) => !seed.shifts.some((s) => s.clientId === c.id && s.caregiver === CARA));
    if (!otherClient) throw new Error(`Seed has no client that ${CARA} does not serve`);
    await loginAs(CARA);

    // Act
    const response = await page.goto(`/clients/${encodeURIComponent(otherClient.id)}`);

    // Assert
    if (!response) throw new Error('Opening the client page returned no response');
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    const main = page.getByRole('main');
    for (const value of [otherClient.name, otherClient.address, otherClient.phone, otherClient.careNotes]) {
      await expect(main).not.toContainText(value);
    }
    const entries = (await readAudit()).filter((e) => e.action === 'CLIENT_VIEW' && e.target === otherClient.id);
    expect(entries).toEqual([expect.objectContaining({ actor: CARA, role: 'caregiver', outcome: 'DENIED' })]);
  });

  test('[AC-6] scheduler opens details for any client', async ({ page, seed, loginAs }) => {
    // Arrange
    if (seed.clients.length === 0) throw new Error('Seed has no clients');
    await loginAs(SAM);

    for (const client of seed.clients) {
      // Act
      await page.goto(`/clients/${encodeURIComponent(client.id)}`);

      // Assert
      await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
      await expect(page.getByTestId('client-card')).toContainText(client.address);
    }
  });

  test('[AC-7] successful confirmation is recorded with actor, role, target, outcome, and server time', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(CARA);
    await page.goto('/shifts');
    const row = page.getByTestId(`shift-row-${shift.id}`);
    await expect(row.getByTestId('shift-status')).toHaveText('Assigned');
    const before = Date.now();

    // Act
    await row.getByRole('button', { name: 'Confirm shift' }).click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    const after = Date.now();

    // Assert
    const entries = (await readAudit()).filter((e) => e.action === 'SHIFT_CONFIRM' && e.target === shift.id);
    expect(entries).toEqual([expect.objectContaining({ actor: CARA, role: 'caregiver', outcome: 'ALLOWED' })]);
    const at = Date.parse(entries[0]?.at ?? '');
    expect(at).toBeGreaterThanOrEqual(before - 1_000);
    expect(at).toBeLessThanOrEqual(after + 1_000);
  });

  test('[AC-7] successful sign-in is recorded', async ({ loginAs, readAudit }) => {
    // Arrange
    expect((await readAudit()).filter((e) => e.action === 'SIGN_IN')).toHaveLength(0);

    // Act
    await loginAs(CARA);

    // Assert
    const entries = (await readAudit()).filter((e) => e.action === 'SIGN_IN');
    expect(entries).toEqual([expect.objectContaining({ actor: CARA, role: 'caregiver', target: CARA, outcome: 'ALLOWED' })]);
  });

  test('[AC-7] failed sign-in is recorded as anonymous with the attempted username', async ({ page, seed, readAudit }) => {
    // Arrange
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // Act
    await page.getByLabel('Username').fill(CARA);
    await page.getByLabel('Password').fill(`${seed.password}-wrong`);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Assert
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('signed-in-as')).toHaveCount(0);
    const entries = (await readAudit()).filter((e) => e.action === 'SIGN_IN');
    expect(entries).toEqual([expect.objectContaining({ actor: 'anonymous', target: CARA, outcome: 'DENIED' })]);
  });

  test('[AC-7] caregiver is denied the audit trail and the attempt is recorded', async ({ page, loginAs, readAudit }) => {
    // Arrange
    await loginAs(CARA);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' })).toHaveCount(0);

    // Act
    const response = await page.goto('/audit');

    // Assert
    if (!response) throw new Error('Opening the audit log returned no response');
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Audit log' })).toHaveCount(0);
    const entries = (await readAudit()).filter((e) => e.action === 'AUDIT_VIEW');
    expect(entries).toEqual([expect.objectContaining({ actor: CARA, role: 'caregiver', outcome: 'DENIED' })]);
  });

  test('[AC-7] scheduler views the audit trail', async ({ page, loginAs }) => {
    // Arrange
    await loginAs(SAM);
    const auditLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' });
    await expect(auditLink).toBeVisible();

    // Act
    await auditLink.click();

    // Assert
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    const signInRow = page.getByTestId('audit-row').filter({ hasText: SAM }).filter({ hasText: 'SIGN_IN' });
    await expect(signInRow).toHaveCount(1);
    await expect(signInRow.getByTestId('audit-outcome')).toHaveText('ALLOWED');
  });

  test('[AC-7] audit entries contain IDs only and no client PHI', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    const otherClient = seed.clients.find((c) => !seed.shifts.some((s) => s.clientId === c.id && s.caregiver === CARA));
    if (!otherClient) throw new Error(`Seed has no client that ${CARA} does not serve`);
    await loginAs(CARA);

    // Act
    await page.goto(`/clients/${encodeURIComponent(shift.clientId)}`);
    await expect(page.getByTestId('client-card')).toBeVisible();
    await page.goto(`/clients/${encodeURIComponent(otherClient.id)}`);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await page.goto('/shifts');
    await page.getByTestId(`shift-row-${shift.id}`).getByRole('button', { name: 'Confirm shift' }).click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i);

    // Assert
    const entries = await readAudit();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'ALLOWED' }),
        expect.objectContaining({ action: 'CLIENT_VIEW', target: otherClient.id, outcome: 'DENIED' }),
      ]),
    );
    const serialized = JSON.stringify(entries);
    for (const value of phiValues(seed)) {
      expect(serialized).not.toContain(value);
    }
  });

  test('[AC-7] audit entries cannot be edited or deleted through the application', async ({ page, loginAs, readAudit }) => {
    // Arrange
    await loginAs(SAM);
    await page.goto('/audit');
    const auditTable = page.getByRole('table', { name: 'Audit log' });
    await expect(auditTable).toBeVisible();
    const before = await readAudit();
    const firstEntry = before[0];
    if (!firstEntry) throw new Error('Audit trail has no entries to tamper with');

    // Act
    const attempts = await Promise.all([
      page.request.delete('/audit', { maxRedirects: 0 }),
      page.request.post('/audit', { maxRedirects: 0 }),
      page.request.delete(`/audit/${firstEntry.id}`, { maxRedirects: 0 }),
      page.request.put(`/audit/${firstEntry.id}`, { maxRedirects: 0 }),
    ]);

    // Assert
    await expect(auditTable.getByRole('button')).toHaveCount(0);
    await expect(auditTable.getByRole('textbox')).toHaveCount(0);
    for (const attempt of attempts) {
      expect(attempt.status()).toBeGreaterThanOrEqual(400);
    }
    const after = await readAudit();
    expect(after.slice(0, before.length)).toEqual(before);
  });

  test('[AC-8] caregiver sees the confirmation result within 2 seconds', async ({ page, seed, loginAs }) => {
    // Arrange
    const shift = findShift(seed, CARA, 'Assigned');
    await loginAs(CARA);
    await page.goto('/shifts');
    const row = page.getByTestId(`shift-row-${shift.id}`);
    await expect(row.getByTestId('shift-status')).toHaveText('Assigned');

    // Act
    const started = Date.now();
    await row.getByRole('button', { name: 'Confirm shift' }).click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i, { timeout: 2_000 });
    const elapsed = Date.now() - started;

    // Assert
    expect(elapsed).toBeLessThan(2_000);
    await expect(row.getByTestId('shift-status')).toHaveText('Confirmed');
  });
});
