# Claude in Chrome prompts: pull the last three snapshots

Three prompts, one per platform. Paste each one into Claude in Chrome while
signed in to that platform. Each produces **three Markdown files**, one per
snapshot: **Oct 1**, **Oct 15** and **Oct 29, 2026**. Together they cover the
six weeks from Sep 17 to Oct 28, plus the comparison windows.

Oct 1 and Oct 15 replace the mock data now on the site (`SAMPLE_IDS` in
`data.js`). Oct 29 is the new snapshot.

| Snapshot | Meta 28d | Meta 14d (last / prior) | Website 30d | Website 14d / 7d | LinkedIn 30d | LinkedIn 14d (last / prior) |
|---|---|---|---|---|---|---|
| Oct 1 | Sep 3 – Sep 30 | Sep 17–30 / Sep 3–16 | Sep 1 – Sep 30 | Sep 17–30 / Sep 24–30 | Aug 31 – Sep 29 | Sep 16–29 / Sep 2–15 |
| Oct 15 | Sep 17 – Oct 14 | Oct 1–14 / Sep 17–30 | Sep 15 – Oct 14 | Oct 1–14 / Oct 8–14 | Sep 14 – Oct 13 | Sep 30–Oct 13 / Sep 16–29 |
| Oct 29 | Oct 1 – Oct 28 | Oct 15–28 / Oct 1–14 | Sep 29 – Oct 28 | Oct 15–28 / Oct 22–28 | Sep 28 – Oct 27 | Oct 14–27 / Sep 30–Oct 13 |

When the files are done, drop all nine into `pipeline/pulls/` (or paste them
to Claude Code) and they get turned into the `data.js` snapshots.

---

## 1. Facebook + Instagram (Meta Business Suite)

```text
You are collecting verified analytics for an internal performance report. Accuracy matters more than speed: every number must be read from the screen or from an export. Never estimate, round, interpolate or fill a gap. If a number is not available, write "NOT AVAILABLE" and say why.

ACCOUNT: Sanctuary Recovery Centers. Facebook Page ID 100063738294812 and its linked Instagram account. Before you record anything, confirm that the Page and IG account selected in the top-left account switcher are Sanctuary Recovery Centers. Do NOT use Cholla or any other business. If you can't confirm it, stop and tell me.

WHERE: Meta Business Suite (business.facebook.com) → Insights. Use the date picker's custom range for each window below. Meta computes days in Pacific time, so set the exact start and end dates.

Make THREE Markdown files, one per snapshot:
- sanctuary-meta-2026-10-01.md: 28-day window Sep 3 – Sep 30, 2026. Two-week cuts: Sep 17–30 and Sep 3–16.
- sanctuary-meta-2026-10-15.md: 28-day window Sep 17 – Oct 14, 2026. Two-week cuts: Oct 1–14 and Sep 17–30.
- sanctuary-meta-2026-10-29.md: 28-day window Oct 1 – Oct 28, 2026. Two-week cuts: Oct 15–28 and Oct 1–14.

For EACH snapshot, collect the following.

A. FACEBOOK, 28-day window (record the "vs. previous period" % Meta shows next to each one):
 - Views; Unique viewers (viewers / reach); Content interactions; Link clicks; Profile / Page visits; Follows; Unfollows; Net follows; Lifetime followers (the total as of the window end; note if the UI only shows today's total).
 - Views from followers vs. non-followers (number or %); Interactions from followers vs. non-followers.
 - 3-second video views; Watch time; Reels views; Reels interactions; Conversations started; New messaging contacts; Negative feedback (if shown); Posts published in the window.
 - Views by content format (Photo, Multi-photo, Reels, Video, Links, Text, Others): the value for each.
 - The "Compared to similar businesses / benchmark" panel, if shown: each metric with the Sanctuary value, the typical value and the standing (higher / similar / lower).
 - DAILY values for Views, Content interactions, Follows, Link clicks and Profile visits for every day of the 28-day window. Use the export (Insights → Export / Download CSV) if available, otherwise read the chart tooltips day by day. State which method you used.
 - Top posts: every post published in the window with date, short title (first ~8 words), Views, Reach, Reactions, Comments, Shares, Link clicks. Use Content → Posts with the same date range.
 - Audience (lifetime): age × gender split and top cities, with %.

B. INSTAGRAM, same 28-day window (with "vs. previous" %):
 - Views; Reach; Content interactions; Profile visits; Follows; Unfollows; Lifetime followers; Posts published (native IG posts, reels and stories counted separately); Conversations started.
 - Views and Reach from followers vs. non-followers. Views on the IG surface vs. via Facebook cross-posts, if Meta splits them.
 - Interactions by media type (Posts / Reels / Stories).
 - DAILY values for Views, Reach, Content interactions, Follows and Profile visits.
 - Every IG post in the window: date, type, short caption, Views, Reach, Likes, Comments, Saves, Shares.
 - Benchmark panel, if shown.
 - Messaging: conversations started, new contacts, response rate, response time.

C. TWO-WEEK CUTS (Facebook and Instagram separately): for each of the two 14-day ranges listed for that snapshot, record Views, Content interactions, Follows, Profile visits and (Facebook only) Link clicks. Set the date picker to each 14-day range; don't derive them from the 28-day numbers.

FILE FORMAT (use exactly this structure in each file):
# Sanctuary — Meta — Snapshot <YYYY-MM-DD>
- Pulled: <today's date and time> · Account confirmed: <Page name / IG handle>
- 28-day window: <start – end> · Meta's comparison window: <start – end as shown>
## Facebook — KPIs
| Metric | Value | vs. previous | Window | Source (screen or export name) |
## Facebook — Supporting stats
(same table columns)
## Facebook — Views by content format
## Facebook — Benchmark
## Facebook — Daily
| Date | Views | Interactions | Follows | Link clicks | Profile visits |
## Facebook — Posts in window
## Facebook — Audience
## Instagram — KPIs / Supporting / Daily / Posts / Messaging / Benchmark
(same patterns)
## Two-week cuts
| Channel | Metric | <last 14d range> | <prior 14d range> |
## Gaps and caveats
List everything marked NOT AVAILABLE, any number Meta labels as an estimate, any window that didn't match what was asked, and anything odd (spikes, missing days).

Save each file as a download if you can (create the .md file and download it). If you can't save files, output each file as its own fenced ```markdown block, headed by its filename, so I can copy them. Finish with a short checklist of which sections are complete for each of the three files.
```

---

## 2. Website (Duda)

```text
You are collecting verified analytics for an internal performance report. Accuracy matters more than speed: every number must be read from the screen or from an export. Never estimate, round, interpolate or fill a gap. If a number is not available, write "NOT AVAILABLE" and say why.

SITE: www.sanctuaryrecoverycenters.com ONLY. In the Duda dashboard (my.duda.co → Projects) there are three Sanctuary sites. Do NOT use sanctuaryci.org or www.sanctuarysoberliving.com. Open the sanctuaryrecoverycenters.com project → Site stats / Analytics. Confirm the site name at the top before recording anything.

DATES: use the date-range picker's CUSTOM range for each window. If Duda only offers presets (7 / 14 / 30 days) and won't take a custom range for a past period, say so plainly, record what range Duda actually showed, and do not shift or estimate numbers.

Make THREE Markdown files, one per snapshot:
- sanctuary-website-2026-10-01.md: 30-day window Sep 1 – Sep 30, 2026; 14-day Sep 17 – 30; 7-day Sep 24 – 30. Prior 14 days for comparison: Sep 3 – 16.
- sanctuary-website-2026-10-15.md: 30-day Sep 15 – Oct 14; 14-day Oct 1 – 14; 7-day Oct 8 – 14. Prior 14 days: Sep 17 – 30.
- sanctuary-website-2026-10-29.md: 30-day Sep 29 – Oct 28; 14-day Oct 15 – 28; 7-day Oct 22 – 28. Prior 14 days: Oct 1 – 14.

For EACH snapshot and EACH of its windows (30d, 14d, 7d, prior 14d), record with the "vs. previous period" % Duda shows:
 - Highlights: User visits (sessions); Unique users / visitors; Page views; Bounce rate; Exit rate (if shown); Average time on site.
 - Leads / conversions: Click-to-call; Form submissions; Click-to-email; Click-to-map; Total tracked lead actions; Conversion rate.
 - Devices: Mobile / Desktop / Tablet split (% and counts).
 - Traffic sources: Direct, Search, Referral, Social, Unknown, AI Assistants (and any other rows), with visits for each.
 - AI crawler / bot activity (if Duda shows it separately): bot visits, change vs. prior, top crawlers. Keep these SEPARATE from human visits.

30-day window only (per snapshot):
 - Top pages: the top 15 pages with Page path, Views, Unique views, Avg time, Bounce %, Exit %.
 - Browsers and Operating systems with session counts.
 - Geolocation: top countries / regions / cities, if available.
 - Weekly visits: the visits per week from the chart. Read the tooltip on each bar; if you can only eyeball the bars, label the values "approximate".
 - Form names and their submission counts, if Duda lists them. NEVER copy form contents, names, emails or phone numbers: counts only. This is a healthcare site.

FILE FORMAT (use exactly this structure in each file):
# Sanctuary — Website (Duda) — Snapshot <YYYY-MM-DD>
- Pulled: <today's date and time> · Site confirmed: www.sanctuaryrecoverycenters.com
- Windows actually shown by Duda: 30d <start – end> · 14d <…> · 7d <…> · prior 14d <…>
## KPIs
| Metric | 30d | vs. prev | 14d | vs. prev | 7d | Prior 14d | Source screen |
## Lead actions
## Traffic sources
| Source | 30d | 14d | 7d |
## Devices
## Top pages (30d)
| Page | Views | Unique | Avg time | Bounce | Exit |
## Browsers / OS / Geography
## Weekly visits
## AI crawlers (separate from visits)
## Gaps and caveats
List NOT AVAILABLE items, any window that didn't match, approximate values, and data-quality flags (for example a page with an implausibly long average time, which suggests idle tabs).

Save each file as a download if you can. If you can't save files, output each one as its own fenced ```markdown block headed by its filename. Finish with a checklist of which sections are complete for each file.
```

---

## 3. LinkedIn Page analytics

```text
You are collecting verified analytics for an internal performance report. Accuracy matters more than speed: every number must be read from the screen or from an export. Never estimate, round, interpolate or fill a gap. If a number is not available, write "NOT AVAILABLE" and say why.

PAGE: the Sanctuary Recovery Centers LinkedIn Company Page. Open it in admin view (linkedin.com/company/<id>/admin/analytics/). Confirm the page name and record the numeric company ID from the URL.

WHERE: Analytics → Content, Followers, Visitors, Search appearances, Competitors. Use the custom date range for each window. LinkedIn data lags about two days, which is why these windows end one day before the Meta ones. Where possible, use the Export button (XLS) and read the daily rows from it, and say so.

Make THREE Markdown files, one per snapshot:
- sanctuary-linkedin-2026-10-01.md: 30-day window Aug 31 – Sep 29, 2026. Two-week cuts: Sep 16 – 29 and Sep 2 – 15.
- sanctuary-linkedin-2026-10-15.md: 30-day Sep 14 – Oct 13. Two-week cuts: Sep 30 – Oct 13 and Sep 16 – 29.
- sanctuary-linkedin-2026-10-29.md: 30-day Sep 28 – Oct 27. Two-week cuts: Oct 14 – 27 and Sep 30 – Oct 13.

For EACH snapshot, collect (with the "vs. prior period" % LinkedIn shows):
 - CONTENT (organic, 30d): Impressions; Unique impressions / members reached; Clicks; Click-through rate; Reactions; Comments; Reposts; Engagement rate; Posts published.
 - DAILY Impressions, Clicks and Reactions for every day of the 30-day window (from the Content export).
 - Every post in the window: posted date, first ~8 words, Impressions, Clicks, CTR, Likes / reactions, Comments, Reposts, Engagement rate.
 - FOLLOWERS: New followers in the window; total Page followers (as of the window end if possible, otherwise today's total and say so); daily new followers from the export.
 - Follower demographics (lifetime, top 5 each with counts): Location, Job function, Industry, Seniority, Company size.
 - VISITORS (30d): Page views; Unique visitors; split by desktop / mobile if shown; visitor demographics if shown.
 - SEARCH APPEARANCES: the count, plus the top companies searching the page and the top search keywords LinkedIn lists.
 - COMPETITORS ("Compare growth"): each company with total followers, new followers, total post engagements and number of posts for the window LinkedIn uses (state that window).
 - TWO-WEEK CUTS: for each of the two 14-day ranges, Impressions, Clicks, Reactions, Comments, Reposts and New followers. Set the date picker to each range; don't derive them from the 30-day totals.

FILE FORMAT (use exactly this structure in each file):
# Sanctuary — LinkedIn — Snapshot <YYYY-MM-DD>
- Pulled: <today's date and time> · Page confirmed: <name> · Company ID: <id>
- 30-day window shown: <start – end> · Comparison window LinkedIn used: <…>
## KPIs
| Metric | Value | vs. prior | Window | Source (screen / export) |
## Content — daily
| Date | Impressions | Clicks | Reactions | New followers |
## Posts in window
## Followers & demographics
## Visitors
## Search appearances
## Competitors
## Two-week cuts
| Metric | <last 14d> | <prior 14d> |
## Gaps and caveats
List NOT AVAILABLE items, any window that didn't match, and anything LinkedIn labels as estimated or delayed.

Save each file as a download if you can. If you can't save files, output each one as its own fenced ```markdown block headed by its filename. Finish with a checklist of which sections are complete for each file.
```
