# Test Warden rule catalog

The Test Warden reviews AI-generated tests before anyone trusts them. Every rule is deterministic: the same spec, test file, and run give the same findings every time. The Warden does not ask a model for its opinion.

It has two layers:

1. Review (before trusting a test): code-quality rules and coverage rules, checked against the spec.
2. Triage (after a red run): every failure is classified before a person looks at it.


## Severity and review routing

| Findings | Route |
|---|---|
| No findings | Automated check: the test can merge |
| Medium or low findings only | LLM review against this catalog, then merge |
| Any high finding | Human review required before merge |

Compliance rules are high by default. A missed access or audit check in a product that holds PHI is a human decision, not a model's.


## Code-quality rules

| ID | Rule | Severity |
|---|---|---|
| Q1 | No hard waits: no `waitForTimeout`, sleeps, or `networkidle` | High |
| Q2 | No hard-coded record IDs (such as `SH-1001` or `CL-101`); read them from the seed | High |
| Q3 | No `test.only` or `test.skip` | High |
| Q4 | No positional or layout-bound locators: `.nth()`, `.first()`, `.last()`, CSS classes, XPath | Medium |
| Q5 | No one-time snapshot assertions, such as `expect(await locator.isVisible())` | Medium |
| Q6 | Every test title starts with the acceptance criterion it covers, such as `[AC-3]` | Low |


## Coverage and compliance rules

| ID | Rule | Why it matters | Severity |
|---|---|---|---|
| C1 | Traceability: every acceptance criterion in the spec has at least one test | An untested requirement is an untested risk | High |
| C2 | Access matrix: every cell of the spec's access-rules table has a test | Tests tend to cover the obvious cells and skip the rest | High |
| C3 | Server enforcement: every denied action is proven at the server with a direct request, not only by a hidden button | Hidden in the interface is not the same as enforced (HIPAA access control) | High |
| C4 | Denials are audited: every denied attempt (403 or 409, including repeated submissions and attempts to view the audit trail) has an assertion that a DENIED audit entry was written | A blocked attempt nobody recorded is invisible to an investigation (HIPAA audit controls) | High |
| C5 | Changes are audited: every successful change has an assertion that one ALLOWED audit entry was written | The audit trail must show who changed what | Medium |
| C6 | No PHI in the audit trail: audit entries are checked for client names, addresses, phone numbers, and care notes | The spec allows IDs only (minimum necessary) | High |
| C7 | Edge cases: each edge case listed in the spec has a test | Double submits and missing records are where real defects hide | Medium |
| C8 | Audited events: every event the spec says must be audited (such as sign-in attempts, allowed and denied) has a test that asserts its audit entry | If the spec lists it, an untested event is an untested requirement | High |


## Triage rules (after a red run)

| ID | Evidence | Classification | Next step |
|---|---|---|---|
| T1 | Error is a `TimeoutError` and the element or page appeared late or never | Timing or environment | Check environment health; never add a sleep |
| T2 | A hard-coded record ID in the test is missing from the current seed | Data drift | Update the test to read the ID from the seed |
| T3 | An assertion on state failed, the data was found, and timing was normal | Real regression | File a defect with the trace; do not change the test |
| T4 | A request was denied for a role the spec says must be denied | Expected behavior | The test is wrong if it expected access; fix the test |


## How the Warden checks each rule

`node warden/warden.ts review <spec> <test-file>` runs the test file once with evidence collection on. The app logs every request a test makes: who made it, how they relate to the record (owner, other caregiver, or scheduler), the status the server returned, and the audit entries it wrote. The Warden combines that evidence with the test code and the spec.

| Rule | Evidence |
|---|---|
| Q1 to Q5 | Patterns in each test's code |
| Q6, C1 | Test titles, as Playwright lists them (loops expanded) |
| C2 | For each cell of the spec's access table, a request from that relation to that action. Seeing a list also needs an assertion that another caregiver's shift is absent. The two caregiver cells for the audit trail need two different caregivers. |
| C3 | Every denied cell is backed by a 403 or 409 from the server. A test that only checked that the control was hidden counts as not proven. |
| C4 | Any test whose requests made the app write a DENIED audit entry must read the audit trail and assert DENIED |
| C5 | A test that confirmed a shift asserts the ALLOWED audit entry |
| C6 | A test reads the audit trail and asserts it does not contain client name, address, phone, or care notes (directly or through a helper) |
| C7 | Each edge case in the spec matches a test title |
| C8 | If AC-7 lists sign-in attempts: a successful and a failed sign-in each happen in a test that asserts the SIGN_IN entry |

`node warden/warden.ts triage <slow|race|broken|reseed> [path]` runs the tests under a chaos mode and applies T1 to T4 to each failure, in this order: data drift (a hard-coded ID missing from the current data), timing (a timeout), expected denial, then real regression.

The Warden is tested too: `tests/warden-selftest/` is a deliberately weak suite that it must route to human review.
