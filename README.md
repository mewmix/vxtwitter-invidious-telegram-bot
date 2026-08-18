# Social Frontend Telegram Bot

A small Telegram bot deployed as a Cloudflare Worker that rewrites supported links to privacy-friendly or embed-friendly frontends, then deletes the original Telegram message after a successful replacement.

## Enabled by default

- Twitter/X status links -> FxTwitter
- Instagram links -> OGInstagram
- Reddit links -> Redlib
- YouTube links -> Invidious when the bot is mentioned

The default Worker configuration is:

```text
INVIDIOUS_BASE_URL=https://y.com.sb
INSTAGRAM_BASE_URL=https://oginstagram.com
REDLIB_BASE_URL=https://redlib.privacyredirect.com
```

## Optional frontends

Additional LibRedirect-inspired rewrites are implemented but remain disabled until a base URL is configured. This avoids silently depending on a random public instance.

```text
PROXITOK_BASE_URL=      # TikTok -> ProxiTok
SAFETWITCH_BASE_URL=    # Twitch -> SafeTwitch
RIMGO_BASE_URL=         # Imgur -> rimgo
SCRIBE_BASE_URL=        # Medium -> Scribe-compatible frontend
QUETRE_BASE_URL=        # Quora -> Quetre
BREEZEWIKI_BASE_URL=    # Fandom/Wikia -> BreezeWiki
SKYVIEW_BASE_URL=       # Bluesky -> Skyview
SHOELACE_BASE_URL=      # Threads -> Shoelace-compatible frontend
PRIVIBLUR_BASE_URL=     # Tumblr -> Priviblur
```

Set any of these in `wrangler.jsonc` under `vars` to enable that service.

## Reddit handling

Redlib rewriting handles normal Reddit URLs plus the common short/media forms:

```text
reddit.com/...                  -> REDLIB/...
old.reddit.com/...              -> REDLIB/...
new.reddit.com/...              -> REDLIB/...
np.reddit.com/...               -> REDLIB/...
amp.reddit.com/...              -> REDLIB/...
redd.it/<id>                    -> REDLIB/comments/<id>
i.redd.it/...                   -> REDLIB/img/...
preview.redd.it/...             -> REDLIB/preview/pre...
external-preview.redd.it/...    -> REDLIB/preview/external-pre...
```

## Telegram setup

Create a bot with [BotFather](https://t.me/BotFather). For group use:

1. Disable Group Privacy for the bot.
2. Add the bot to the group.
3. Give it permission to delete messages if you want original links removed.

## Deploy to Cloudflare Workers

Install dependencies:

```bash
npm install
```

Authenticate Wrangler:

```bash
npx wrangler login
```

Store the bot token as a Worker secret:

```bash
echo -n "YOUR_BOT_TOKEN" > telegram-token
npx wrangler secret put TELEGRAM_TOKEN < telegram-token
```

Create and store the webhook secret:

```bash
openssl rand -hex 32 > telegram-webhook-secret
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET < telegram-webhook-secret
```

Deploy:

```bash
npm run deploy
```

Register the Telegram webhook:

```bash
npm run set-webhook -- https://YOUR-WORKER.workers.dev
```

Health check:

```bash
curl "https://YOUR-WORKER.workers.dev/health"
```

## Local development

Create `.dev.vars`:

```text
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_WEBHOOK_SECRET=local-test-secret
```

Then run:

```bash
npm run dev
```

## Architecture

The Telegram webhook/send/delete behavior lives in `src/index.ts`. URL detection and frontend-specific transformations live in `src/rewrites.ts` as a registry of rewrite rules. This keeps new platforms isolated from the webhook plumbing and makes frontend instance changes configuration-only.

YouTube preserves the original bot behavior: a YouTube link is converted only when the bot is mentioned. Other enabled services are handled automatically.
