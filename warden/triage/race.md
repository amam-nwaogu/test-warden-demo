# Test Warden triage: CHAOS=race

Target: `tests/generated/v2`  
Generated: 2026-10-18T16:24:23.360Z by `node warden/warden.ts triage`

26 tests, 2 failed.

| Rule | Classification | Test | Evidence | Next step |
|---|---|---|---|---|
| T3 | Real regression | [AC-5] edge: two confirm requests at the same moment record exactly one confirmation | Error: expect(received).toEqual(expected) // deep equality / - Expected  - 1 / + Received  + 1 | File a defect with the trace; do not change the test |
| T3 | Real regression | [AC-8] assigned caregiver sees the confirmation result within 2 seconds | Error: expect(received).toBeLessThanOrEqual(expected) / Expected: <= 2000 / Received:    3075 | File a defect with the trace; do not change the test |
