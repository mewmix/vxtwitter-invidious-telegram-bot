import { candidateUrls, type TelegramEntity } from "./urls";
import { richMessageContent, type TelegramRichMessage } from "./rich-message";
import { combineContent, isLinkOnly, rewriteContent, splitContent, type MessageContent } from "./replacement";

interface Env {
  TELEGRAM_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INVIDIOUS_BASE_URL?: string;
  INSTAGRAM_BASE_URL?: string;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  is_bot?: boolean;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  sender_chat?: { id: number; title?: string; username?: string };
  from?: TelegramUser;
  text?: string;
  entities?: TelegramEntity[];
  caption?: string;
  caption_entities?: TelegramEntity[];
  rich_message?: TelegramRichMessage;
  message_thread_id?: number;
  reply_to_message?: { message_id: number };
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
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);

function fxTwitterUrl(urls: URL[]): string | null {
  for (const url of urls) {
    if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) continue;

    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match) continue;

    const [, username, statusId] = match;
    return `https://fxtwitter.com/${username}/status/${statusId}`;
  }

  return null;
}

function instagramUrl(urls: URL[], baseUrl: string): string | null {
  for (const url of urls) {
    if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) continue;

    return `${baseUrl.replace(/\/$/, "")}${url.pathname}${url.search}${url.hash}`;
  }

  return null;
}

function youtubeVideoId(urls: URL[]): string | null {
  for (const url of urls) {
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
  return "Someone";
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
  replacement: MessageContent,
  env: Env,
): Promise<void> {
  const sentIds: number[] = [];
  try {
    for (const chunk of splitContent(replacement)) {
      const sent = await telegramCall<{ message_id: number }>(env, "sendMessage", {
        chat_id: message.chat.id,
        text: chunk.text,
        entities: chunk.entities,
        ...(message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
        ...(message.reply_to_message ? { reply_parameters: {
          message_id: message.reply_to_message.message_id, allow_sending_without_reply: true,
        } } : {}),
      });
      sentIds.push(sent.message_id);
    }
  } catch (error) {
    // Preserve the original and remove partial output before Telegram retries.
    for (const message_id of sentIds) {
      try { await telegramCall(env, "deleteMessage", { chat_id: message.chat.id, message_id }); }
      catch (cleanupError) { console.error("Could not remove a partial replacement", cleanupError); }
    }
    throw error;
  }

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

  const rich = richMessageContent(message.rich_message);
  const content = combineContent([
    { text: message.text ?? "", entities: message.entities ?? [] },
    { text: message.caption ?? "", entities: message.caption_entities ?? [] },
    { text: rich.text.replace(/\n$/, ""), entities: rich.entities },
  ]);
  const urls = candidateUrls(content.text, content.entities);
  const mentioned = youtubeVideoId(urls) ? await isBotMentioned(content.text, env) : false;
  const rewritten = rewriteContent(content, url => {
    const videoId = mentioned ? youtubeVideoId([url]) : null;
    if (videoId) {
      const baseUrl = (env.INVIDIOUS_BASE_URL ?? "https://y.com.sb").replace(/\/$/, "");
      return `${baseUrl}/watch?v=${encodeURIComponent(videoId)}`;
    }
    return fxTwitterUrl([url]) ?? instagramUrl([url], env.INSTAGRAM_BASE_URL ?? "https://oginstagram.com");
  });
  if (!rewritten.changed) return;
  const label = message.sender_chat
    ? (message.sender_chat.username ? `@${message.sender_chat.username}` : message.sender_chat.title ?? "Someone")
    : senderLabel(message.from);
  const prefix = `${label} ${isLinkOnly(rewritten.content) ? "sent" : "wrote"}: `;
  const replacement: MessageContent = {
    text: prefix + rewritten.content.text,
    entities: rewritten.content.entities.map(entity => ({ ...entity, offset: entity.offset + prefix.length })),
  };
  if (message.sender_chat?.username || (!message.sender_chat && message.from?.username)) {
    replacement.entities.unshift({ type: "mention", offset: 0, length: label.length });
  } else if (!message.sender_chat && message.from) {
    replacement.entities.unshift({ type: "text_mention", offset: 0, length: label.length,
      user: { id: message.from.id, is_bot: message.from.is_bot ?? false, first_name: message.from.first_name ?? label } });
  }
  await sendReplacementAndDelete(message, replacement, env);
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
