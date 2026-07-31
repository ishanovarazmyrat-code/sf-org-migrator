# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org).

## [1.13.0] — 2026-07-31

- **Files attached to a custom object are migrated instead of silently
  dropped.** The list of parent types whose files get relinked was hardcoded
  to Account, Contact, Opportunity and Case. A file hanging off anything else
  — a custom object, or a Lead, which the tool already migrates — was left out
  of the manifest with a one-line "skipped", counted as no failure and absent
  from the reports: you would believe those files had moved. The list now comes
  from the `objects` array in `migration.config.json`, which is already where
  you declare what you migrate and on which external Id. The skip message also
  names the objects it did consider, and says how to add one.
  Verified end to end on a `Shipment__c` with a lookup, a picklist and a
  validation rule: records and their attached file both land, with the lookup
  re-pointed at the target's own Account.

## [1.12.1] — 2026-07-31

- The web UI's "Connect an org" panel starts collapsed once both orgs are
  connected. It holds the Consumer Key in plain text, so leaving it open put a
  credential on screen in every screenshot and screen recording. It still
  opens by default when an org is missing, and stays wherever you put it once
  you touch it.

## [1.12.0] — 2026-07-30

- **`--stream` is available in the web UI** — a checkbox on the Files card.
  It only existed on the command line, so anyone driving the tool from the UI
  was forced through the disk path.
- **`--version` and `--help`.** The first thing anyone types after installing
  from npm printed a usage error instead of a version.
- **The usage text lists every command.** `stats`, `verify`, the individual
  file phases and `failures` were all missing from it — `failures` had no way
  to be discovered at all. It also said `node cli.js` even when invoked as
  `sf-org-migrator`; it now names whichever was actually used.
- Validated running the whole thing from a cloud VM: 10GB, 16 documents, 25
  links, zero failures, driven from the web UI over an SSH tunnel. Streaming
  a 1GB file took **136s from a VM in the orgs' region against 329s from a
  laptop two countries away** — where you run it matters more than any tuning.
  The VM guides now lead with picking the right region.

## Salesforce package 0.2.0 — 2026-07-30

The `sfdx-package` half of the product versions separately from the npm CLI.
Install: `https://login.salesforce.com/packaging/installPackage.apexp?p0=04tJ6000000pGxpIAE`

- **The packaged Apex runs in user mode.** Every local SOQL carries
  `WITH USER_MODE` and every DML `AccessLevel.USER_MODE` / `as user`. Before
  this, `with sharing` was the only control — which enforces record-level
  sharing but not object or field permissions, so the batches could write
  fields the running user had no access to. This is the most common reason a
  listing fails Salesforce's Security Review. The schedulers' custom-setting
  writes stay in system mode on purpose: they hold a sync watermark, not
  customer data.
- **Rejected records are no longer discarded.** `Database.upsert(..., false)`
  returns per-record results that nothing looked at, so a record the target
  refused simply vanished. Each result is now inspected, failures are counted
  and reported in `finish()` with the status code and message.
- **A missing external-Id field fails loudly instead of migrating nothing.**
  The batches read the field token from the describe map — and a field the
  running user cannot see is absent from that map entirely, so the token came
  back null, the upsert threw, the chunk handler swallowed it, and the run
  reported success having moved nothing. It now says which field is invisible
  and to assign the Migration_Access permission set.
- **A missing Named Credential fails at the start.** It used to surface as a
  callout error inside `execute()`, where the same handler swallowed it.
- **The tests verify the permission set.** They run inside `System.runAs` as a
  user holding only Migration_Access, so adding a field to the migration and
  forgetting the permission set now fails the suite rather than a customer.
- **Lead support**: `Legacy_Lead_Id__c` external Id and its permission-set
  entry, closing the gap with the CLI, which already migrated Leads.

## [1.11.0] — 2026-07-30

- **Create-only fields are no longer copied — a re-run used to fail where the
  first run succeeded.** Records go in by upsert, so Salesforce picks insert or
  update per record. A field that describes as createable but not updateable
  (`Lead.IsConverted`, `Opportunity.ContactId`) lands fine while the records
  are new, then fails every one of them once they exist. The field plan
  required *createable or updateable*; for an upsert it has to be both. This
  broke the tool's core promise that a run can be repeated.
- **Parent lookups are checked for writability like every other field.** They
  bypassed the field plan entirely, so a read-only lookup went straight into
  the upsert — `Lead.ConvertedAccountId` and friends are set by lead
  conversion and rejected on insert, failing all six Leads in testing. Such a
  lookup is now dropped with a warning saying why.
- **`failures`: what went wrong, grouped by cause, and what to do about it.**
  The reports under `work/errors/` list every failed row, which is right for
  auditing and useless for deciding — a 400-row CSV usually has two or three
  distinct causes. The command groups them and splits them into *worth
  retrying* (transient, or a parent that only needs migrating first) and
  *needs a fix first* (validation, permissions, a Block duplicate rule), then
  prints the phases to re-run in dependency order. The web UI shows the same
  panel with a one-click retry.
- `DUPLICATES_DETECTED` is now treated as deterministic. Since 1.8.0 an
  "Allow" duplicate rule no longer blocks the tool, so one that still gets
  through is a **Block** rule — which rejects the same record every time.
  Retrying it was pure backoff.
- Failure reports are written even when a phase runs clean, so a fixed cause
  stops being reported as current. Readers take the newest report per phase as
  the state; skipping the write left yesterday's failures looking live.
- The UI no longer locks up when a retry runs a file phase. `download`,
  `upload` and `link` have no card of their own — they share the Files card —
  and looking up the missing element threw right after the buttons were
  disabled, leaving no way forward but a page reload.
- `npm test` now runs 63 unit tests.

## [1.10.0] — 2026-07-30

- **`--stream`: migrate files without the local disk round trip.** Each binary
  goes straight from the source org to the target in one hop, so a run no
  longer needs free disk equal to the data volume. The trade is resumability —
  there is no half-finished file to resume from, so an interrupted transfer
  restarts that file. The disk path stays the default. Validated org-to-org on
  a 1GB file: 5m29s, 8KB of local disk used, SHA-256 identical end to end.
- **HTTP errors now carry their status code**, so a deterministic failure (a
  404 for a version that isn't there) fails fast instead of spending three
  rounds of backoff on it. Affects the existing disk path too.
- The transfer helpers pick http or https from the URL rather than hardcoding
  https, which is what makes these paths testable against a local server.
- `npm test` now runs 44 unit tests, including the full source → target stream.

## [1.9.0] — 2026-07-30

- **File sharing is preserved.** `ContentDocumentLink.ShareType` and
  `Visibility` were never read from the source — every migrated link was
  inserted as a plain Viewer link, silently downgrading Collaborator access in
  the target org. Both fields are now captured in the manifest and replayed on
  insert. `ShareType: 'I'` (Inferred, assigned by Salesforce for a document's
  original publish location) becomes `'V'`, since an insert cannot express it.
  When a target org rejects the source's combination — `Visibility: 'AllUsers'`
  needs Digital Experiences enabled, for example — the link is retried with
  Viewer/InternalUsers rather than lost, and the downgrade is reported.
- `npm test` now runs 39 unit tests.

## [1.8.0] — 2026-07-30

- **Duplicate rules no longer block a migration.** A migration replicates
  records that already exist in the source, so a duplicate rule would reject
  them with `DUPLICATES_DETECTED` — previously the only way through was to
  deactivate the rule in the target org's Setup, which changes org config for
  everyone. The tool now sends `Sforce-Duplicate-Rule-Header: allowSave=true`
  on its own upserts instead. Rules whose action is **Block** still block, and
  the failure is reported as usual. Set `"allowDuplicates": false` in
  `migration.config.json` to enforce the target's rules.
- **`tools/fill-storage.js`** — seeds an org with large ContentVersions up to a
  target size, for testing against realistic data volumes. Salesforce's storage
  figures lag behind uploads by minutes, so the loop also counts locally rather
  than trusting the API alone.
- **Validated end-to-end at 5GB**: 11 documents, 5.0GB of files, and 20
  ContentDocumentLinks rebuilt across Accounts, Contacts, Opportunities and
  Cases — zero failures.
- `npm test` now runs 33 unit tests (up from 31).

## [1.7.0] — 2026-07-29

- **Real automated tests for the Node tool.** CI previously only ran a syntax
  check; `npm test` now runs 31 unit tests (`node --test`, no new dependency)
  covering retry/backoff classification, the manifest's atomic save/load and
  byte accounting, automatic field-mapping decisions (formula/auto-number
  exclusion, unmapped-lookup dropping, State/Country ISO-code preference,
  RecordTypeId mapping), and OAuth token storage + concurrent-refresh
  de-duplication. Runs in CI on every push and PR.
- **Validated end-to-end against real orgs**, including a real multi-MB file
  (not just the small fixture files used in day-to-day testing): records,
  download, upload, and link all completed with zero failures and byte-exact
  transfer; two genuinely invalid source records (malformed email addresses)
  were correctly caught and reported rather than silently dropped.
- Fixed a stale `ROADMAP.md` entry that still described CLI-auth as unresolved
  after OAuth device-flow login (shipped in 1.5.0) had already replaced it as
  the recommended path.

## [1.6.0] — 2026-07-22

- **The web UI is now a modern app, not a terminal.** Full redesign: gradient
  app shell with live source/target status, a guided step wizard that earns
  checkmarks and offers "Continue →" as you finish each step, phase status
  cards with progress bars and live timers, and results parsed into friendly
  summaries (per-object record counts, file/link/byte tiles) with success and
  warning banners plus toast notifications. The raw output lives in a
  collapsible "Technical log" (auto-opens on failure).
- **One-click full migration.** A "Run full migration" button chains
  Records → Files → Verify automatically.
- **Objects & Fields quality-of-life.** Field search box per object, a live
  selected-fields count, Enter-to-add objects, and friendlier empty states.

## [1.5.0] — 2026-07-22

- **Run the web UI behind a URL (hosted mode).** Set `UI_ACCESS_KEY` and the UI
  binds all interfaces behind a login gate (session cookie, constant-time key
  check); without it, the old localhost-only behaviour is unchanged. Ships a
  `Dockerfile`, `render.yaml` one-click deploy, and `HOSTING.md`. Single-tenant:
  one instance, one org pair — your tokens and data stay in your own instance.
- **Connect an org from the browser.** The Setup tab can authorize each org via
  the OAuth device flow — paste the Consumer Key, click Connect, approve the
  code at Salesforce. No shell or auth URL needed.

## [1.4.0] — 2026-07-22

- **Required fields are shown in the web UI.** The Objects & Fields tab labels
  each field that's required on the target org, and warns inline if you uncheck
  one in "Choose fields" mode — so you don't have to remember every object's
  required fields to avoid failed inserts.

## [1.3.0] — 2026-07-22

- **Add any object from the web UI.** The Objects & Fields tab now has a
  searchable picker of every migratable object in the source org. Adding one
  shows its copyable fields, its `Legacy_<Object>_Id__c` external Id (with a
  warning when that field isn't on the target yet), and auto-detects lookups
  that should remap to already-selected parents. The saved config is
  topologically ordered so parents come before children.
- **Fix: concurrent OAuth refreshes no longer revoke the token.** External
  Client Apps rotate the refresh token on use; two refreshes racing on the
  same stored token tripped Salesforce's reuse detection and revoked the whole
  token family. Concurrent callers now share one in-flight refresh per org.

## [1.2.0] — 2026-07-22

- **Partial-failure reports.** Every phase (records, download, upload, link)
  now writes failed/skipped items to `work/errors/<phase>-<timestamp>.csv`
  (source Id, target Id, reason) instead of only counting them — so at scale
  you can see exactly what failed and why, fix it, and re-run.
- **Smarter retries.** Transient errors (network, rate limit, server 5xx,
  session expiry, row lock) are retried with backoff; deterministic errors
  (bad field, validation rule, permissions, malformed query) now fail fast
  instead of burning the full retry budget.

## [1.1.0] — 2026-07-22

- **Richer local web UI** (`sf-org-migrator ui`): a Setup tab that checks both
  org connections, an Objects & Fields tab that reads both orgs and lets you
  pick which objects and fields to migrate (saved to `migration.config.json`),
  and a Run tab with a live log plus a progress bar and ETA. Still localhost-only.
- Descriptions are capabilities-focused; removed comparison/limit framing.

## [1.0.1] — 2026-07-21

- Removed a customer-specific custom-object example from the code and docs.
  Custom-object support is unchanged and documented generically (add a
  `Legacy_<Object>_Id__c` field + config / a batch class following the standard
  pattern).

## [1.0.0] — 2026-07-21

First public release.

### Node tool (`sf-org-migrator`)
- Migrate **records** (Account, Contact, Opportunity, Case, and configurable
  custom objects) between orgs, upserting on `Legacy_*_Id__c` external Ids with
  lookup/master-detail parent remapping.
- Migrate **files** up to **2 GB each** (multipart REST) — streamed to disk,
  **resumable**, with full version history.
- **Automatic field mapping**: fields discovered from both orgs; formulas,
  auto-numbers, system fields, and unmapped lookups excluded; record types
  mapped by DeveloperName; State/Country picklists handled via ISO codes.
- **OAuth device-flow login** (`login`) — no CLI, no passwords; also supports
  Salesforce CLI orgs (`init`) and a username/password `.env`.
- `doctor` preflight checks, auto file-logging, and a **local web UI** (`ui`).

### Salesforce package (`sfdx-package`)
- One deploy installs the batch classes, hourly sync schedulers,
  `Legacy_*_Id__c` external Id fields, the `Migration_Sync_State__c` custom
  setting, and the `Migration_Access` permission set.
- Apex test classes: 18 tests, 100% pass, coverage above the 75% production
  requirement.

### Docs
- README, GUIDE_A (local machine), GUIDE_B (Azure VM), OAUTH_SETUP,
  APEX_AND_SYNC, SECURITY, and ROADMAP.
