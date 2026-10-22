# Sign in with Microsoft

People can sign in to the metrics site with their Sanctuary Microsoft 365
account, the same login as Outlook and Teams. Once it's set up, it's the way
everyone signs in.

**Who can get in.** Only Sanctuary work accounts:

- Sign-in is pinned to the Sanctuary Recovery Centers tenant,
  `d2b75006-002d-467c-9718-c57a492f182a`. Microsoft's own sign-in metadata for
  both `sanctuaryrecoverycenters.com` and `sanctuaryrc.com` points to it. The
  code uses it by default, so `MS_TENANT_ID` isn't needed.
- The email must be on one of those two domains.

Within that, one of these must also be true:

- An admin has added their work email on **Account → People**. Either domain
  matches, and after the first sign-in the account is tied to that person's
  Microsoft ID.
- They're the master admin (`ADMIN_EMAILS`, which defaults to
  `breinhart@sanctuaryrecoverycenters.com`). The first time that person signs
  in, the admin account is created for them.
- Anyone else in the tenant gets in as **staff** on their first sign-in, and
  the admins get an alert. Staff see Home, Social media, the print shop,
  presentations, website edits and their own requests; an admin turns on
  **Reports** or **Cost management** for them under People. Set
  `MS_AUTO_CREATE=false` to stop this.

With `MS_AUTO_CREATE=false`, everyone else sees "There's no account for … yet. Ask an admin to add you."

Once Microsoft sign-in is on, every **Sign in** button on the site goes to
Microsoft and the password forms are hidden. If Microsoft is ever down, an
admin can still use the password form at `/login.html?password=1`.

The app only learns who signed in: name and email. It can't read mail, files
or anything else.

## Setup (once, needs a Microsoft 365 admin)

### Option A: script

From the repo, in PowerShell:

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser   # first time only
./tools/register-signin-app.ps1 -Tenant sanctuaryrecoverycenters.com
```

The script prints `MS_CLIENT_ID` and `MS_CLIENT_SECRET`, plus the tenant ID so you can confirm it's the Sanctuary one.

### Option B: Azure portal

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **Applications → App registrations → New registration**.
   - Name: `Sanctuary Metrics sign-in`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Web**, `https://sanctuarymetrics.vercel.app/api/microsoft`
2. On the **Overview** page:
   - Copy the **Application (client) ID** → `MS_CLIENT_ID`.
   - Check that **Directory (tenant) ID** reads `d2b75006-002d-467c-9718-c57a492f182a`. If it doesn't, you're in the wrong tenant.
3. Go to **Certificates & secrets → New client secret** (24 months). Copy the **Value**, not the ID → `MS_CLIENT_SECRET`.
4. Go to **API permissions**. `User.Read` is there by default; add **Microsoft Graph → Delegated → openid, profile, email**. Then click **Grant admin consent**.
5. Optional: under **Token configuration → Add optional claim → ID → email**.

### Then in Vercel

Go to **sanctuarymetrics → Settings → Environment Variables (Production)**. Add:

- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`

Optionally add `MS_AUTO_CREATE=false` to stop new staff signing themselves in.

Redeploy. Once both are set, the **Sign in with Microsoft** button appears and every sign-in goes through Microsoft.

**Custom domain.** If the site moves to its own domain, add that domain's
`/api/microsoft` as another redirect URI on the app. Also set `MS_REDIRECT_URI`
if you want to pin it.

## Notes

- Accounts are matched by email. If someone's Microsoft sign-in name (UPN)
  differs from the email an admin entered, the error message shows the email
  Microsoft gave. Add the account with that email.
- When someone with a temporary password first signs in with Microsoft, the
  temporary password is deleted. From then on they use Microsoft.
- Turning an account off on **Account → People** blocks Microsoft sign-in too.
- The client secret expires; the script sets it to 24 months. Make a new one
  before then, or Microsoft sign-in stops. Password sign-in keeps working.

## Every page needs a sign-in

`middleware.js` sits in front of the whole site. Anyone without a valid
session goes to `login.html` first. After signing in they land on the page
they asked for; visiting the site root lands them on the report
(`index.html`). Signing out sends them back to `login.html`.

These stay open:

- `login.html`
- `account.html`, for first-time setup and the `?password=1` fallback
- `/api/*`, since each function checks access itself
- images, scripts and styles

The old team password no longer gets anyone past the front door. Everyone
needs an account (Admin → People).
