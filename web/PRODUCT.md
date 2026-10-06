# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **People who track time:** employees who clock in and out, tag time with a project, fix their week in a calendar, request time off, and submit a timesheet each pay period.
- **Managers:** approve their reports' timesheets and time off, and watch who is on the clock.
- **Admins:** typically the small-business owner or office/payroll manager, who also tracks their own time. They run payroll each period (Team, Reports, Exceptions) and change people and customers/projects about weekly as hires and customer work change. They also set the payroll rules, sign-in, integrations and look, which change rarely.

## Product Purpose

Time tracking for payroll: clock in and out, time by customer and project, vacation and sick time per pay cycle, timesheets, approvals, exceptions, and reports a payroll system can import (a CSV for Gusto's hours import). Success is a pay period that closes with every timesheet in, nothing left to settle, and an export payroll can trust.

## Positioning

Built around the pay period rather than around billing: overtime counted per workweek on the day it was worked, time off per period, timesheets that lock a period, and an exceptions list of what payroll must settle before paying. It runs on its own or mounted inside a host application that owns its people.

## Operating Context

- Two deployments: standalone with its own sign-in, or embedded in a host app under a path (the host says who is calling, supplies people and managers, and can hand over its theme and a link back to itself).
- One deployment can hold many workspaces (organizations), each with its own people, time, settings and look.
- Used daily on desktop and phone: the clock and week calendar for everyone, Team/Reports at period end for managers and admins.
- A command-line client and a Toggl Track sync exist alongside the web app.

## Capabilities and Constraints

- Roles: everyone tracks time; managers (anyone with reports) approve; admins run payroll and own workspace settings. Nobody approves their own time.
- Admin areas today: payroll rules (pay cycle, time zone, workweek, overtime, approvals, holidays), customers and projects, people (manager, time zone, timesheets, holiday pay, payroll id, exempt, active), integrations (Toggl), appearance (workspace theme), sign-in (standalone only), and an audit history of every change to payroll data.
- Every person may pick light, dark or system; the workspace theme is admin-set and may come from the host.
- Strings are translated (English catalog today); copy lives in i18n catalogs.

## Brand Commitments

- Name: Timeclock. Plain, sentence-case, matter-of-fact voice ("Couldn’t save the time.").
- Public repository: no other products named in UI or docs beyond first-party integrations (Gusto, Toggl Track).

## Evidence on Hand

No customer testimonials, metrics or case studies exist; none may be invented.

## Product Principles

1. Payroll-correct first: anything that changes paid time is explicit, attributable and auditable.
2. Everyday work is one click away; set-once configuration stays out of the way.
3. Each role sees only what it can act on.
4. Works the same embedded in a host or on its own.

## Accessibility & Inclusion

Keyboard and screen-reader use are covered by e2e tests (roles and accessible names); keep every control named and operable without a pointer.
