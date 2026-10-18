# Test Warden triage: CHAOS=reseed

Target: `tests/legacy`  
Generated: 2026-10-18T16:24:56.242Z by `node warden/warden.ts triage`

1 tests, 1 failed.

| Rule | Classification | Test | Evidence | Next step |
|---|---|---|---|---|
| T2 | Data drift | [CARE-101] caregiver sees shift SH-1001 in My shifts | Error: expect(locator).toBeVisible() failed / Locator: getByTestId('shift-row-SH-1001') / Expected: visible | Hard-coded SH-1001 not in the current data; read IDs from the seed |
