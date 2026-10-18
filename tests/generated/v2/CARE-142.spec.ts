import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import { test, expect } from '../../support/fixtures';
import type { AuditEntry, Client, Seed, Shift } from '../../support/fixtures';

const CARA = 'cara.caregiver';
const BEN = 'ben.caregiver';
const SAM = 'sam.scheduler';

// A shift's row in the shifts table, found by the shift ID shown in its first cell.
function shiftRow(page: Page, shiftId: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: shiftId, exact: true }) });
}

// Reads the current shifts back from the app, so a test can prove what was saved.
async function readShifts(request: APIRequestContext): Promise<Shift[]> {
  const res = await request.get('/__test/seed');
  if (!res.ok()) throw new Error(`Could not read shifts back from the app: HTTP ${res.status()}`);
  return ((await res.json()) as Seed).shifts;
}

function shiftById(shifts: Shift[], id: string): Shift {
  const shift = shifts.find((s) => s.id === id);
  if (!shift) throw new Error(`Shift ${id} is missing from the app data`);
  return shift;
}

function clientOf(seed: Seed, shift: Shift): Client {
  const client = seed.clients.find((c) => c.id === shift.clientId);
  if (!client) throw new Error(`Seed has no client ${shift.clientId} for shift ${shift.id}`);
  return client;
}

function clientNotServedBy(seed: Seed, username: string): Client {
  const client = seed.clients.find((c) => !seed.shifts.some((s) => s.clientId === c.id && s.caregiver === username));
  if (!client) throw new Error(`Seed has no client without a shift for ${username}`);
  return client;
}

function assignedShiftOf(seed: Seed, username: string): Shift {
  const shift = seed.shifts.find((s) => s.caregiver === username && s.status === 'Assigned');
  if (!shift) throw new Error(`Seed has no Assigned shift for ${username}`);
  return shift;
}

// A confirm request sent straight to the server with the page's session, bypassing the UI.
function postConfirm(page: Page, shiftId: string): Promise<APIResponse> {
  return page.request.post(`/shifts/${shiftId}/confirm`, { maxRedirects: 0 });
}

// The audit entries written after a known point, so a test can assert exactly what its action added.
async function auditSince(readAudit: () => Promise<AuditEntry[]>, count: number): Promise<AuditEntry[]> {
  return (await readAudit()).slice(count);
}

function phiValues(clients: Client[]): string[] {
  return clients.flatMap((c) => [c.name, c.address, c.phone, c.careNotes]);
}

test.describe('CARE-142: Caregiver confirms an assigned shift', () => {
  // ---------- AC-1: caregivers see only their own shifts ----------

  test('[AC-1] assigned caregiver sees the shift in their list with date, time, client, and status', async ({ page, seed, loginAs }) => {
    // Arrange
    const own = seed.shifts.filter((s) => s.caregiver === CARA);
    const others = seed.shifts.filter((s) => s.caregiver !== CARA);
    if (own.length === 0) throw new Error(`Seed has no shifts for ${CARA}`);
    if (others.length === 0) throw new Error(`Seed has no shifts for caregivers other than ${CARA}`);
    await loginAs(CARA);

    // Act
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My shifts' }).click();

    // Assert
    await expect(page.getByRole('heading', { name: 'My shifts' })).toBeVisible();
    await expect(page.getByTestId(/^shift-row-/)).toHaveCount(own.length);
    for (const shift of own) {
      const row = shiftRow(page, shift.id);
      await expect(row).toContainText(shift.date);
      await expect(row).toContainText(`${shift.start}–${shift.end}`);
      await expect(row.getByRole('link', { name: clientOf(seed, shift).name })).toBeVisible();
      await expect(row.getByTestId('shift-status')).toHaveText(shift.status);
    }
    for (const shift of others) {
      await expect(shiftRow(page, shift.id)).toHaveCount(0);
    }
  });

  test('[AC-1] other caregiver does not see the shift in their list', async ({ page, seed, loginAs }) => {
    // Arrange
    const notBens = seed.shifts.filter((s) => s.caregiver !== BEN);
    const bens = seed.shifts.filter((s) => s.caregiver === BEN);
    if (notBens.length === 0) throw new Error(`Seed has no shifts for caregivers other than ${BEN}`);
    if (bens.length === 0) throw new Error(`Seed has no shifts for ${BEN}`);
    await loginAs(BEN);

    // Act
    await page.goto('/shifts');

    // Assert
    await expect(page.getByRole('heading', { name: 'My shifts' })).toBeVisible();
    await expect(page.getByTestId(/^shift-row-/)).toHaveCount(bens.length);
    for (const shift of bens) {
      await expect(shiftRow(page, shift.id)).toBeVisible();
    }
    for (const shift of notBens) {
      await expect(shiftRow(page, shift.id)).toHaveCount(0);
    }
  });

  // ---------- AC-2: confirming an assigned shift ----------

  test('[AC-2] assigned caregiver confirms an assigned shift', { tag: '@smoke' }, async ({ page, seed, loginAs, request, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(CARA);
    const row = shiftRow(page, shift.id);
    const status = row.getByTestId('shift-status');
    const confirm = row.getByRole('button', { name: 'Confirm shift' });
    await expect(status).toHaveText('Assigned');
    const auditCount = (await readAudit()).length;

    // Act
    await confirm.click();

    // Assert
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    await expect(status).toHaveText('Confirmed');
    await expect(confirm).toHaveCount(0);

    await page.goto('/shifts');
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(status).toHaveText('Confirmed');
    expect(shiftById(await readShifts(request), shift.id).status).toBe('Confirmed');
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'ALLOWED' }),
    ]);
  });

  test('[AC-2] edge: session expired when confirming returns the caregiver to sign-in and nothing changes', async ({ page, context, baseURL, seed, loginAs, request }) => {
    // Arrange
    if (!baseURL) throw new Error('baseURL is not configured');
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(CARA);
    const confirm = shiftRow(page, shift.id).getByRole('button', { name: 'Confirm shift' });
    await expect(confirm).toBeVisible();
    await context.clearCookies();
    await context.addCookies([{ name: 'sid', value: 'expired-session', url: baseURL }]);

    // Act
    await confirm.click();

    // Assert
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect(shiftById(await readShifts(request), shift.id)).toEqual(shift);
  });

  // ---------- AC-3: only the assigned caregiver can confirm ----------

  test('[AC-3] other caregiver cannot confirm the shift', async ({ page, seed, loginAs, request, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, BEN);
    await loginAs(CARA);
    await expect(shiftRow(page, shift.id)).toHaveCount(0);
    const auditCount = (await readAudit()).length;

    // Act
    const res = await postConfirm(page, shift.id);

    // Assert
    expect(res.status()).toBe(403);
    const body = await res.text();
    for (const value of phiValues(seed.clients)) {
      expect(body).not.toContain(value);
    }
    expect(shiftById(await readShifts(request), shift.id)).toEqual(shift);
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'DENIED' }),
    ]);
  });

  // ---------- AC-4: schedulers can view but not confirm ----------

  test('[AC-4] scheduler sees every shift and its status with no Confirm shift action', async ({ page, seed, loginAs }) => {
    // Arrange
    if (!seed.shifts.some((s) => s.status === 'Assigned')) throw new Error('Seed has no Assigned shift');
    await loginAs(SAM);

    // Act
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'All shifts' }).click();

    // Assert
    await expect(page.getByRole('heading', { name: 'All shifts' })).toBeVisible();
    await expect(page.getByTestId(/^shift-row-/)).toHaveCount(seed.shifts.length);
    for (const shift of seed.shifts) {
      await expect(shiftRow(page, shift.id).getByTestId('shift-status')).toHaveText(shift.status);
    }
    await expect(page.getByRole('button', { name: 'Confirm shift' })).toHaveCount(0);
  });

  test('[AC-4] scheduler cannot confirm the shift', async ({ page, seed, loginAs, request, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(SAM);
    const auditCount = (await readAudit()).length;

    // Act
    const res = await postConfirm(page, shift.id);

    // Assert
    expect(res.status()).toBe(403);
    expect(shiftById(await readShifts(request), shift.id)).toEqual(shift);
    await page.goto('/shifts');
    await expect(shiftRow(page, shift.id).getByTestId('shift-status')).toHaveText('Assigned');
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: SAM, role: 'scheduler', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'DENIED' }),
    ]);
  });

  // ---------- AC-5: only Assigned shifts can be confirmed ----------

  for (const blocked of ['Confirmed', 'Cancelled'] as const) {
    test(`[AC-5] assigned caregiver sees no Confirm shift action on a ${blocked} shift`, async ({ page, seed, loginAs }) => {
      // Arrange
      const shift = seed.shifts.find((s) => s.caregiver === CARA && s.status === blocked);
      if (!shift) throw new Error(`Seed has no ${blocked} shift for ${CARA}`);
      const assigned = assignedShiftOf(seed, CARA);

      // Act
      await loginAs(CARA);

      // Assert
      await expect(shiftRow(page, assigned.id).getByRole('button', { name: 'Confirm shift' })).toBeVisible();
      await expect(shiftRow(page, shift.id).getByTestId('shift-status')).toHaveText(blocked);
      await expect(shiftRow(page, shift.id).getByRole('button', { name: 'Confirm shift' })).toHaveCount(0);
    });

    test(`[AC-5] direct confirm of a ${blocked} shift is rejected with a clear message and recorded as denied`, async ({ page, seed, loginAs, request, readAudit }) => {
      // Arrange
      const shift = seed.shifts.find((s) => s.caregiver === CARA && s.status === blocked);
      if (!shift) throw new Error(`Seed has no ${blocked} shift for ${CARA}`);
      await loginAs(CARA);
      const auditCount = (await readAudit()).length;

      // Act
      const res = await postConfirm(page, shift.id);

      // Assert
      expect(res.status()).toBe(409);
      const body = await res.text();
      expect(body).toMatch(/can.?t be confirmed/i);
      expect(body).toContain(blocked);
      expect(shiftById(await readShifts(request), shift.id)).toEqual(shift);
      expect(await auditSince(readAudit, auditCount)).toEqual([
        expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'DENIED' }),
      ]);
    });
  }

  test('[AC-5] edge: two confirm requests at the same moment record exactly one confirmation', async ({ page, seed, loginAs, request, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(CARA);
    const auditCount = (await readAudit()).length;

    // Act
    const responses = await Promise.all([postConfirm(page, shift.id), postConfirm(page, shift.id)]);

    // Assert
    const statuses = responses.map((r) => r.status()).sort();
    expect(statuses).toEqual([303, 409]);
    expect(shiftById(await readShifts(request), shift.id).status).toBe('Confirmed');
    const added = await auditSince(readAudit, auditCount);
    expect(added).toHaveLength(2);
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'ALLOWED' }),
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'DENIED' }),
    ]));
  });

  test('[AC-5] edge: confirming the same shift in two tabs rejects the second and records one confirmation', async ({ page, context, seed, loginAs, request, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(CARA);
    const secondTab = await context.newPage();
    await secondTab.goto('/shifts');
    const firstConfirm = shiftRow(page, shift.id).getByRole('button', { name: 'Confirm shift' });
    const secondConfirm = shiftRow(secondTab, shift.id).getByRole('button', { name: 'Confirm shift' });
    await expect(firstConfirm).toBeVisible();
    await expect(secondConfirm).toBeVisible();
    await firstConfirm.click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    const auditCount = (await readAudit()).length;

    // Act
    const [res] = await Promise.all([
      secondTab.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/shifts/${shift.id}/confirm`)),
      secondConfirm.click(),
    ]);

    // Assert
    expect(res.status()).toBe(409);
    await expect(secondTab.getByRole('alert')).toContainText(/can.?t be confirmed/i);
    await secondTab.goto('/shifts');
    await expect(shiftRow(secondTab, shift.id).getByTestId('shift-status')).toHaveText('Confirmed');
    expect(shiftById(await readShifts(request), shift.id).status).toBe('Confirmed');
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'DENIED' }),
    ]);
    const allowed = (await readAudit()).filter((e) => e.action === 'SHIFT_CONFIRM' && e.target === shift.id && e.outcome === 'ALLOWED');
    expect(allowed).toHaveLength(1);
  });

  test('[AC-5] edge: shift ID does not exist shows not found and nothing changes', async ({ page, seed, loginAs, request }) => {
    // Arrange
    const missingId = `${seed.shifts.map((s) => s.id).join('-')}-missing`;
    await loginAs(CARA);

    // Act
    const res = await postConfirm(page, missingId);

    // Assert
    expect(res.status()).toBe(404);
    expect(await res.text()).toMatch(/not found/i);
    expect(await readShifts(request)).toEqual(seed.shifts);
  });

  // ---------- AC-6: access to client details follows the assignment ----------

  test('[AC-6] assigned caregiver opens the client\'s details', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    const client = clientOf(seed, shift);
    await loginAs(CARA);
    const auditCount = (await readAudit()).length;

    // Act
    await shiftRow(page, shift.id).getByRole('link', { name: client.name }).click();

    // Assert
    await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
    await expect(page.getByTestId('client-card')).toContainText(client.address);
    await expect(page.getByTestId('client-card')).toContainText(client.phone);
    await expect(page.getByTestId('client-card')).toContainText(client.careNotes);
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'CLIENT_VIEW', target: client.id, outcome: 'ALLOWED' }),
    ]);
  });

  test('[AC-6] other caregiver cannot open the client\'s details', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const client = clientNotServedBy(seed, CARA);
    await loginAs(CARA);
    const auditCount = (await readAudit()).length;

    // Act
    const res = await page.request.get(`/clients/${client.id}`, { maxRedirects: 0 });

    // Assert
    expect(res.status()).toBe(403);
    const body = await res.text();
    expect(body).toMatch(/access denied/i);
    for (const value of phiValues(seed.clients)) {
      expect(body).not.toContain(value);
    }
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'CLIENT_VIEW', target: client.id, outcome: 'DENIED' }),
    ]);
  });

  test('[AC-6] scheduler opens any client\'s details', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    if (seed.clients.length === 0) throw new Error('Seed has no clients');
    await loginAs(SAM);
    const auditCount = (await readAudit()).length;

    for (const client of seed.clients) {
      // Act
      await page.goto(`/clients/${client.id}`);

      // Assert
      await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
      await expect(page.getByTestId('client-card')).toContainText(client.address);
    }
    expect(await auditSince(readAudit, auditCount)).toEqual(seed.clients.map((client) =>
      expect.objectContaining({ actor: SAM, role: 'scheduler', action: 'CLIENT_VIEW', target: client.id, outcome: 'ALLOWED' }),
    ));
  });

  // ---------- AC-7: audit trail ----------

  test('[AC-7] a successful confirmation is recorded with actor, role, server time, action, target, and outcome', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(CARA);
    const confirm = shiftRow(page, shift.id).getByRole('button', { name: 'Confirm shift' });
    await expect(confirm).toBeVisible();
    const auditCount = (await readAudit()).length;
    const before = Date.now();

    // Act
    await confirm.click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    const after = Date.now();

    // Assert
    const added = await auditSince(readAudit, auditCount);
    expect(added).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'ALLOWED' }),
    ]);
    for (const entry of added) {
      expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(entry.at)).toBeLessThanOrEqual(after);
    }
  });

  test('[AC-7] a successful sign-in is recorded as allowed', async ({ page, seed, readAudit }) => {
    // Arrange
    await page.goto('/login');
    await page.getByLabel('Username').fill(CARA);
    await page.getByLabel('Password').fill(seed.password);
    const before = Date.now();

    // Act
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Assert
    await expect(page.getByTestId('signed-in-as')).toBeVisible();
    const entries = (await readAudit()).filter((e) => e.action === 'SIGN_IN');
    expect(entries).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SIGN_IN', target: CARA, outcome: 'ALLOWED' }),
    ]);
    for (const entry of entries) {
      expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(entry.at)).toBeLessThanOrEqual(Date.now());
    }
  });

  test('[AC-7] a failed sign-in is recorded as denied with an anonymous actor and the attempted username', async ({ page, seed, readAudit }) => {
    // Arrange
    await page.goto('/login');
    await page.getByLabel('Username').fill(BEN);
    await page.getByLabel('Password').fill(`${seed.password}-wrong`);

    // Act
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Assert
    await expect(page.getByRole('alert')).toContainText(/incorrect/i);
    await expect(page.getByTestId('signed-in-as')).toHaveCount(0);
    const entries = (await readAudit()).filter((e) => e.action === 'SIGN_IN');
    expect(entries).toEqual([
      expect.objectContaining({ actor: 'anonymous', action: 'SIGN_IN', target: BEN, outcome: 'DENIED' }),
    ]);
  });

  test('[AC-7] assigned caregiver cannot view the audit trail', async ({ page, loginAs, readAudit }) => {
    // Arrange
    await loginAs(CARA);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    const auditCount = (await readAudit()).length;

    // Act
    const res = await page.request.get('/audit', { maxRedirects: 0 });

    // Assert
    expect(res.status()).toBe(403);
    expect(await res.text()).not.toContain('aria-label="Audit log"');
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'AUDIT_VIEW', target: expect.any(String), outcome: 'DENIED' }),
    ]);
  });

  test('[AC-7] other caregiver cannot view the audit trail', async ({ page, loginAs, readAudit }) => {
    // Arrange
    await loginAs(BEN);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    const auditCount = (await readAudit()).length;

    // Act
    const res = await page.request.get('/audit', { maxRedirects: 0 });

    // Assert
    expect(res.status()).toBe(403);
    expect(await res.text()).not.toContain('aria-label="Audit log"');
    expect(await auditSince(readAudit, auditCount)).toEqual([
      expect.objectContaining({ actor: BEN, role: 'caregiver', action: 'AUDIT_VIEW', target: expect.any(String), outcome: 'DENIED' }),
    ]);
  });

  test('[AC-7] scheduler views the audit trail', async ({ page, loginAs }) => {
    // Arrange
    await loginAs(SAM);

    // Act
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();

    // Assert
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    const signIn = page.getByTestId('audit-row').filter({ hasText: SAM }).filter({ hasText: 'SIGN_IN' });
    await expect(signIn).toHaveCount(1);
    await expect(signIn.getByTestId('audit-outcome')).toHaveText('ALLOWED');
  });

  test('[AC-7] audit entries contain IDs only and no PHI', async ({ page, seed, loginAs, readAudit }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    const client = clientOf(seed, shift);
    const otherClient = clientNotServedBy(seed, CARA);
    await loginAs(CARA);

    // Act
    await shiftRow(page, shift.id).getByRole('button', { name: 'Confirm shift' }).click();
    await expect(page.getByRole('status')).toContainText(/confirmed/i);
    await page.goto(`/clients/${client.id}`);
    await expect(page.getByRole('heading', { name: client.name })).toBeVisible();
    await page.goto(`/clients/${otherClient.id}`);
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();

    // Assert
    const audit = await readAudit();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'SHIFT_CONFIRM', target: shift.id, outcome: 'ALLOWED' }),
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'CLIENT_VIEW', target: client.id, outcome: 'ALLOWED' }),
      expect.objectContaining({ actor: CARA, role: 'caregiver', action: 'CLIENT_VIEW', target: otherClient.id, outcome: 'DENIED' }),
    ]));
    const serialized = JSON.stringify(audit);
    for (const value of phiValues(seed.clients)) {
      expect(serialized).not.toContain(value);
    }
  });

  test('[AC-7] audit trail cannot be edited or deleted through the application', async ({ page, loginAs, readAudit }) => {
    // Arrange
    await loginAs(SAM);
    const before = await readAudit();
    const [firstEntry] = before;
    if (!firstEntry) throw new Error('Audit trail is empty after sign-in');

    // Act
    const responses = [
      await page.request.delete('/audit', { maxRedirects: 0 }),
      await page.request.delete(`/audit/${firstEntry.id}`, { maxRedirects: 0 }),
      await page.request.put(`/audit/${firstEntry.id}`, { form: { outcome: 'ALLOWED' }, maxRedirects: 0 }),
      await page.request.patch(`/audit/${firstEntry.id}`, { form: { outcome: 'ALLOWED' }, maxRedirects: 0 }),
      await page.request.post('/audit', { form: { outcome: 'ALLOWED' }, maxRedirects: 0 }),
    ];

    // Assert
    for (const res of responses) {
      expect(res.ok()).toBe(false);
    }
    const after = await readAudit();
    expect(after).toEqual(before);
    await page.goto('/audit');
    const auditTable = page.getByRole('table', { name: 'Audit log' });
    await expect(page.getByTestId('audit-row')).toHaveCount(after.length);
    await expect(auditTable.getByRole('button')).toHaveCount(0);
    await expect(auditTable.getByRole('textbox')).toHaveCount(0);
  });

  // ---------- AC-8: responsiveness ----------

  test('[AC-8] assigned caregiver sees the confirmation result within 2 seconds', async ({ page, seed, loginAs }) => {
    // Arrange
    const shift = assignedShiftOf(seed, CARA);
    await loginAs(CARA);
    const row = shiftRow(page, shift.id);
    await expect(row.getByTestId('shift-status')).toHaveText('Assigned');
    const started = Date.now();

    // Act
    await row.getByRole('button', { name: 'Confirm shift' }).click();

    // Assert
    await expect(page.getByRole('status')).toContainText(/confirmed/i, { timeout: 2_000 });
    await expect(row.getByTestId('shift-status')).toHaveText('Confirmed', { timeout: 2_000 });
    expect(Date.now() - started).toBeLessThanOrEqual(2_000);
  });
});
