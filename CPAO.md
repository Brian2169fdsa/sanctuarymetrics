# CP-AO Assistor Portal (AHCCCS HEAplus access)

This replaces the email-and-paper process for HEAplus access:

1. Brian invites a staff member.
2. They fill out and sign the **CP-101 Individual User Application** on their phone.
3. An automatic check sends problems back to them. A clean application becomes a task for Brian.
4. Brian countersigns, which generates the official CP-101 PDF.
5. Every week the site builds the **Organization User Application**, bundles it with that week's CP-101s, and adds a "Send to CPAO" task.

| Page | Who |
| --- | --- |
| `cpao-admin.html` | Admins only: roster, countersign, batches, settings, audit log. It's also linked from Home → Admin. |
| `cpao-apply.html#t=…` | The person invited, signed in with **their own** Microsoft work account. |

## Setting it up (once)

1. **Supabase → SQL Editor:** run `supabase/cpao.sql`. It's also in `ALL.sql`. It creates the tables and a **private** `cpao` storage bucket.
2. **Vercel → Settings → Environment Variables**, then redeploy:

   | Variable | |
   | --- | --- |
   | `CPAO_PII_KEY` | **Required.** 32 random bytes. Generate one with `openssl rand -base64 32`. Keep a copy somewhere safe, like a password manager: without it the saved SSNs, dates of birth and addresses can't be read. |
   | `CRON_SECRET` | **Required for the weekly batch.** Any long random string. Vercel sends it to the scheduled job. |
   | `ANTHROPIC_API_KEY` | Already set for the site. Without it, every application comes to Brian for a manual check. |
   | `CPAO_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
   | `CPAO_SEND_EMAIL=true` | Optional. Emails invites and "please fix" notes from Brian's mailbox through Microsoft Graph. It needs the **Mail.Send** application permission, admin-consented, on the Microsoft sign-in app. When this is off, the admin page shows the link to copy into Teams or Outlook. |
   | `CPAO_CREATE_OUTLOOK_DRAFT=true` | Optional. The weekly batch leaves a **draft** to CPAO in Brian's Outlook with the PDFs attached. It needs **Mail.ReadWrite**. The draft is never sent automatically. |
   | `CPAO_REQUIRE_WET_SIGNATURE=true` | Optional. Pen-signature mode; see below. |
3. On `cpao-admin.html` → **Settings**:
   - add your office phone (it goes on the Org form)
   - **draw your signature**
   - check the batch day (Monday by default)

## The 10 stages it tracks

| # | Stage | Who | Usually takes |
| --- | --- | --- | --- |
| 1 | Invited | Brian | Same day |
| 2 | Fills out the CP-101 | Staff member | About 15 minutes; please within 2–3 days |
| 3 | Brian countersigns | Brian | 1–2 business days |
| 4 | Add/Remove form (Organization User Application) | Brian | Weekly, on the batch day |
| 5 | Sent to CPAO: background check | AHCCCS / CPAO | **1 week to 3 months** |
| 6 | Approved: AZLearns training | Staff member | Usually 1–2 weeks |
| 7 | Certificates turned in | Staff member → Brian | Same day they finish |
| 8 | Certificates sent to CPAO for final approval | Brian → CPAO | Brian: 1–2 business days; CPAO's reply varies |
| 9 | Final approval: Brian creates the HEAplus account | Brian | 1–2 business days |
| 10 | Active in HEAplus | Staff member | Done |

Overall it takes about 3 weeks at the quickest and up to 3–4 months. Almost all of that is the background check.

The steps and timings live in `cpao/process.js`, and both pages read them from there:
- **Roster:** each person shows their step and how long they've been on it. The "How it works" section under the roster shows the steps above.
- **Person page:** shows the date each step happened, and a **✓ next step** button that moves them on and records the date.
- **Tasks:** "Certificates turned in" and "Final approval" add tasks for you, and moving on closes the previous task.
- **Follow-ups:** each person has a follow-up log for CPAO questions, corrections, calls and emails. A reminder date adds a task on the Projects page.

**Opening a person:** click a name on the roster to open them in a pop-up. It shows where they are in the 10 steps, what they submitted, the automatic check, follow-ups and every action. **Open full page ↗** gives the same view as its own page.

**If AHCCCS denies an application:**
1. Open the person and use **CPAO denied it?** to enter the reason and the letter date.
2. The denial is logged in their follow-ups, and you get a "Let … know" task due the next business day. Tell them privately, in person or by phone.
3. If the reason can be fixed, press **Invite them to reapply**. They start again at step 1.

## Staff picker (invite from Microsoft 365)

**+ Invite someone** opens a search box over your Microsoft 365 staff list. It filters as you type.
- **Click a name** to fill the form with their first and last name, work email, job title, hire date and office address, if those are filled in Microsoft.
- **Tick several** and press **Invite all n** to invite them together.
- People already on the roster are greyed out.
- Shared mailboxes and accounts outside the Sanctuary domains don't appear.

**To switch it on (once):**
1. Go to [Entra admin center](https://entra.microsoft.com) → App registrations → the site's sign-in app (the one whose ID is in `MS_CLIENT_ID`).
2. Open **API permissions → Add a permission → Microsoft Graph → Application permissions**, add **User.Read.All**, then **Grant admin consent**.

This permission is read-only: it lists names, titles, emails and hire dates. No redeploy is needed.

Until it's granted, the box says what's missing, and you can type the details by hand. Hire date and office address appear only if HR keeps them filled in Microsoft 365. Otherwise, add the hire date by hand; the Org form needs it.

## How to invite someone

1. Go to **Roster → + Invite someone**.
2. Pick them from Microsoft 365, or type their name, work email, title and hire date. Tick Site Administrator if they'll be one (Add-SA).
3. Send the link:
   - If email is on, they get Brian's usual note with the link.
   - If not, copy the link shown and send it to them in Teams or Outlook.

About the link:
- It lasts **14 days** and stops working once they submit.
- It only opens for the work account it was sent to.
- Five tries from a different account lock it. **Re-send invite** on their page makes a fresh link.

There is no emailed 6-digit code, unlike the original spec. The person must instead be signed in with the Sanctuary Microsoft account the invite went to. That sign-in is MFA-backed and needs no mail server.

## What the staff member sees

Seven steps, saved as they go, so they can stop and come back with the same link:

1. **About you:** legal name, middle initial or "no middle name", and a box confirming the name matches their license.
2. **Identity:** date of birth and SSN, each hidden as they type and entered twice.
3. **Contact:** home address, city, state, ZIP, phone and email.
4. **Role:** title, paid or volunteer, and hire date.
5. **Conditions:** the full CP-101 pages 2–3. "I agree" only unlocks after scrolling to the end.
6. **Sign:** a signature pad.
7. **Review and submit:** the SSN shows only as •••-••-1234.

**On submit:**
- **Required-field rules:** names, the SSN rules, age 18+, ZIP, phone, email, a signature that isn't blank, and both checkboxes.
- **Claude check:** Claude gets a **redacted** summary only: names, title, city, state, ZIP, email domain, pay status and hire date, plus true/false flags for SSN, date of birth and address. It looks for nicknames, ZIP/city mismatches, the sanctuaryrc.com alias, vague titles and odd hire dates.
- **Results:**
  - *Fix required:* they see the issues, each with a link to the right step.
  - *Pass or needs a look:* status becomes **Ready to countersign**, and a task "CP-101 ready to countersign: Name" lands on the Projects page, due in 2 business days.

## Countersigning

1. Open the person from the roster. The SSN, date of birth and address stay hidden until you press **Show**, and every Show is logged.
2. Press **Countersign and generate PDF**. This stamps your signature and today's date, fills the CP-101, stores the PDF privately, closes the task, and queues them for the next batch.
3. If something's wrong, use **Send back to them with a note** instead. They get a fresh link.

## How the weekly batch works

**Every batch day at 8:00 am Phoenix time:**
- The scheduled job collects everyone *Queued for batch* (Add, or Add-SA) and *Removal requested* (Remove, or Remove-SA).
- It fills the Organization User Application, with 6 people per copy; more people means more copies, merged.
- It signs the form, flattens it, and merges it with each person's CP-101 into one bundle.
- It adds a task: "Weekly CPAO batch ready: n add, m remove".

**Then Brian:**
1. Downloads the bundle from **Weekly batches**.
2. Emails it to CP-AOOperationsTeam@azahcccs.gov **from his own mailbox**. Only the site administrator may email CPAO.
3. Presses **Mark as Sent**.

**Mark as Sent:**
- moves adds to *Sent to CPAO* and removals to *Removed*
- adds a "Check CPAO status" task for 14 days later

**When CPAO replies,** set each person's status on their page. *Correction requested* and *Training complete* add a task for you ("Create HEAplus account for …").

**Re-running a batch:** press **Build the batch now** under Weekly batches. It replaces any batch not yet marked sent, including its task and files. Use it after a late countersign, or to send before the scheduled day.

## Retention

- **Personal data:** SSN, date of birth, address and signature images are deleted **90 days after the batch is marked sent**, or right away when someone is marked *Removed*.
- **Generated PDFs:** kept for the days set in Settings (365 by default). The form says every party must keep a copy, so the PDF is the record.
- **Schedule:** the purge runs every morning with the scheduled job, and on demand under Settings.

## Rotating the PII key

1. Generate a new key: `openssl rand -base64 32`.
2. In Vercel:
   - set `CPAO_PII_KEY_OLD` to the **current** key
   - set `CPAO_PII_KEY` to the **new** key
   - redeploy
3. On `cpao-admin.html` → Settings, press **Re-encrypt with the new key**. It reports how many were re-sealed.
4. Remove `CPAO_PII_KEY_OLD` and redeploy.

Each saved value records which key sealed it, so nothing is lost mid-rotation.

## Pen-signature mode (`CPAO_REQUIRE_WET_SIGNATURE`)

CPAO has historically received wet-signed scans. Until they confirm that drawn signatures are OK, this mode can be turned on:

- Step 6 offers the **pre-filled CP-101 to print**.
- The person signs it and uploads one PDF scan. It must be a PDF, not a photo, with all 4 pages.
- Countersigning keeps their scan as the record.

## Security notes

- Date of birth, SSN and home address are encrypted with AES-256-GCM on the server before they reach Supabase.
- They are never sent to Claude, never in a URL, log, error message or email.
- The invite token is kept in the browser tab, not the address bar, and only its hash is stored.
- All CP-AO tables have row level security on with no policies: only the server can read them.
- Files live in a private bucket, and downloads are 5-minute links.
- The audit log (`cpao_audit_log`) records every:
  - view of an application
  - Show of SSN, birth date or address
  - download
  - signature
  - status change
  - automatic check, with the redacted request and response

## For developers

- `cpao/assets/cpao_field_schema.json` is the contract: fields, rules and PDF coordinates.
- Code:
  - `lib/cpao.js`: validators and the Claude check
  - `lib/cpao-pdf.js`: pdf-lib
  - `lib/cpao-crypto.js`: encryption
  - `lib/cpao-graph.js`: optional mail
  - `api/cpao.js`: everything else
- `npm test` runs the validators, SSN rules, 6-row overflow, AI-answer parsing and encryption tests.
- `npm run cpao:golden` re-renders `cpao/golden/*.png`: both forms filled with obviously fake data (Jane Example, SSN 000-00-0000), to check alignment by eye. It needs `pdftoppm`.
- The Conditions text in `cpao/cp101-text.js` is generated from the blank PDF by `tools/build-cpao-text.py`.
