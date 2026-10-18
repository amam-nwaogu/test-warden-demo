# Test Warden review: CARE-142, v2

Test file: `tests/generated/v2/CARE-142.spec.ts` (26 tests)  
Spec: CARE-142  
Rules: `warden/RULES.md`  
Generated: 2026-10-18T16:06:08.999Z by `node warden/warden.ts review`

## Route: Automated check: may merge

No findings.


## Results by rule

| Rule | Check | Severity | Result | Detail |
|---|---|---|---|---|
| Q1 | No hard waits | High | Pass | None found |
| Q2 | No hard-coded record IDs | High | Pass | None found |
| Q3 | No test.only or test.skip | High | Pass | None found |
| Q4 | No positional or layout-bound locators | Medium | Pass | None found |
| Q5 | No one-time snapshot assertions | Medium | Pass | None found |
| Q6 | Titles name their acceptance criterion | Low | Pass | All tagged |
| C1 | Every acceptance criterion has a test | High | Pass | 8 of 8 ACs |
| C2 | Every access-rules cell has a test | High | Pass | 12 of 12 cells |
| C3 | Denials proven at the server | High | Pass | Every tested denial got a 403 or 409 from the server |
| C4 | Every denied attempt is checked in the audit trail | High | Pass | All checked |
| C5 | Successful changes are checked in the audit trail | Medium | Pass | Confirmation audit entry asserted |
| C6 | Audit trail checked for PHI | High | Pass | Client name, address, phone, and care notes checked |
| C7 | Every edge case has a test | Medium | Pass | 3 of 3 edge cases |
| C8 | Every audited event the spec lists is tested | High | Pass | Sign-in allowed and denied both asserted |

## Access-rules evidence

| Cell | Allowed by spec | Tested |
|---|---|---|
| Assigned caregiver × See the shift in a list | Yes | Yes |
| Other caregiver × See the shift in a list | No | Yes |
| Scheduler × See the shift in a list | Yes | Yes |
| Assigned caregiver × Confirm the shift | Yes | Yes |
| Other caregiver × Confirm the shift | No | Yes, server rejected it |
| Scheduler × Confirm the shift | No | Yes, server rejected it |
| Assigned caregiver × Open the client's details | Yes | Yes |
| Other caregiver × Open the client's details | No | Yes, server rejected it |
| Scheduler × Open the client's details | Yes | Yes |
| Assigned caregiver × View the audit trail | No | Yes, server rejected it |
| Other caregiver × View the audit trail | No | Yes, server rejected it |
| Scheduler × View the audit trail | Yes | Yes |
