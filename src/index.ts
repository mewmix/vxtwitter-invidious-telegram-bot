interface Env {
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INVIDIOUS_BASE_URL?: string;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramBotInfo {
  username?: string;
}

let cachedBotUsername: string | undefined;

const URL_RE = /https?:\/\/[^\s<>()]+/gi;
const TWITTER_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.x.com",
]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

function candidateUrls(text: string): URL[] {
  const matches = text.match(URL_RE) ?? [];
  const urls: URL[] = [];

  for (const match of matches) {
    const candidate = match.replace(/[),.!?]+$/g, "");
    try {
      urls.push(new URL(candidate));
    } catch {
      // Ignore malformed URLs and continue scanning the message.
    }
  }

  return urls;
}

function fxTwitterUrl(text: string): string | null {
  for (const url of candidateUrls(text)) {
    if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) continue;

    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match) continue;

    const [, username, statusId] = match;
    return `https://fxtwitter.com/${username}/status/${statusId}`;
  }

  return null;
}

function youtubeVideoId(text: string): string | null {
  for (const url of candidateUrls(text)) {
    const host = url.hostname.toLowerCase();

    if (host === "youtu.be" || host === "www.youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id) return id;
      continue;
    }

    if (!YOUTUBE_HOSTS.has(host)) continue;

    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      if (id) return id;
    }

    const pathMatch = url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/i);
    if (pathMatch) return pathMatch[1];
  }

  return null;
}

function senderLabel(user?: TelegramUser): string {
  if (user?.username) return `@${user.username}`;
  if (user?.first_name) return user.first_name;
  return "there";
}

function telegramApiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramCall<T>(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(telegramApiUrl(env.TELEGRAM_TOKEN, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(
      `Telegram ${method} failed: ${payload.description ?? response.statusText}`,
    );
  }

  return payload.result as T;
}

async function getBotUsername(env: Env): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;

  const bot = await telegramCall<TelegramBotInfo>(env, "getMe", {});
  if (!bot.username) return null;

  cachedBotUsername = bot.username;
  return cachedBotUsername;
}

async function isBotMentioned(text: string, env: Env): Promise<boolean> {
  const username = await getBotUsername(env);
  if (!username) return false;

  return text.toLowerCase().includes(`@${username.toLowerCase()}`);
}

async function sendReplacementAndDelete(
  message: TelegramMessage,
  replacementText: string,
  env: Env,
): Promise<void> {
  await telegramCall(env, "sendMessage", {
    chat_id: message.chat.id,
    text: replacementText,
  });

  try {
    await telegramCall(env, "deleteMessage", {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
  } catch (error) {
    console.error("Replacement sent but original message could not be deleted", error);
  }
}

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  if (!message) return;

  const text = message.text ?? message.caption;
  if (!text) return;

  const videoId = youtubeVideoId(text);
  if (videoId && (await isBotMentioned(text, env))) {
    const baseUrl = (env.INVIDIOUS_BASE_URL ?? "https://y.com.sb").replace(/\/$/, "");
    const invidiousUrl = `${baseUrl}/watch?v=${encodeURIComponent(videoId)}`;
    await sendReplacementAndDelete(
      message,
      `Here is an invidious url for ${senderLabel(message.from)}: ${invidiousUrl}`,
      env,
    );
    return;
  }

  const fxUrl = fxTwitterUrl(text);
  if (!fxUrl) return;

  await sendReplacementAndDelete(
    message,
    `Hi ${senderLabel(message.from)}, your Twitter/X link is ${fxUrl}.`,
    env,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const suppliedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token",
    );
    if (!env.TELEGRAM_WEBHOOK_SECRET || suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    try {
      await handleUpdate(update, env);
      return Response.json({ ok: true });
    } catch (error) {
      console.error("Failed to process Telegram update", error);
      return Response.json({ ok: false }, { status: 500 });
    }
  },
};
