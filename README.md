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

Store the Telegram bot token as a Worker secret:

```bash
npx wrangler secret put TELEGRAM_TOKEN
```

Create a webhook secret. Use only letters, numbers, `_`, and `-`:

```bash
openssl rand -hex 32
```

Store that value as another Worker secret:

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Deploy:

```bash
npm run deploy
```

Wrangler will print the Worker URL, for example:

```text
https://fxtwitter-invidious-telegram-bot.<account>.workers.dev
```

Register the Telegram webhook using the same values you stored above:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://YOUR-WORKER.workers.dev/webhook\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\"]}"
```

Check webhook status:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo"
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

## Invidious instance

The default remains `https://y.com.sb`, matching the original bot. Change `INVIDIOUS_BASE_URL` in `wrangler.jsonc` if you want another instance.

## Behavior

Twitter/X links are handled automatically. YouTube links are converted only when the bot is mentioned, preserving the original bot behavior.
