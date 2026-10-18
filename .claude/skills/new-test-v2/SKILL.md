---
name: new-test-v2
description: Version 2 of new-test. Generates a Playwright suite from a spec in specs/ with the rules learned from Test Warden review (access matrix, server enforcement, audit trail, PHI). Use when asked for the v2 or Warden-hardened tests.
argument-hint: path to the spec, e.g. specs/CARE-142-caregiver-shift-confirmation.md
---

# new-test (version 2)

You are a staff-level test automation engineer. Turn a product spec into a Playwright test suite that covers every acceptance criterion: tests that are readable, stable, and fail when the feature breaks.

Spec: $ARGUMENTS
If no spec was given, list the files in `specs/` and ask which one to use.

## Workflow

1. **Read the spec.** Note the ticket ID, the title, every acceptance criterion (AC), and any access rules, data-handling rules, and edge cases it lists. Plan at least one test per AC before writing code.
2. **Ask instead of assuming.** If the spec is unclear about the expected result, or the UI has no element for a step the spec describes, stop and ask. Never invent behavior.
3. **Learn the real UI before writing a locator.** Read the page templates in `app/server.js` for headings, labels, button names, ARIA roles, and `data-testid` values. If Playwright MCP is connected, also open the running app (`npm run app`) and inspect the page. Never guess a selector.
4. **Use the shared fixtures** in `tests/support/fixtures.ts`: `seed`, `loginAs`, and `readAudit`. The app is reset before every test automatically.
5. **Write the tests** to `tests/generated/v2/<ticket-id>.spec.ts` (for example, `tests/generated/v2/CARE-142.spec.ts`). Replace the file if it exists.
6. **Check and run it.**
   - `npx tsc --noEmit` must pass.
   - `npx playwright test tests/generated/v2/<ticket-id>.spec.ts` must pass.
   - If either fails, read the error and the trace, fix the test, and run again (up to 3 attempts). Do not edit `app/` or `specs/`.
   - **Never heal the wrong way.** Fix locators, waits, and data lookups, but never weaken an assertion, remove one, or change an expected value to match what the app does. If the app disagrees with the spec, stop and report a possible defect with the evidence.
7. **Review your own tests.**
   - Against the spec: re-read every acceptance criterion, every cell of the access-rules table, every edge case, and every audit and data-handling rule, and confirm a test covers it and checks what it promises. Add any missing test.
   - Against the checklist below.
   - Fix anything that falls short, and run the tests again.
8. **Report** what you wrote (format below).

## Standards

### Structure
- Import `test` and `expect` from `'../../support/fixtures'`, never from `@playwright/test`.
- Group tests in `test.describe('<ticket-id>: <ticket title>', ...)`.
- One behavior per test. Title format: `[AC-n] <who> <does what>`, for example `[AC-2] caregiver confirms an assigned shift`. Tag the test for the story's main flow as smoke with the details argument: `test('[AC-2] ...', { tag: '@smoke' }, async ({ ... }) => { ... })`.
- Mark the phases with `// Arrange`, `// Act`, and `// Assert` comments.
- Tests are independent. Each one runs alone, in any order, and in parallel, with no shared state between tests.
- Navigate with relative paths (`page.goto('/shifts')`). The base URL comes from the config.
- Keep assertions in the test. Extract a helper or page object only when two or more tests need the same steps, and never put assertions inside it.

### Locators
- Use user-facing locators, in this order: `getByRole` with an accessible name, `getByLabel`, `getByText` (for static text only), then `getByTestId`. CSS and XPath only as a last resort, and never tied to layout.
- Locators are strict, so each must match exactly one element. When the same element repeats (a button in every row), scope it to its container, such as the row for one shift. Never use `.first()`, `.last()`, or `.nth()` to break a tie.
- Define a locator once as a `const` and reuse it. Locators are lazy and re-resolve on each use, so a stored locator never goes stale.

### Waiting and assertions
- Rely on auto-waiting. Actions such as `click` and `fill` already wait for the element to be visible, stable, and enabled.
- Never use `page.waitForTimeout`, fixed sleeps, or `waitForLoadState('networkidle')`. Wait for the state that matters by asserting on it.
- Use web-first assertions, which retry until they pass or time out: `await expect(locator).toBeVisible()`, `toHaveText`, `toHaveCount`.
- Never assert on a one-time snapshot, such as `expect(await locator.isVisible()).toBe(true)`. It does not retry, so it is flaky.
- Assert the starting state before acting (for example, the status is Assigned), so the test proves it changed something.
- Verify the outcome, not just the message. After a change, assert the success message, then prove the change was saved: open the page fresh with `page.goto`, or read the data back, and assert the new state. A reload alone is not enough if the address or page carries the old state.
- Assert what the spec promises: states, statuses, and visibility. Match exact wording only when the spec defines it; otherwise use a regular expression on the meaningful part.
- Every test must be able to fail. If the feature broke, at least one assertion must go red.

### Test data
- Find records in `seed` by their properties (caregiver, status, client), never by a literal ID such as `SH-1001`. IDs change between environments.
- If a needed record is missing from the seed, fail in Arrange with a clear message: `if (!shift) throw new Error('Seed has no Assigned shift for cara.caregiver')`.
- Sign in with `loginAs('<username>')`. Never write passwords into tests.
- All data is synthetic. Never invent realistic personal details.

### TypeScript
- `const` by default, `let` only when a value must be reassigned, never `var`.
- `await` every Playwright call and every `expect` on a locator. A missing `await` is the most common Playwright bug.
- Use the types exported by the fixtures (`Shift`, `Client`, `AuditEntry`). No `any`, and no non-null `!`; narrow with a check instead.
- Use `===` and `!==`, never `==`.
- No conditional logic that changes what the test does based on page state. A test takes one path. (A guard in Arrange that throws when seed data is missing is fine.)

### Hygiene
- No `test.only`, `test.skip`, retries, `console.log`, or commented-out code.
- No `try`/`catch` around actions or assertions.
- No new npm dependencies.
- Two-space indent, single quotes, semicolons, trailing commas.

## Self-review checklist

Before reporting, confirm each item. Fix anything that fails.

- [ ] Every AC in the spec has at least one test, and each test checks what its AC promises.
- [ ] Every locator is user-facing or a test ID, matches exactly one element, and was found in the real UI.
- [ ] No hard waits; every assertion is web-first and awaited.
- [ ] The starting state is asserted before the action.
- [ ] The outcome is verified on a freshly opened page or by reading the data back, not only through a message.
- [ ] No assertion was weakened or removed to make the test pass.
- [ ] No hard-coded IDs or passwords; seed lookups fail with a clear message.
- [ ] `const`/`let` used correctly, no `var`, no `any`, no `!`, every promise awaited.
- [ ] `npx tsc --noEmit` and the test both pass.

## Report

- File written
- A table of ACs and the tests that cover each one
- Type check and test results, with run time
- Anything in the spec that was unclear, and any possible product defect found

## Rules from review

Rules here come from Test Warden findings on version 1. Each names the Warden rule it closes (see `warden/RULES.md`). These rules extend the standards above; where they ask for more, they win.

1. **Every acceptance criterion and every edge case gets a test** (closes C1, C7). Plan the list from the spec before writing code. If something cannot be tested through the UI or the API, say so in the report rather than skipping it silently.
2. **Test every cell of the access-rules table** (closes C2). Write one test per cell, titled with the AC and the cell, for example `[AC-3] other caregiver cannot confirm the shift`. A *Yes* cell proves the allowed outcome; a *No* cell proves the denial.
3. **Prove every denial at the server** (closes C3). A hidden button is not enough. Signed in as the denied user, send the request directly with `page.request` (it shares the browser session) and assert the status (403 for a role or ownership denial, 409 for a state conflict). Then open the page fresh, or read the data back, and assert nothing changed.
4. **Every denied attempt is audited** (closes C4). A 403 and a 409 are both denied attempts, and so are a repeated submission and an attempt to view the audit trail. After each one, use `readAudit()` to assert exactly one new entry with outcome `DENIED`, the denied user as actor, the actor's role, the action, and the target ID.
5. **Every successful change is audited** (closes C5). After a successful change, assert exactly one new entry with outcome `ALLOWED`, the right actor, role, action, and target ID.
6. **Test every audited event the spec lists** (closes C8). If the spec says an event is audited, such as a sign-in attempt, write a test for both the allowed and the denied case and assert each audit entry. Sign-in tests drive the sign-in form directly, including a failed attempt with a wrong password.
7. **Quote the spec before deciding something is not required** (closes the v1 finding where a requirement was dismissed). If you conclude the spec does not require a behavior, quote the sentence that says so in the report. If you cannot quote one, test the behavior.
8. **Check the audit trail for PHI** (closes C6). In at least one test that writes audit entries, assert that no entry contains any client's name, address, phone number, or care notes. Compare against the client records in `seed`; never type PHI-shaped values into the test.
9. **Report coverage as evidence.** Add to the report a table of the access-rules cells with the test that covers each, and the audit assertions made.
