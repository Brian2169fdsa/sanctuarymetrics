# GA4 setup for sanctuaryrecoverycenters.com

Intake hasn't confirmed whether GA4 is installed on the Duda site yet. Work
through this in order and skip any step that's already done.

## 0. Is GA4 already installed?

1. **GA4 → Admin → Data streams.** Look for a Web stream for
   `sanctuaryrecoverycenters.com`. If one exists, copy its **Measurement ID**
   (`G-…`). The numeric **Property ID** is under Admin → Property details.
2. **Duda → the site (53a051d0) → Site Settings → Google Analytics** (on some
   Duda dashboards this sits under *Integrations*). If that field already
   holds the same `G-…`, GA4 is live. Confirm in GA4 → Reports → Realtime
   while you load the site in another tab.
3. If both are empty: create the property (Admin → Create → Property, time
   zone **America/Phoenix**, currency USD), add a Web data stream for
   `https://sanctuaryrecoverycenters.com`, then paste its `G-…` into the
   Duda field and republish the site.

Use the Phoenix time zone. The pipeline's windows are computed in Phoenix
time, so a property set to another zone would shift the day boundaries.

## 1. Lead actions as key events (no form contents, ever)

The report's **Click-to-call** and **Form submissions** cards need two GA4
key events. Count events only. Form field values must never be sent to GA4
as event parameters.

**Click-to-call (`click_to_call`).** Duda's click-to-call buttons are `tel:`
links, which GA4's enhanced measurement doesn't track. Add Google Tag Manager
to the site (Duda → Site Settings → Head HTML). In GTM, create a trigger:
*Just Links*, where Click URL starts with `tel:`. Attach a GA4 Event tag
named `click_to_call` with **no parameters**.

**Form submissions (`form_submit_lead`).** Duda forms post by AJAX, so GTM's
form trigger and GA4's built-in `form_submit` are unreliable. Instead, set
each contact form's on-submit action to redirect to a `/thank-you` page.
Then in GA4 → Admin → Events → Create event: name `form_submit_lead`, with
the condition `event_name = page_view` AND `page_location contains
/thank-you`. The count comes from the page view, so no form data is
involved.

Mark both events as **key events** (Admin → Events → star / "Mark as key
event"). From then on they appear in report 5 of the API spec by name.

The guardrail still applies: `form.csv` and Duda form submissions stay out
of the pipeline entirely. The Sheet only ever sees counts.

## 2. Custom channel group to de-fragment social referrals

Out of the box, GA4 can split Facebook traffic across `facebook.com`,
`m.facebook.com`, `l.facebook.com` and `lm.facebook.com`, and LinkedIn across
`linkedin.com` and `lnkd.in`. Add one channel group that rolls these up per
network.

GA4 → Admin → Data display → **Channel groups** → *Create new channel group*.
Name it **Sanctuary channels** and start from a copy of the Default group.
Add these channels **above** "Organic Social", so they take precedence:

| Channel | Condition (Source *matches regex*) |
|---|---|
| Social – Facebook | `^(m\.\|l\.\|lm\.\|web\.)?facebook\.com$\|^fb$\|^facebook$` |
| Social – Instagram | `^(l\.)?instagram\.com$\|^ig$\|^instagram$` |
| Social – LinkedIn | `^(www\.)?linkedin\.com$\|^lnkd\.in$\|^linkedin$` |

(Type the regex without the backslashes before `|`. They only escape the
table.)

Channel groups apply retroactively. Standard properties allow two custom
groups.

To use the group in the pipeline, look up its API name with the `metadata`
call in `API_SPEC.md` §3 (`sessionCustomChannelGroup:…`). Then replace
`sessionDefaultChannelGroup` in report 3 of the Make GA4 module.

## 3. Auth for the Data API

Make's **Google Analytics 4** app connects by OAuth as a Google account.
Make's native app doesn't support service-account keys. Signing a
service-account JWT in Make would mean keeping a private key in the
scenario, which is worse than OAuth.

Recommendation: a dedicated Google account owned by the agency, for example
an `analytics@` mailbox rather than a person's login. Give it **Viewer** on
the GA4 property only, and make it the account behind the Make connection.
The same account can own the metrics Sheet. If it's a person's account
instead, the pipeline breaks when that person leaves.

## 4. The switchover: label it

GA4 counts sessions; Duda's dashboard counted "visits" by its own rules. The
two will not match, and GA4 is usually lower because it filters bots and
counts engaged sessions differently. The report must not chart Duda months
and GA4 months as one series. When the first GA4-sourced snapshot ships, the
website section's `source` line should read
*source: Google Analytics 4 (from <date>; earlier periods Duda analytics,
not comparable)*. Keep the Duda figures already in `data.js` exactly as
they are.

## 5. Compliance note: get a sign-off

Sanctuary is a treatment provider. Google won't sign a BAA for Google
Analytics, and HHS has published guidance on tracking technologies on
healthcare sites. GA4 should stay on public marketing pages only, never on
any page that collects or shows health information. Have Sanctuary's
compliance contact sign off before GA4 goes live. This pipeline only ever
reads aggregate counts.
