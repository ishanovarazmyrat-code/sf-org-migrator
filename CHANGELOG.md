# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org).

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
