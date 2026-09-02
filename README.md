# FxTwitter + Invidious + Instagram + RedditMedia Telegram Bot

A small Telegram bot deployed as a Cloudflare Worker.

- Twitter/X status links -> `fxtwitter.com/i/status/<id>`
- Instagram links -> `oginstagram.com`
- Reddit links -> `rxddit.com` media previews
- YouTube links -> configured Invidious instance
- Deletes the original Telegram message after a successful replacement
- Uses Telegram webhooks instead of a continuously running polling process

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

## Frontend configuration

Defaults are configured in `wrangler.jsonc`:

```text
INVIDIOUS_BASE_URL=https://y.com.sb
INSTAGRAM_BASE_URL=https://oginstagram.com
REDDIT_MEDIA_BASE_URL=https://rxddit.com
```

Change any of those instance URLs without changing the rewrite logic.

## Behavior

Twitter/X, Instagram, Reddit, and YouTube links are handled automatically.
