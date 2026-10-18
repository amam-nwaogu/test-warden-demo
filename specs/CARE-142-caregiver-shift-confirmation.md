# CARE-142: Caregiver confirms an assigned shift

Product: CareShift (fictional home care scheduling platform, demo only)
Type: Story
Priority: High
Owner: Product, Scheduling
Status: Ready for development
Related: CARE-143, Notify scheduler when a shift is unconfirmed 24 hours before start (future)


## 1. Background

Agencies assign caregivers to client visits days in advance. Today the schedule shows the assignment, but nothing tells the scheduler whether the caregiver has seen and accepted it. Schedulers phone caregivers to check, and a shift that was never acknowledged is the most common cause of a missed visit. A missed visit means an older adult goes without care they were promised, and the agency carries the contractual and reputational cost.


## 2. Goal

Let a caregiver confirm an assigned shift in one step, so the scheduler can see at a glance which upcoming visits are confirmed.

Success measures, 30 days after release:

- 80% of shifts are confirmed at least 24 hours before their start time.
- Scheduler phone calls to check on shifts drop by half (agency survey).


## 3. Users and roles

Access is role-based (RBAC). Each user has exactly one role.

- Caregiver: provides the visit. Sees and confirms their own assigned shifts.
- Scheduler: agency office staff. Sees all shifts and their status, and reviews the audit trail.


## 4. User story

As a caregiver, I want to confirm a shift I have been assigned, so that my scheduler knows I will be there.


## 5. Scope

In scope:

- Viewing my shifts
- Confirming an assigned shift
- Viewing client details for clients I serve
- Audit trail for confirmations, sign-ins, and denied access attempts

Out of scope:

- Declining a shift
- Notifications (CARE-143)
- Electronic visit verification (EVV) clock-in and clock-out. Shift confirmation happens before the visit and is not an EVV record.
- Mobile app


## 6. Acceptance criteria

AC-1. Caregivers see only their own shifts.
Given I am signed in as a caregiver, when I open My Shifts, then I see only shifts assigned to me, each with date, start and end time, client, and status. I never see another caregiver's shifts.

AC-2. Confirming an assigned shift.
Given a shift assigned to me with status Assigned, when I select Confirm shift, then the status changes to Confirmed, I see a success message, and the status is still Confirmed after I reload the page.

AC-3. Only the assigned caregiver can confirm.
Given a shift assigned to another caregiver, when I attempt to confirm it, including by a direct request to the server, then the request is rejected, the shift is unchanged, and the attempt is recorded in the audit trail as denied.

AC-4. Schedulers can view but not confirm.
Given I am signed in as a scheduler, when I open All Shifts, then I see every shift and its status, and no Confirm shift action is available to me. A direct confirm request from a scheduler is rejected and recorded as denied.

AC-5. Only assigned shifts can be confirmed.
Given a shift with status Confirmed or Cancelled, then no Confirm shift action is shown, and a direct confirm request is rejected with a clear message. The status is unchanged.

AC-6. Access to PHI follows the assignment (minimum necessary).
Client details are PHI. A caregiver can open a client's details only if they have a shift with that client. Any other attempt is denied and recorded in the audit trail. Schedulers can open any client's details.

AC-7. Audit trail.
The system records an audit entry for every successful confirmation, every sign-in attempt, and every denied attempt to confirm a shift, open client details, or view the audit trail. Each entry is:

- Attributable: records the actor and the actor's role. For a failed sign-in, the actor is recorded as anonymous and the attempted username as the target.
- Contemporaneous: timestamped by the server at the moment of the action
- Specific: records the action, the target ID, and the outcome (allowed or denied)
- Free of PHI: records IDs only, never client names, addresses, phone numbers, or care notes
- Append-only: entries cannot be edited or deleted through the application

Only schedulers can view the audit trail.

AC-8. Responsiveness.
Under normal load, the confirmation result is shown within 2 seconds.


## 7. Access rules

| Action                     | Assigned caregiver  | Other caregiver   | Scheduler         |
|----------------------------|---------------------|-------------------|-------------------|
| See the shift in a list    | Yes                 | No                | Yes               |
| Confirm the shift          | Yes, if Assigned    | No, denied/logged | No, denied/logged |
| Open the client's details  | Yes                 | No, denied/logged | Yes               |
| View the audit trail       | No, denied/logged   | No, denied/logged | Yes               |


## 8. Data handling and compliance

Client details (name, address, phone number, care notes) are protected health information (PHI) under HIPAA. This story applies the following safeguards:

- Minimum necessary: caregivers see PHI only for clients they are assigned to serve (AC-6).
- Access control: every action is checked against the user's role and assignment on the server, not only hidden in the interface (AC-3, AC-4, AC-6).
- Audit controls: access to PHI and every denied attempt is recorded in the audit trail (AC-7).
- Integrity: shift status changes only through an authorized confirmation, and the audit trail is append-only (AC-2, AC-7).
- No PHI outside the record: PHI does not appear in audit entries, URLs, or error messages.
- Synthetic data only: development, test, and demo environments use synthetic data. No real client data appears in test fixtures, test code, screenshots, or logs.

References: HIPAA Privacy Rule, minimum necessary standard (45 CFR 164.502(b)); HIPAA Security Rule technical safeguards for access control (45 CFR 164.312(a)), audit controls (45 CFR 164.312(b)), and integrity (45 CFR 164.312(c)).


## 9. Edge cases

- Confirming the same shift twice (double click or two tabs, including two requests at the same moment): exactly one request succeeds, the other is rejected because the shift is already confirmed, and only one confirmation is recorded.
- Session expired when confirming: the user is returned to sign-in, and nothing changes.
- Shift ID does not exist: the user sees "not found", and nothing changes.


## 10. Open questions

- Should a scheduler be able to confirm on a caregiver's behalf, with a reason code? Not in this story.
- Should a caregiver be able to undo a confirmation? Not in this story.
- Should a confirm attempt with an expired session, or for a shift ID that does not exist, be recorded in the audit trail? Not decided; not required by this story.


## Glossary

- PHI: protected health information. Health or care information that can identify a person.
- HIPAA: the U.S. federal law that sets privacy and security rules for PHI.
- RBAC: role-based access control. What a user can do depends on their role.
- Minimum necessary: users get access only to the PHI they need for their job.
- Audit trail: a time-ordered, append-only record of who did what, to which record, and whether it was allowed.
- EVV: electronic visit verification. Required for Medicaid-funded home care visits under the 21st Century Cures Act; outside this story.
