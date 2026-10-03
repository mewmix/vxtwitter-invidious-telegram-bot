# Verifiable Telegram dice + weighted wheels on Cloudflare Workers

This branch is a standalone Telegram tabletop-game bot. It keeps the original future-drand proof mode, while normal `/roll` and weighted-wheel spins return quickly. Compact results are the default; `/verbose on` adds proof and commitment details.

## Chat commands

Dice:

```text
/roll
/dice
/roll 2d6+3
/rollproof            # older ~60s future-drand protocol
/verbose on          # show proof details in fast results
/verbose off         # show only the result (default)
```

`/roll`, `/dice`, and `/rollproof` roll a d20 when no expression is supplied.

Weighted wheels:

```text
/wheel create Otters Luck | Lucky:20 | Unlucky:80
/wheel spin Otters Luck
/wheel show Otters Luck
/wheel list
/wheel set Otters Luck | Lucky:35 | Unlucky:65
/wheel delete Otters Luck
```

`create`, `set`/`difficulty`, `delete`, verbosity changes, and entropy resets are restricted to Telegram group administrators. In a private chat the user can change these settings.

The parser also understands `Wheelbot spin Otters Luck wheel` and `<BOT_USERNAME> spin Otters Luck wheel` when Telegram actually delivers that plain-text message to the bot. Slash commands remain the reliable group interface when BotFather privacy mode is enabled.

Wheel weights are relative integers, not required to sum to 100. `20/80`, `2/8`, and `200/800` describe the same distribution. Each saved change increments the wheel version and changes its configuration hash. Every spin proof contains the exact wheel snapshot used for that spin.

## Fast protocol

Fast gameplay uses two independent ingredients when available:

1. A 256-bit secret from Cloudflare Workers `crypto.getRandomValues()`. In verbose mode, its SHA-256 commitment is published in the chat before a later request can use it.
2. The first quickly reachable **locally verified** latest drand quicknet beacon. The three configured relays are queried in parallel with a 1.2-second deadline. If none responds and verifies in time, the roll continues from the precommitted Worker secret alone and the proof explicitly records `beacon: null`.

The publicly verifiable chain in verbose mode works like this:

```text
Telegram publishes commitment N
            |
player sends /roll or /wheel spin
            |
Worker reveals secret N in proof
            + verified recent drand when reachable quickly
            + Telegram request ID
            + exact dice/wheel configuration
            |
       unbiased result
            |
Telegram result publishes commitment N+1
```

A `GameState` Durable Object serializes the chain per chat. It will not allocate the next secret until Telegram has acknowledged the preceding result. A concurrent roll waits and retries against the same state instead of skipping to another secret. A webhook retry for the same original message addresses the same `DiceRoll` Durable Object and therefore does not redraw.

Compact results show only the outcome and do not publish the next commitment. Their stored proofs mark an unpublished commitment as `precommittedBeforeRequest: false`. After `/verbose on`, the bot publishes the current commitment before the next proof-bearing result. Run `/start` before play in verbose mode if you want the first real roll to be precommitted too.

Verbose fast results include:

- sequence number;
- whether its commitment predates the request;
- verified drand round, or an explicit drand-timeout fallback;
- the **next** 64-hex commitment;
- `/proof/<request-id>`.

The revealed 256-bit secret is in the proof JSON rather than cluttering the chat message. An independent verifier checks that it hashes to the previously published commitment, verifies drand when present, re-derives the seed, performs rejection sampling, and reproduces the dice/wheel outcome.

When a commitment was published before the request, this proves consistency with that Worker commitment. Compact rolls do not make that timing claim. The proof does **not** attest that Cloudflare's underlying CSPRNG is a physical TRNG, nor can it prove that the bot operator never suppresses a result. `/entropy reset` is intentionally noisy and publishes a new chain root instead of silently skipping a stuck value.

## Entropy-chain administration

```text
/start
/entropy status
/entropy reset
```

`/start` initializes the per-chat chain and publishes its first commitment. `/entropy reset` is admin-only in groups and should be used only for recovery; it explicitly posts that the chain was reset.

## Delayed future-drand mode

`/rollproof` preserves protocol v1 from the earlier branch. It fixes a drand round from the original Telegram timestamp, publishes the commitment before that future round, verifies the BLS signature after publication, and then produces the roll. This remains the stronger timing protocol when waiting roughly a minute is acceptable.

## Deploy

Use Node.js 22.7 or newer:

```bash
git switch agent/verifiable-dice-worker
npm ci
npm run check
npm run build:check
npx wrangler login
```

`wrangler.jsonc` targets the `telegramtoken3` Worker and `@realityrulebot`. Add the bot's secrets from the local, gitignored files:

```bash
npx wrangler secret put TELEGRAM_TOKEN < telegram-token3
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET < telegram-webhook-secret3
npm run deploy
TELEGRAM_TOKEN_FILE=telegram-token3 TELEGRAM_WEBHOOK_SECRET_FILE=telegram-webhook-secret3 \
  npm run set-webhook -- https://telegramtoken3.alexanderjamesklein.workers.dev
```

`ROLLS`, `CHAT_GATE`, and `GAME` are SQLite-backed Durable Objects. The `v2-fast-game` migration adds `GameState` without discarding the original v1 roll objects.

## Independent verification

For a fast proof:

```bash
npm run verify -- proof.json \
  --commitment COMMITMENT_COPIED_FROM_THE_PREVIOUS_CHAT_MESSAGE \
  --chat-id ORIGINAL_CHAT_ID \
  --message-id ORIGINAL_MESSAGE_ID
```

The commitment argument matters: validating only operator-hosted JSON proves internal consistency, not that the secret was committed before the request. The verifier also accepts a proof URL.

For `/rollproof`, the previous v1 arguments still apply:

```bash
npm run verify -- proof.json \
  --commitment COMMITMENT_FROM_GROUP_MESSAGE \
  --expression 2d6+3 \
  --requested-at ORIGINAL_COMMAND_UNIX_TIMESTAMP \
  --announced-at COMMITMENT_MESSAGE_UNIX_TIMESTAMP \
  --chat-id ORIGINAL_CHAT_ID \
  --message-id ORIGINAL_MESSAGE_ID
```

## Limits and storage

- Dice: 1–100 dice, 2–1,000,000 sides, modifier ±100,000.
- Wheels: 2–32 unique outcomes, each weight 1–1,000,000, total weight ≤10,000,000.
- Rate limit: 30 distinct bot commands per chat per rolling minute.
- Proof/state retention for per-roll objects: 30 days.
- Public proof JSON excludes raw chat IDs and user identities.

## Validation status

Authoring checks completed for the new fast core:

- `node --check` on `core.mjs`, `beacon.mjs`, and `verify-roll.mjs`;
- Node TypeScript syntax transform check on `src/index.ts`;
- strict TypeScript `--noEmit` check against the repository tsconfig shape;
- eight pure protocol tests, including 20/80 wheel parsing, wheel-version hashing, fast committed-secret verification, tamper rejection, legacy dice sampling, and future-drand receipt behavior.

Still required before relying on a production deployment: run the repository's complete `npm ci && npm run check && npm run build:check`, then smoke-test the actual Telegram webhook, Durable Object migration, group-admin lookup, drand latency/fallback behavior, and Cloudflare CPU usage in the deployed Worker.
