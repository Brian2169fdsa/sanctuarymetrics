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
