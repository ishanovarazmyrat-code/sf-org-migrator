# Roadmap — Turning this into a public product

The tool works end-to-end today (records + files + version history, CLI auth,
`doctor`, web UI, one-deploy package, validated on fresh orgs). This roadmap
is what's left to make it a product anyone can use.

**Recommended path:** ship an open-source CLI + package first (fast, builds
adoption), then layer a hosted/paid service on top. Leave AppExchange for last
(heaviest process). Effort tags: 🟢 hours–days · 🟡 1–2 weeks · 🔴 weeks–months.

---

## Known issue to solve properly

- **CLI-auth is fragile across CLI versions.** Recent Salesforce CLI versions
  (≈2.14x+) mask both the access token and the sfdxAuthUrl in `sf org display`,
  so the tool can't extract a usable token. Current workaround: export the auth
  URL from a machine with an older CLI and pass it via `SOURCE_AUTH_URL` /
  `TARGET_AUTH_URL`. Proper fix for the product: the tool should own its OAuth
  (its own connected app + web/device flow) or support JWT, instead of leaning
  on the CLI's stored token. Until then, the username/password `.env` fallback
  always works.

## Phase 0 — Mandatory before ANY public release (blockers)

1. ~~**Apex test classes**~~ ✅ **DONE (2026-07-21).** Test classes shipped in
   `sfdx-package` (a shared `SourceOrgMigrationMock` + one test per batch +
   `SyncSchedulersTest`). Validated on a real org: all pass, per-class coverage
   ≈79–94%, comfortably above Salesforce's 75% aggregate production requirement.
2. ~~**Field / relationship mapping robustness**~~ ✅ **DONE (2026-07-21).**
   Fields are now auto-discovered per object (describe both orgs, copy the
   intersection of writable fields; formulas/auto-numbers/system/unmapped
   lookups excluded automatically). Record types mapped by DeveloperName.
   State/Country picklists handled by sending ISO *Code* fields instead of
   text. Required-target-field warnings. Validated on real orgs: Account went
   from 1 field/16-with-11-failing to **80 fields, 16/16 clean**; remaining
   failures are genuinely invalid source data, clearly reported.
3. ~~**Security review of the code**~~ ✅ **DONE (2026-07-21).** `SECURITY.md`
   added (credential handling, data-at-rest guidance, disclosure). Real fix
   from the review: the web UI now binds to **127.0.0.1 only** (was reachable
   from the network). Token files are mode 600, logs never contain secrets,
   UI runs a fixed command allowlist.

## Phase 1 — Open-source MVP release 🟢🟡

5. ~~**GitHub repo**~~ ✅ **DONE (2026-07-21).** Repo
   `ishanovarazmyrat-code/sf-org-migrator` (private for now), MIT LICENSE,
   README, SECURITY.md, root .gitignore (no secrets committed), and a **passing
   CI** (`.github/workflows/ci.yml` — npm ci + JS syntax check). Make public
   with: `gh repo edit --visibility public`.
4. ~~**Publish the CLI to npm**~~ ✅ **DONE (2026-07-21).** Published as
   **`sf-org-migrator` 1.0.0** (npmjs.com/package/sf-org-migrator, by `araz_m`).
   `npm install -g sf-org-migrator` gives the `sf-org-migrator` command; state
   (work/, .auth/, config) is cwd-relative. CHANGELOG.md added.
6. ~~**Turn the SFDX metadata into an unlocked package**~~ ✅ **DONE (2026-07-21).**
   Unlocked package `sf-org-migrator` v0.1.0.1 built on the `trailhead` Dev Hub,
   tests passed (≥75% coverage), **promoted to Released** (installs into
   production too). One-click install URL:
   `https://login.salesforce.com/packaging/installPackage.apexp?p0=04tJ6000000pGxfIAE`
7. ~~**Versioning / changelog**~~ ✅ semver + CHANGELOG.md in place.

**Phase 1 complete.** The product is publicly installable both ways: the CLI
via `npm install -g sf-org-migrator`, and the Salesforce side via the package
install URL.

## Phase 2 — Polish & adoption 🟡

8. **Richer UI** — object selection, field-mapping screen, progress bar / ETA,
   setup wizard.
9. **Robustness at scale** — large-volume tests, partial-failure reports,
   retry dashboard.
10. **Docs site** — hosted docs (GitHub Pages / Docusaurus), demo video, and a
    comparison table vs SFDMU / Gearset / Data Loader.
11. **Landing page** — the pitch ("2 GB/file, resumable, org-to-org"),
    download / CTA.

## Phase 3 — Monetization 🔴

12. **Hosted SaaS** — you run it; customers connect both orgs via **OAuth web
    flow** (no CLI install), pick objects, click Go. Needs multi-tenant auth,
    a queue/worker backend, isolated & encrypted temporary storage, a
    dashboard, and billing. Price per GB or subscription.
13. **AppExchange listing** — Partner account, namespace, managed package, and
    the **Salesforce Security Review** (automated + manual scan; fee waived for
    free apps but the process is long). Covers the in-org Apex side only.
14. **Go-to-market** — r/salesforce, LinkedIn, ProductHunt, Salesforce
    communities; free core + paid hosted/support model.

---

## The three biggest obstacles (summary)

1. **No Apex test coverage** → can't deploy to production orgs.
2. **Field mapping is minimal** → insufficient for real-world org schemas.
3. **Hosted / AppExchange** → where the revenue is, but the most work (auth,
   security review, infrastructure).

## Suggested starting point

Phase 0 · item 1 (**Apex tests**) — nothing real ships to a customer's
production org without it. Then Phase 1 (npm + GitHub + unlocked package) for
a first public, installable release.
