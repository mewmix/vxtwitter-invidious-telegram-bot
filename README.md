# FxTwitter + Invidious Telegram Bot

A small Telegram bot deployed as a Cloudflare Worker.

- `twitter.com/<user>/status/<id>` -> `fxtwitter.com/<user>/status/<id>`
- `x.com/<user>/status/<id>` -> `fxtwitter.com/<user>/status/<id>`
- YouTube links -> Invidious when the bot is mentioned
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

Put the bot token in a local file (gitignored) and store it as a Worker secret:

```bash
echo -n "YOUR_BOT_TOKEN" > telegram-token
npx wrangler secret put TELEGRAM_TOKEN < telegram-token
```

Create a webhook secret (letters/numbers only from `openssl rand -hex`) and store it as another Worker secret, keeping the file for webhook registration:

```bash
openssl rand -hex 32 > telegram-webhook-secret
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET < telegram-webhook-secret
```

Deploy:

```bash
npm run deploy
```

Wrangler will print the Worker URL, for example:

```text
https://fxtwitter-invidious-telegram-bot.<account>.workers.dev
```

Register the Telegram webhook against that URL (idempotent, safe to re-run after a URL change):

```bash
npm run set-webhook -- https://YOUR-WORKER.workers.dev
```

The script reads `telegram-token` and `telegram-webhook-secret`, calls `setWebhook` with `allowed_updates: ["message"]`, and prints `getWebhookInfo` for confirmation.

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

## Invidious instance

The default remains `https://y.com.sb`, matching the original bot. Change `INVIDIOUS_BASE_URL` in `wrangler.jsonc` if you want another instance.

## Behavior

Twitter/X links are handled automatically. YouTube links are converted only when the bot is mentioned, preserving the original bot behavior.
