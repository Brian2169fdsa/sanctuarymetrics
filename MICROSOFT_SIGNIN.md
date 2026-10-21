# Sign in with Microsoft

People can sign in to the metrics site with their Sanctuary Microsoft 365
account, the same login as Outlook and Teams. Email-and-password sign-in still
works alongside it.

**Who can get in.** Only people in the Sanctuary tenant, and only if one of
these is true:

- An admin has added their work email on **Account → People**.
- They're the master admin (`ADMIN_EMAILS`, which defaults to
  `breinhart@sanctuaryrecoverycenters.com`). The first time that person signs
  in, the admin account is created for them.
- `MS_AUTO_CREATE=true` is set. Then anyone in the tenant gets in as a
  **member**, and the admins get an alert when someone joins.

Everyone else sees "There's no account for … yet. Ask an admin to add you."

The app only learns who signed in: name and email. It can't read mail, files
or anything else.

## Setup (once, needs a Microsoft 365 admin)

### Option A: script

From the repo, in PowerShell:

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser   # first time only
./tools/register-signin-app.ps1 -Tenant sanctuaryrecoverycenters.com
```

The script prints `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET`.

### Option B: Azure portal

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **Applications → App registrations → New registration**.
   - Name: `Sanctuary Metrics sign-in`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: platform **Web**, `https://sanctuarymetrics.vercel.app/api/microsoft`
2. On the **Overview** page, copy:
   - **Application (client) ID** → `MS_CLIENT_ID`
   - **Directory (tenant) ID** → `MS_TENANT_ID`
3. Go to **Certificates & secrets → New client secret** (24 months). Copy the **Value**, not the ID → `MS_CLIENT_SECRET`.
4. Go to **API permissions**. `User.Read` is there by default; add **Microsoft Graph → Delegated → openid, profile, email**. Then click **Grant admin consent**.
5. Optional: under **Token configuration → Add optional claim → ID → email**.

### Then in Vercel

Go to **sanctuarymetrics → Settings → Environment Variables (Production)**. Add:

- `MS_TENANT_ID`
- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`

Optionally add `MS_AUTO_CREATE=true`.

Redeploy. The **Sign in with Microsoft** button appears on the sign-in screens
once all three are set.

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
