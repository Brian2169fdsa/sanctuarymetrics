# Who's giving: SCI donors and the gift tracker

`donors.html` lists everyone who has given to Sanctuary Community Initiative, what each person is owed as a thank-you or member gift, and whether it has gone out. You open it from the **Who's giving** button on the SCI Fundraising and sanctuaryci.org Metrics pages. The button shows how many items are waiting to be sent.

It is a private staff view, not a donor wall. Nothing on it is published, embedded, exported or shared.

## How access is protected

- **The page.** `middleware.js` sends anyone who isn't signed in to `login.html`. People without Reports access go to `home.html`. Pull-request previews also sit behind Vercel's SSO.
- **The data.** `/api/donors` (`lib/donors.js`) answers only to a signed-in account with Reports access, using the person's own account. The shared team password is refused, so every change is recorded under a real name.
- **Admin-only actions.** Import, adding a donor by hand, the thank-you rule, the sync and resolving unmatched records are for site admins.
- **Fails closed.** On a deployment without Supabase settings, the API returns 503 and no donor data.
- **The button.** It calls `/api/donors?count=1`, which returns a number, never a name.
- **Addresses.** They're returned only for the one open donor (`?id=`), and shown only on that donor's panel.
- **Source folders.** `lib/`, `tools/`, `tests/`, `automations/`, `supabase/` and `pipeline/` are never served (404). Before this change, any `.js` file in those folders could be downloaded without signing in.
- **Still public, as before:** other `.js` files at the top level, such as `data.js` and `ui.js`, are served without sign-in because `login.html` needs them. That's why no donor data may ever go into a `.js`, `.html` or `data/` file.

## Where donor data is stored

Supabase, in the tables from `supabase/donors.sql`. Row level security is on with no policies, so only the server's service-role key can read them. This is the same pattern as the Projects page.

| Table | Holds |
|---|---|
| `sci_donors` | Name, the Staff / Anonymous / Offline flags, notes, the optional mailing address, imported figures, monthly amount, linked Donorbox supporter ids |
| `sci_gifts` | Gift history: date, amount, campaign, one-time / recurring / offline (from Donorbox, or entered by hand) |
| `sci_fulfillment` | One row per item owed: status, size, method, date sent, sent by, tracking or note, last updated by and when |
| `sci_donor_log` | Who changed what, and when |
| `sci_donorbox_unmatched` | Donorbox records the sync couldn't match, waiting for a person |
| `sci_donor_settings` | The thank-you rule, the last sync |

No emails, phone numbers or payment details are stored. `data/fundraising-metrics.json` stays aggregates-only.

## Setup

1. Run `supabase/donors.sql` in Supabase → SQL Editor (it's also in `ALL.sql`).
2. Deploy. Nothing else is needed for stage 1.

## Running the import (stage 1)

1. As an admin, open **Who's giving** and scroll to **Admin → Import donors**.
2. Paste the CSV, or choose the file. Required columns: `Donor Name, Total Given, Number of Gifts, Most Recent Gift, Notes`. Optional columns: `Staff`, `Anonymous`, `Offline` (yes/no) and `Monthly Amount`, the base monthly amount (a charged amount like 10.86 is read as 10). Dates are MM/DD/YYYY. Tab-separated text pasted from a spreadsheet works too.
3. Press **Preview**. Each row shows as new, update, unchanged or error. Nothing is written until you press **Write**.
4. After writing, each donor gets their owed items: tier items for monthly donors, and the thank-you rule for everyone else.

Re-running the import is safe. For donors who already exist, it updates only the giving figures, and a `Monthly Amount` that staff or Donorbox haven't set. It never resets gift statuses, addresses, notes or flags.

Keep donor CSVs out of the repo. `.gitignore` blocks `*donor*.csv` as a guard.

## Turning on the Donorbox sync (stage 2)

Once the Zapier and API add-on is active, set these in Vercel → Environment Variables (Production), then redeploy:

| Variable | Value |
|---|---|
| `DONORBOX_EMAIL` | The Donorbox account email |
| `DONORBOX_API_KEY` | The API key (Donorbox → API & Zapier Integration) |
| `DONORBOX_SYNC_ENABLED` | `true`. Leave it unset to keep the sync off. |
| `CRON_SECRET` | A long random string. Vercel sends it with the daily cron (`vercel.json`, 13:20 UTC = 6:20 a.m. Phoenix). |

Admins also get a **Sync now** button. The sync is read-only (`GET /donors`, `/donations`, `/plans`) and works like this:

- **Matching.** It matches each Donorbox supporter by a linked id first, then by exact name (the imported records). Duplicate supporter records for one person merge into one donor. Records whose names match `excludeNames` in the config (test records) are skipped. Anything else waits under **Unmatched Donorbox records**, where an admin chooses "same person as…", "add as a new donor" or "ignore".
- **What it updates.** Gift history, which replaces the imported figures for that donor once their Donorbox gifts arrive. Monthly status and amount, from active monthly plans, using the base amount before covered fees.
- **What it never touches.** Gift statuses, addresses, notes, and the Staff / Anonymous / Offline flags. A tier upgrade adds the new item as Owed; items already sent stay as they are.
- **Offline gifts.** Ones entered in Donorbox come through the sync. The **Add an offline gift** form on a donor's panel is the fallback for gifts that aren't in Donorbox.

## Editing tiers and what people are owed

Everything is in one object, `DONOR_CONFIG` in `lib/donors-config.js`:

- **Tiers.** Each tier has a `minMonthly` and its own `items`. Items add up: a tier owes its items plus those of every tier below it. An amount between tiers takes the tier below. For example, moving Gambel's Quail to $20 means changing `minMonthly: 25` to `20`. Every derived tier and owed item follows on the next page load, with no other code to change.
- **The thank-you rule.** The default is one note per one-time or offline donor. Admins change the rule on the page: one per donor, only when a donor's total reaches an amount, one per gift, or none.
- **Covered fees.** `coveredFee` holds the gross-up used to turn a charged amount back into the base amount: $10.86 → $10, $21.41 → $20.

Changing a rule or a tier only ever adds newly owed items. It never removes or changes items already created.

## Gift statuses

Not owed · Owed · **Address needed** · Packed · Sent · Delivered · Declined by donor.

"Address needed" isn't stored. It shows whenever an item is Owed, there's no address on file, and the method is Mail. Add the address, or set the method to Hand-delivered, and it reads Owed again. **Mark sent** records today's date (Phoenix time) and the signed-in person. The button count and the "Gifts to send" queue include Owed, Address needed and Packed items.
