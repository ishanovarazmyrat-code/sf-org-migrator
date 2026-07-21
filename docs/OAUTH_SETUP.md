# OAuth Setup (the robust login — no CLI, no passwords)

Do this once per org. You create an **External Client App** with device flow
in each org, then `node cli.js login` authorizes both in a browser (works on a
VM too). No Salesforce CLI, no passwords stored.

> Salesforce replaced "Connected Apps" with **External Client Apps**. A
> locally-created app only works in the org it was created in, so you make one
> in the **source** org and one in the **target** org. (A published/managed
> ISV app could be shared across orgs — that's a later step.)

## 1. Create an External Client App — in EACH org

In the org: Setup → **App Manager** → **New External Client App**:

- **Name:** `Org Migration Tool`, **Contact Email:** yours
- **API (Enable OAuth Settings):**
  - **Enable OAuth** ✓
  - **Callback URL:** `https://login.salesforce.com/services/oauth2/success`
  - **Scopes:** `Manage user data via APIs (api)` and
    `Perform requests at any time (refresh_token, offline_access)`
- **Create**, then open the app → **Settings** → **OAuth Settings** → **Edit**:
  - **Enable Device Flow** ✓  (required)
  - Leave refresh-token rotation as-is — the tool handles it.
- Copy the **Consumer Key** (and Secret, if the app has one) from **OAuth
  Settings → Consumer Key and Secret**.

Repeat in the other org. You'll have two Consumer Keys (one per org).

> New apps can take a few minutes to become active — if login says "invalid
> device code" right away, wait a couple of minutes and retry.

## 2. Log in

```bash
node cli.js login source     # then: node cli.js login target
```

For each: enter that org's **Consumer Key** (and Secret, or Enter for none),
answer the sandbox prompt, then it prints a URL + code:

```
[SOURCE] Open this URL and enter the code:
  https://login.salesforce.com/setup/connect
  code: ABCD-EFGH
```

Open that URL **in a browser logged into that same org**, enter the code, and
approve. The device connects to whichever org the browser is logged into — so
for the target, use an incognito window logged into the target org.

Tokens are saved in `.auth/` (gitignored — refresh tokens only, no passwords).
The tool refreshes them automatically, including rotation.

## 3. Continue

```bash
node cli.js doctor      # should be all green
node cli.js migrate
```

## On a VM

Same commands. `node cli.js login source` / `login target` print a URL + code;
you approve in the browser on your **own** computer — nothing needs a browser
on the VM. This is cleaner than the older auth-URL method.

## Notes

- One External Client App **per org** (a local app is org-specific).
- `.auth/` holds refresh tokens — keep it private; delete it to log in again.
- Re-run `node cli.js login <source|target>` any time to switch orgs.
