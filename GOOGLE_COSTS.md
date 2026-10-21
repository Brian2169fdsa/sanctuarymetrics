# Google cost system

`google.html` is the **Google** tab under **Cost cutting**. It tracks the
Google Workspace cut the same way the Microsoft one was tracked. Like the
Microsoft pages, nothing on it is estimated: anything not loaded yet shows as
"needed".

## Load the data

**1. The user list.** This covers who has a license, their last sign-in,
storage and department. You need Google Admin access.

1. Google Admin console → **Directory → Users → Download users** → **All user info columns** → **CSV**.
2. Save the file in the repo folder as `google_users.csv`. Git ignores it, because the raw file holds full names and emails.
3. Run:

   ```bash
   python3 tools/build-google-js.py google_users.csv
   ```

   This rewrites `google-users.js` with mailbox names only, then flags accounts
   that are:
   - suspended but still licensed
   - never signed in
   - not signed in for 90+ days
4. Commit `google-users.js`.

**2. Subscriptions and invoices.** Edit `google-costs.js`:

- `plans`: one row per subscription from **Billing → Subscriptions**, with name, seats paid for, price per seat, Flexible/Annual, and renewal date. Use the plan names the user export shows (for example `Business Starter`).
- `invoices`: one row per month from **Billing → Transactions**, tax included.
- `realized`: add a row when an invoice shows a cut landing.
- `checklist`: set each step to `todo`, `doing` or `done` as it happens.

Once prices are in, "Could come off per month" fills in automatically. It's
the flagged accounts × their plan price.

## Approving cuts

Recommended cuts live on **Cost cutting → Overview**:

1. An admin clicks **Recommend a cut**, or **Send for approval** on a suggestion.
2. Anyone signed in can **Approve** it.
3. Approving puts a task on Brian's project list and alerts the admins.

The table is `cost_recommendations` (`supabase/cost-cutting.sql`, also in
`supabase/ALL.sql`).
