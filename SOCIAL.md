# Social media

`social.html` is where the team sends event photos and marketing turns them
into posts. The server side is `api/social.js`; the table and private photo
bucket are in `supabase/social.sql` (also in `supabase/ALL.sql`).

## How it works

1. **Staff** open **Social media**, add up to 10 photos and a few words about
   the event, tick the consent box and press **Send to marketing**. The browser
   shrinks each photo to WebP, which also drops location and camera data.
2. The site then:
   - files a task on the Projects page, so the sender can follow it under
     **My requests** and message about it
   - puts a bell alert on every admin's account
   - posts a **Teams message** if `TEAMS_WEBHOOK_URL` is set (below)
   - asks **Claude** for draft posts for Facebook, Instagram and LinkedIn,
     plus hashtags, alt text and a **privacy check**. The privacy check flags
     anything that could identify a client: unknown faces, name badges,
     paperwork or screens.
3. **Admins** see the queue under Social media. For each post they can open it,
   edit the drafts, **Copy** a post (hashtags included), open Meta Business Suite
   or LinkedIn, **Redraft** with a note, and **Mark posted**. Marking it posted
   ticks the task done and alerts the sender.
4. **Publish now** posts it to the Facebook Page and the LinkedIn company page
   in one click (see "Publishing" below). It marks the post posted, with links
   to both, once both platforms confirm.

Admins can do the whole thing themselves: fill in the same form with the gist
and the photos, and it opens straight on Claude's drafts, ready to publish.

Photos are never public. They sit in a private Supabase bucket and are only
shown through links that expire after an hour, to signed-in people who may
see the post.

## Settings (Vercel → Settings → Environment Variables)

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY` | Needed for Claude's drafts. Submissions still work without it; the draft shows an error and **Redraft** works once the key is added. |
| `TEAMS_WEBHOOK_URL` | The Teams webhook address (below). Without it there's no Teams message, but the bell alerts still go out. |
| `SOCIAL_MODEL` | Optional. Defaults to `claude-opus-5-5`. |
| `SITE_URL` | Optional, e.g. `https://sanctuarymetrics.vercel.app`, for the link in the Teams message. |
| `SOCIAL_PUBLISH_WEBHOOK_URL` | The Make webhook that publishes to Facebook and LinkedIn (below). Without it, posting is by hand. Treat it like a password: anyone with it can post to the pages. |

## The Teams message

This uses a Teams **Workflows** webhook, which posts a card to a chat or
channel whenever the site calls it.

1. In Teams, open the chat or channel where the message should land. For
   example, a chat with yourself, or a small "Social media" channel.
2. Click **⋯ → Workflows**, and pick **"Send webhook alerts to a chat"** (or
   **"…to a channel"**).
3. Name it "Sanctuary social posts", choose where it posts, and click **Add
   workflow**.
4. Copy the URL it shows. It's long and starts with `https://`.
5. In Vercel, add it as `TEAMS_WEBHOOK_URL` (Production and Preview, marked
   Sensitive), then redeploy.

Each new submission then posts a card with the event, who sent it, how many
photos, the description, and a **Review & post** button.

## Publishing to Facebook and LinkedIn

The **Publish now** panel on each post sends it to a Make.com scenario. The
scenario posts it with Make's own Facebook and LinkedIn connections, so
Sanctuary doesn't need its own approved LinkedIn API app.

**What the admin does:**
1. Open the post. Check Claude's text for each platform (it can be edited
   right there).
2. Pick the photos:
   - **Facebook:** up to 10 photos in one post.
   - **LinkedIn:** one photo per post. That's a limit of Make's LinkedIn company-page module.
3. Tick that they've checked the photos and the privacy note, then press
   **Publish now**.

**What happens next:**
- Within a minute or so the panel shows **Published**, with links to both
  posts.
- The post moves to **Posted**, its task is ticked off, and the person who
  sent the photos gets an alert.
- If one platform fails, its error is shown, and **Publish now** can retry just that one.
- A platform it's already on is never posted to twice.

**Photos:** the site keeps a JPEG copy of each photo for posting, since
Facebook and LinkedIn don't reliably take WebP. Photos sent before this
feature get their JPEG made in the browser the first time they're published.

**LinkedIn text:** LinkedIn reads post text as "little text format". The site
escapes the characters it treats as codes (brackets, @, # and so on) and
turns hashtags into real LinkedIn hashtags, so the post appears as written.

### Setting it up (once)

1. **Supabase → SQL Editor:** run `supabase/social.sql` again. It adds the
   `publish` column.
2. **Make.com:** open the scenario **"Sanctuary social — publish to Facebook &
   LinkedIn"**. Its blueprint is `pipeline/make/sanctuary-social-publish.blueprint.json`.
   1. Click the **Facebook Pages** module → **Add** (a connection) → log in
      as someone who manages the Sanctuary Recovery Centers Page, and allow
      it to post. Choose the **Sanctuary Recovery Centers** page.
   2. Click the **LinkedIn** module → **Add** → log in as an admin of the
      Sanctuary Recovery Centers LinkedIn page. Choose that company.
   3. Save, then switch the scenario **ON** (bottom left).
3. **Vercel:** add `SOCIAL_PUBLISH_WEBHOOK_URL` (Production and Preview,
   marked Sensitive). The value is the scenario's webhook address, from the
   webhook module in Make. Then redeploy.

**How the site and Make talk to each other:** each publish carries a one-time
token. Make sends each platform's result back to
`/api/social?id=…&action=published` with that token, and the site accepts
nothing without it.

**Connections expire:** Facebook and LinkedIn connections run out after a while
(LinkedIn's after about a year). When one does, the panel shows that
platform's error. Reconnect it in Make, under **Connections**.
