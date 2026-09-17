# "Ask the data" chat — how to switch it on

A floating **Ask the data** button sits on every page. It opens a popover that
answers questions from this site's own figures — every snapshot, channel,
two-week cut, and the SharePoint pull when one exists.

It is **off until you set three environment variables in Vercel.** Until then
the panel opens and says exactly what is missing. It fails closed on purpose.

---

## Switch it on

Vercel → your project → **Settings → Environment Variables**. Add these to
**Production** (and Preview if you want it on previews too), then redeploy.

| Variable | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Your key from [console.anthropic.com](https://console.anthropic.com). Server-side only — it never reaches the browser. |
| `CHAT_PASSCODE` | yes* | A shared word your team types once per browser tab. |
| `CHAT_EFFORT` | no | `low` (default), `medium`, or `high`. Raise it if answers feel shallow. |

\* Required **unless** you set `CHAT_ALLOW_PUBLIC=true`. See Why a passcode below.

Then redeploy (any push, or Vercel → Deployments → Redeploy). Environment
variables are read at request time, but the function only exists on
deployments built after this code landed.

---

## Why a passcode

The production site currently answers on the open internet with no login. An
AI endpoint on an unauthenticated page is an open tab on your API bill: anyone
who finds the URL can ask it questions at your expense.

So the endpoint refuses to run without either a passcode or an explicit
`CHAT_ALLOW_PUBLIC=true`. The better fix is to turn on Vercel Deployment
Protection for Production — then the whole site is behind auth and the
passcode is belt-and-braces.

---

## What it costs

Every question sends the whole dataset as context — currently about
**39,000 input tokens**. At Claude Opus 5 pricing ($5 per million input,
$25 per million output) that is roughly:

- **~$0.21 per question** when the cache is cold
- Much less for follow-ups within ~5 minutes — the dataset is cached, and
  cache reads are a fraction of the input price

So a 20-question session spread through a day lands around **$3–4**. Ten
sessions a month is roughly the price of a sandwich. It is not free, and it
scales with use.

**If you want it cheaper**, change `MODEL` at the top of `api/ask.js`:

| Model | Model ID | Input $/M | ≈ per cold question |
|---|---|---|---|
| Claude Opus 5 (current) | `claude-opus-5` | $5.00 | ~$0.21 |
| Claude Sonnet 5 | `claude-sonnet-5` | $2.00 | ~$0.09 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1.00 | ~$0.05 |

Opus 5 is the default because this is analytical work over careful,
caveat-heavy data where a wrong read is worse than a slow one. Dropping a tier
is a real option — it is your call, not a decision the code should make for you.

---

## What it can and cannot do

**Can:** read every figure on the site, compare periods, explain a movement,
point at the caveat attached to a number, say which source window a figure
came from.

**Cannot:** change anything. It is read-only — no writes to the site, no data
pulls, no actions in any tenant. It has no web access and no other data source.

It is instructed to refuse to guess: if a figure is not in the data it says so
rather than estimating, and it always states the source window with a number,
because this dataset deliberately runs different windows per channel.

---

## Where the data comes from

`api/ask.js` reads `data.js` (in a sandboxed VM — it is plain `var`
declarations) and `sharepoint-usage.json` if it exists, on each cold start.
The base64 logo is stripped before anything is sent.

That means **one copy of the data**: the chat can never drift out of sync with
what the pages render. Publish a new snapshot and the chat knows about it on
the next deployment, with no separate step.

---

## Privacy

Question text and the site's metrics go to the Anthropic API to be answered.
No PII goes with them — `form.csv` is excluded from this site entirely, and
the payload is aggregate marketing figures plus, where present, SharePoint
site names and usage counts. If you turn on `--include-owners` for the
SharePoint payload, staff email addresses become part of what is sent.

Conversations are not stored anywhere by this site. Closing the panel discards
them; the passcode lives in `sessionStorage` for that tab only.

---

## Troubleshooting

**"Chat is not switched on yet"** — the panel tells you which variable is
missing. Set it and redeploy.

**"The API key on this deployment was rejected"** — the key is wrong, revoked,
or has no credit.

**Button appears but the panel says no endpoint responded** — you are on a
static preview with no serverless functions, or the deployment predates
`api/ask.js`. Redeploy.

**Answers feel shallow** — raise `CHAT_EFFORT` to `medium` or `high`. That
costs more per question.
