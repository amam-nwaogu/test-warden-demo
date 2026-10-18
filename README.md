# Test Warden demo

**AI writes plausible tests fast. Plausible is not the same as correct.**

This project shows a workflow for using AI-generated Playwright tests safely:

1. A product spec, written as a fully specified ticket ([`specs/CARE-142-caregiver-shift-confirmation.md`](specs/CARE-142-caregiver-shift-confirmation.md)).
2. A test-generation skill turns the spec into a Playwright test. *(coming next: `.claude/skills/`)*
3. The **Test Warden** reviews the generated test before it is trusted:
   - **Static review:** deterministic rules flag hard-coded IDs, sleeps, brittle selectors, missing negative access cases, missing audit assertions, and PHI-shaped test data. Findings set the review route: automated check, LLM review, or human review.
   - **Runtime triage:** a red run is classified as data drift, timing, or a real regression before a person looks at it.
4. The Warden's findings become new rules for the generator, so AI testing gets safer over time, not just faster.

The target is **CareShift**, a small mock home-care scheduling app with roles, access rules, and an audit log. It is fictional, it is not affiliated with any company, and all of its data is synthetic.

## Requirements

- Node.js 20 or later (`node --version`)

## Setup

```bash
npm install
npx playwright install chromium
npx playwright test          # runs the smoke test
```

## Cross-browser

Tests run in Chromium by default, so demo runs stay fast and each failure is reported once. To run Chromium, Firefox, WebKit (Safari's engine), and an iPhone-sized Safari:

```bash
npx playwright install       # one time: downloads Firefox and WebKit too
npm run test:cross
```

## Run the app by hand

```bash
npm run app                  # http://localhost:3000
```

Demo users (password `demo-pass`):

| Username | Role | Notes |
|---|---|---|
| `sam.scheduler` | Scheduler | Sees all shifts and the audit log; cannot confirm |
| `cara.caregiver` | Caregiver | Has one *Assigned*, one *Confirmed*, and one *Cancelled* shift |
| `ben.caregiver` | Caregiver | Has one *Assigned* shift with a client Cara does not serve |

## Chaos switches

Each switch produces one class of failure for the Warden's triage to classify.

| Command | What happens | Failure class |
|---|---|---|
| `npm run test:reseed` | Every shift and client ID changes (SH-1001 becomes SH-7301) | **Data drift:** breaks tests that hard-code IDs |
| `npm run test:slow` | Confirming takes 6 seconds (`CHAOS_DELAY_MS` to change) | **Timing:** exceeds Playwright's 5-second assertion timeout |
| `npm run test:race` | Confirming takes 3 seconds, inside the timeout. Two confirms sent at the same moment both pass the status check before either saves. | **Real regression:** a race condition (check, then act). Found by the v2 suite's simultaneous double-submit test. |
| `npm run test:broken` | Confirm shows a success message and the shift as *Confirmed*, but saves nothing and writes no audit entry. A reload shows *Assigned* again. | **Real regression:** caught only by a test that reloads, or checks the audit trail |

The same switches work with the app on its own (`npm run app:broken`, and so on).

## Test hooks

Tests never hard-code data. They read it from the app:

- `POST /__test/reset` restores the seed data.
- `GET /__test/seed` returns users, clients, shifts, and the demo password.
- `GET /__test/audit` returns the audit log as JSON.

Set `TEST_HOOKS=off` to disable them.

## Project layout

```
specs/                 product specs (the input to test generation)
app/                   CareShift mock app (zero dependencies)
tests/support/         shared fixtures: reset, seed, loginAs, readAudit
tests/generated/v1/    tests written by /new-test (version 1)
tests/generated/v2/    tests written by /new-test-v2 (after Warden review)
.claude/skills/        new-test (v1) and new-test-v2 (v1 plus rules from review)
warden/RULES.md        Test Warden rule catalog: review, routing, and triage
warden/warden.ts       Test Warden: review and triage (run with node)
warden/reviews/        Warden review reports
warden/triage/         Warden triage reports
tests/legacy/          a hand-written test with a hard-coded ID (drift example)
tests/warden-selftest/ a deliberately weak suite the Warden must flag
```

## The loop

1. `/new-test specs/CARE-142-caregiver-shift-confirmation.md` writes `tests/generated/v1/CARE-142.spec.ts`.
2. The Test Warden reviews it against `warden/RULES.md` and routes it: automated check, LLM review, or human review.
3. Each finding becomes a rule in the skill's "Rules from review" section. That is `new-test-v2`.
4. `/new-test-v2 specs/CARE-142-caregiver-shift-confirmation.md` writes `tests/generated/v2/CARE-142.spec.ts`, and the Warden reviews it again.

## The Test Warden

```bash
npm run warden:review -- specs/CARE-142-caregiver-shift-confirmation.md tests/generated/v1/CARE-142.spec.ts
npm run warden:triage -- broken tests/generated/v2     # also: slow, race, reseed
```

Review writes `warden/reviews/<ticket>-<folder>.md` with a result for every rule in `warden/RULES.md` and a route: automated check, LLM review, or human review. Triage writes `warden/triage/<mode>.md` and classifies every failure as data drift, timing, expected denial, or real regression.

In Claude Code, the `test-warden` agent runs these and explains the results. It never edits tests or skills.

`tests/legacy/` holds one hand-written test that hard-codes a shift ID, to show data-drift triage under `reseed`. `tests/warden-selftest/` is a deliberately weak suite the Warden must flag; normal runs skip it.
