// Seed data for the CareShift demo app. Every value here is synthetic.
//
// With CHAOS=reseed the IDs shift (SH-1001 -> SH-7301, CL-101 -> CL-581),
// which simulates a database that was rebuilt between test runs. A test that
// hard-codes "SH-1001" breaks; a test that reads IDs from /__test/seed does not.

export const DEMO_PASSWORD = 'demo-pass';

export function buildSeed({ reseed = false } = {}) {
  const shiftBase = reseed ? 7300 : 1000;
  const clientBase = reseed ? 580 : 100;

  const users = [
    { username: 'sam.scheduler', name: 'Sam Scheduler', role: 'scheduler' },
    { username: 'cara.caregiver', name: 'Cara Caregiver', role: 'caregiver' },
    { username: 'ben.caregiver', name: 'Ben Caregiver', role: 'caregiver' },
  ];

  const clients = [
    {
      id: `CL-${clientBase + 1}`,
      name: 'Test Client Alpha',
      address: '100 Demo Lane, Testville, TX 00000',
      phone: '555-0101',
      careNotes: 'Synthetic note: meal preparation and light housekeeping.',
    },
    {
      id: `CL-${clientBase + 2}`,
      name: 'Test Client Bravo',
      address: '200 Sample Road, Testville, TX 00000',
      phone: '555-0102',
      careNotes: 'Synthetic note: companionship and errands.',
    },
    {
      id: `CL-${clientBase + 3}`,
      name: 'Test Client Charlie',
      address: '300 Example Court, Testville, TX 00000',
      phone: '555-0103',
      careNotes: 'Synthetic note: mobility assistance and medication reminders.',
    },
  ];

  const shifts = [
    { id: `SH-${shiftBase + 1}`, clientId: clients[0].id, caregiver: 'cara.caregiver', date: '2026-10-20', start: '09:00', end: '13:00', status: 'Assigned' },
    { id: `SH-${shiftBase + 2}`, clientId: clients[1].id, caregiver: 'cara.caregiver', date: '2026-10-21', start: '14:00', end: '18:00', status: 'Confirmed' },
    { id: `SH-${shiftBase + 3}`, clientId: clients[2].id, caregiver: 'ben.caregiver', date: '2026-10-20', start: '08:00', end: '12:00', status: 'Assigned' },
    { id: `SH-${shiftBase + 4}`, clientId: clients[0].id, caregiver: 'cara.caregiver', date: '2026-10-22', start: '09:00', end: '11:00', status: 'Cancelled' },
  ];

  return { users, clients, shifts, audit: [] };
}
