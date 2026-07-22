# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org).

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
