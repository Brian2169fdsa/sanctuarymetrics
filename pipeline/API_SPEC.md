# API call specs

Every call the Make scenario makes, the exact metric names, and which report
KPI card each one feeds. Metric names were checked against Meta's and
LinkedIn's current docs on 2026-10-01. Meta retired `page_impressions*`,
`page_fans` and IG `impressions` in 2025, so older tutorials are wrong.

Known IDs are pre-filled. `SET_ME_*` marks a value that intake hasn't
confirmed yet. Tokens are never in this file: Meta and LinkedIn tokens live
in Make's keychain, and Google auth is a Make connection.

Window convention: **28 days ending yesterday**, in America/Phoenix time,
run every Thursday. That matches the report's Meta windows (for example,
Sep 17 snapshot = Aug 20 – Sep 16). The website also gets the 14-day cut the
report uses.

---

## 1. Facebook Page (Graph API, HTTP module)

Base: `https://graph.facebook.com/v25.0`. Bump the version in module 1 of the
scenario, not in each URL.
Auth: Page access token, via Make keychain *HTTP → API key*, sent as query
parameter `access_token`.
Permissions: `pages_show_list`, `pages_read_engagement`, `read_insights`.

### 1a. Identity + scope guard

```
GET /100063738294812?fields=id,name,followers_count,instagram_business_account{id,username}
```

The scenario's filter only lets the run continue if `id` is
`100063738294812` **and** `instagram_business_account.id` equals the
configured IG ID. If someone swaps in a token for a different Page (for
example Cholla's), nothing is written. The weekly freshness check then fails
loudly.

### 1b. Page insights, 28-day values

```
GET /100063738294812/insights
    ?metric=page_media_view,page_total_media_view_unique,page_post_engagements,
            page_daily_follows_unique,page_daily_unfollows_unique,
            page_total_actions,page_views_total
    &period=days_28
    &since={window_end}&until={run_date}
```

Each metric returns `values[]` keyed by `end_time`. The scenario takes the
last value, which is the 28 days ending `window_end`.

| Graph metric | Sheet `metric` | Report card |
|---|---|---|
| `page_media_view` | `views` | Facebook **Views**; Summary "Facebook views"; reach chart |
| `page_total_media_view_unique` | `unique_viewers` | note under Views ("3,555 unique viewers") |
| `page_post_engagements` | `interactions` | Facebook **Interactions**; rollup Engagement |
| `page_daily_follows_unique` − `page_daily_unfollows_unique` | `follows`, `unfollows` → derived `net_follows` | **Net new follows** |
| `page_total_actions` | `cta_clicks` | rollup "clicks" (contact info + CTA button clicks, not post link clicks; see gaps) |
| `page_views_total` | `page_profile_views` | supporting table |
| field `followers_count` | `followers_total` (lifetime) | **Lifetime followers** |

Change vs. prior 28 days (the ▲/▼ chips) is computed by
`tools/build-metrics-json.py` from the run four weeks earlier. Weekly runs
make that window exact, so the API isn't asked for it.

## 2. Instagram (Graph API, same token)

IG user ID: `SET_ME_IG_BUSINESS_ACCOUNT_ID`. Resolve it from 1a's
`instagram_business_account.id`. The `131544476868638` seen in exports is
probably not it (IG user IDs normally start `1784…`).
Permissions: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`.

### 2a. Account

```
GET /{ig_user_id}?fields=id,username,followers_count,media_count
```

→ `followers_total` (**Followers** card).

### 2b. Account insights

```
GET /{ig_user_id}/insights
    ?metric=views,reach,accounts_engaged,total_interactions,profile_links_taps
    &metric_type=total_value&period=day
    &since={unix midnight PT, window_start}&until={unix midnight PT, run_date}
```

Meta caps the range at 30 days, so 28 days fits. Each item returns `total_value.value`.

| IG metric | Sheet `metric` | Report card |
|---|---|---|
| `views` | `views` | Instagram **Views**; Summary; reach chart |
| `reach` | `reach` | **Reach (unique)**. Meta labels it an estimate. |
| `total_interactions` | `interactions` | rollup Engagement |
| `accounts_engaged` | `accounts_engaged` | supporting |
| `profile_links_taps` | `profile_link_taps` | rollup "clicks" |

`profile_views` and `website_clicks` are no longer valid user metrics.

### 2c. Posts published in window

```
GET /{ig_user_id}/media?fields=id,timestamp,media_type&since=…&until=…&limit=100
```

→ `posts_published` = number of items returned (**Posts published** card).

## 3. Website: GA4 Data API (Make's Google Analytics 4 app, "Make an API Call")

Property: `SET_ME_GA4_PROPERTY_ID` (numeric, not the `G-` ID).
One call, five reports:

```
POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:batchRunReports
```

| # | dateRange | dimensions | metrics | Feeds |
|---|---|---|---|---|
| 1 | 28d | – | `sessions, totalUsers, screenPageViews, engagementRate, averageSessionDuration, keyEvents` | Website **Visits** (sessions), **Page views**, rollup engagement, **Lead actions** (keyEvents) |
| 2 | 14d | – | same | the 14-day website cut |
| 3 | 28d | `sessionDefaultChannelGroup` | `sessions, keyEvents` | **Traffic sources** table |
| 4 | 28d | `pagePath` (top 10 by views) | `screenPageViews, bounceRate` | **Top pages** table |
| 5 | 28d | `eventName` (keyEvents > 0) | `keyEvents` | **Click-to-call** and **Form submissions** cards, once those are set up as key events (see `GA4_SETUP.md`) |

GA4 renamed "conversions" to **key events** in 2024; `keyEvents` is the
current metric name.

`pagePath` excludes query strings on purpose (PHI guardrail). Never switch
it to `pagePathPlusQueryString`.

To swap in the custom channel group (see `GA4_SETUP.md`), first look up its
exact dimension name. It is property-specific, so take it from:

```
GET https://analyticsdata.googleapis.com/v1beta/properties/{id}/metadata
```

Look for the `apiName` that starts with `sessionCustomChannelGroup:`, and
replace `sessionDefaultChannelGroup` in report 3 with it.

## 4. LinkedIn Page: gated, manual until approved

Organization: `urn:li:organization:SET_ME_LINKEDIN_ORG_ID`
Auth: 3-legged OAuth token of a Page **admin**, through an app with the
**Community Management API** product approved.
Scopes: `rw_organization_admin` (required for these stats) and `r_organization_social`.
Headers on every call: `LinkedIn-Version: 202609`, `X-Restli-Protocol-Version: 2.0.0`.
LinkedIn sunsets each version after about a year, so bump this yearly.

```
# impressions, clicks, likes, comments, shares, engagement (organic only)
GET https://api.linkedin.com/rest/organizationalEntityShareStatistics
    ?q=organizationalEntity
    &organizationalEntity=urn%3Ali%3Aorganization%3A{id}
    &timeIntervals=(timeRange:(start:{ms},end:{ms}),timeGranularityType:DAY)

# follower gains over the window
GET https://api.linkedin.com/rest/organizationalEntityFollowerStatistics
    ?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A{id}
    &timeIntervals=(timeRange:(start:{ms},end:{ms}),timeGranularityType:DAY)

# total followers
GET https://api.linkedin.com/rest/networkSizes/urn%3Ali%3Aorganization%3A{id}?edgeType=COMPANY_FOLLOWED_BY_MEMBER

# page views / unique visitors
GET https://api.linkedin.com/rest/organizationPageStatistics
    ?q=organization&organization=urn%3Ali%3Aorganization%3A{id}
    &timeIntervals=(timeRange:(start:{ms},end:{ms}),timeGranularityType:DAY)
```

Share stats only cover the last 12 months, rolling.

Until approval, the scenario writes LinkedIn rows with a blank value and
`status = pending_verified_export`. A person pastes the number from the
LinkedIn Page analytics export into `value` and sets status to
`manual_verified`. The build refuses a value that is still marked pending,
so a number never slips in unverified.

| Sheet `metric` | Report card |
|---|---|
| `impressions` | LinkedIn **Impressions**; Summary; reach chart |
| `clicks` | **Post clicks** |
| `engagement_rate` | **Avg engagement rate** |
| `new_followers` | **New followers** |
| `followers_total` | rollup Followers |
