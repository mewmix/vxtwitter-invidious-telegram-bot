# Verifiable Telegram dice on Cloudflare Workers

This branch turns the existing FxTwitter/Invidious Worker into a separate dice bot. It responds to commands and ignores link traffic. Use a new BotFather token and a separate Worker name so the existing link bot can keep running.

Commands:

- `/roll` — one six-sided die.
- `/roll d20`.
- `/roll 2d6+3`.
- `/roll@YourDiceBot 3d10-2` — explicit addressing in groups.
- `/dice` is an alias; `/help` explains the proof.

Up to 100 dice, 2–1,000,000 sides, and modifiers from −100,000 to +100,000. No arbitrary expression evaluation. Group topics are preserved. Keep Telegram group privacy enabled; this bot only needs command messages and permission to send replies, without administrator or delete permissions.

## What the proof establishes

Randomness comes from **drand quicknet**, a distributed threshold BLS beacon. It is cryptographically verifiable randomness under the network's threshold and cryptographic assumptions. It is **not a physical TRNG or a measurement/proof of physical entropy**. A signature authenticates the beacon output; it cannot prove that every participant's physical entropy source was sound.

For each roll:

1. Hash the Telegram chat ID and original message ID into a stable request ID. Retries of that original message address the same Durable Object.
2. Fix the quicknet round to the first scheduled round at or after the original Telegram message timestamp plus 60 seconds. No operator-selected seed, latest-round lookup, or round change on retry.
3. Publish the expression, request ID, requested timestamp, round, and SHA-256 commitment in the group **at least five seconds before** the scheduled beacon. Require Telegram's send acknowledgement before that deadline. A late request or acknowledgement produces no roll.
4. Fetch that exact round from a relay, verify the G1 BLS signature against the pinned quicknet G2 public key, and check that randomness is SHA-256(signature).
5. Expand SHA-256 with the receipt commitment, beacon randomness, and a counter. Read big-endian 32-bit words and use rejection sampling to obtain unbiased dice.
6. Persist the proof before sending a separate result message. Preserve the commitment message for timing verification.

Results normally arrive roughly one minute after the command. Retries survive Worker restarts through Durable Object alarms. Relay failures never change the committed round. An ambiguous Telegram send may cause duplicate messages; every duplicate refers to the same receipt/result.

The bot/operator can still refuse requests, suppress delivery, delete its own messages, or change deployed code. A valid proof establishes a particular result, not availability or the absence of selective aborts. Visible commitments make unfinished rolls observable. Preserve/download commitments and proofs if auditing matters. There is no independently signed Telegram timestamp in the proof: verify timing against the actual original group message. A verifier given only operator-controlled JSON cannot establish when that JSON was published.

References:

- [drand cryptography](https://docs.drand.love/docs/cryptography/)
- [quicknet and its three-second period](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/)
- [drand's RFC9380 verification implementation](https://github.com/drand/drand-client/blob/master/lib/beacon-verification.ts)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Telegram webhook authentication](https://core.telegram.org/bots/api#setwebhook)

## Deploy

Use Node.js **22.7 or newer**. Tests use Node's TypeScript transform support. Deployment does not require GitHub Actions.

```bash
git switch agent/verifiable-dice-worker
npm ci
npm run check
npm run build:check
npx wrangler login
```

In `wrangler.jsonc`, set:

- `BOT_USERNAME` to the **new** bot username without `@`.
- `PUBLIC_BASE_URL` to the deployed dice Worker's HTTPS origin.
- Optionally `ALLOWED_CHAT_IDS` to a comma-separated list of allowed Telegram chat IDs.

The new Worker name is `verifiable-telegram-dice`. Both Durable Object classes use SQLite-backed storage. The migration and bindings are included. Check your Cloudflare plan's current Durable Objects limits and CPU allowance; pure JavaScript BLS verification must be exercised in the actual Worker before relying on deployment. Increase the Worker CPU allowance if your plan requires it.

Store the **new bot's** token and webhook secret:

```bash
npx wrangler secret put TELEGRAM_TOKEN
openssl rand -hex 32 > telegram-webhook-secret
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET < telegram-webhook-secret
npm run deploy
```

Store the new bot token in the gitignored `telegram-token` file or provide `TELEGRAM_TOKEN` through your local environment. Register its webhook:

```bash
npm run set-webhook -- https://YOUR-DICE-WORKER.workers.dev
```

Add that bot to the group, send `/roll@YourDiceBot 2d6+3`, and check both the commitment and result. Do not register the existing link bot's token against the new Worker: Telegram allows one webhook per bot.

For local development, use a gitignored `.dev.vars` containing the secrets and local configuration, then `npm run dev`. A public HTTPS endpoint is needed for Telegram webhook testing.

## Verify independently

The group reply includes a `/proof/<64-hex-request-id>` URL. Download its JSON while it is retained, or give the URL to the verifier:

```bash
npm run verify -- https://YOUR-DICE-WORKER.workers.dev/proof/REQUEST_ID \
  --commitment COMMITMENT_FROM_GROUP_MESSAGE \
  --expression 2d6+3 \
  --requested-at ORIGINAL_COMMAND_UNIX_TIMESTAMP \
  --announced-at COMMITMENT_MESSAGE_UNIX_TIMESTAMP \
  --chat-id ORIGINAL_CHAT_ID \
  --message-id ORIGINAL_COMMAND_MESSAGE_ID
```

For downloaded JSON, replace the URL with its local filename. Copy expected values from the Telegram messages, not from the bot's proof JSON. Exact timestamps and message IDs can be obtained from a Telegram export/API client. Chat/message IDs are optional for the verifier, but required to check that the opaque request ID belongs to that exact Telegram request. The verifier checks the signature locally and needs no relay connection when given a saved proof.

`validateProof` checks the protocol/chain, canonical receipt, fixed round, announcement deadline, beacon signature, rejection-sampled dice, and total. It exits nonzero on any mismatch.

## Protocol v1

Pinned network:

- Chain: `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`.
- Scheme: `bls-unchained-g1-rfc9380`.
- Genesis: 1692803367 Unix seconds; period: three seconds.
- Group public key is pinned in `src/core.mjs`; relay-supplied keys are never trusted.

Request ID is SHA-256 of UTF-8 compact JSON:

```text
["telegram-dice-request-v1", chat_id, message_id]
```

Commitment is SHA-256 of UTF-8 compact JSON:

```text
["telegram-dice-drand-v1", chain_hash, request_id, requested_at, normalized_expression, round]
```

Dice block at counter 0, 1, ... is SHA-256 of UTF-8 compact JSON:

```text
["telegram-dice-drand-v1", "dice", commitment, randomness_hex, counter]
```

Take eight big-endian uint32 words per block. For sides S, accept only words below floor(2^32/S) × S; each face is word % S + 1. Stop at the requested dice count, sum, then add the modifier. Exhaustion fails closed.

## Storage and limits

One Durable Object per roll holds internal chat/message IDs and the public proof. Public JSON excludes raw chat IDs and user identities, but expressions/timestamps/results can reveal activity. The proof URL is a bearer link and is not private to the group. Anyone who knows original chat/message IDs can recompute it.

Proofs expire after **30 days**. Rate limiting allows 12 distinct commands per chat in a rolling minute. Unrelated traffic is ignored. Alarms use bounded retries; after 12 failures the record reports failure and retains any computed proof. Expired webhook requests are acknowledged and ignored rather than assigned a fresh round.

## Validation status

The implementation includes Node tests for parsing, round boundaries, unbiased sampling, receipt tampering, deadlines, drand's independent RFC9380 fixture, malformed beacons, webhook authentication, duplicate admission, retained proofs, delivery failures, and rate limits.

During authoring, six protocol checks passed in an isolated JavaScript harness using an independent SHA-256 implementation validated against standard vectors. Five state-machine checks passed with mocked HTTP, storage, and time. Module bodies passed syntax parsing.

**Pending before deployment:** the actual Node suite, TypeScript typecheck, Wrangler dry run, a valid production quicknet beacon fixture, and a live Telegram/Cloudflare smoke test including BLS CPU usage. The authoring environment had no shell, installed packages, Cloudflare credentials, or callable Telegram connection. Harness checks do not replace these integration checks.
