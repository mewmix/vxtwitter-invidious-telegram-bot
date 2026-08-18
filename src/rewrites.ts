export interface RewriteEnv {
  INVIDIOUS_BASE_URL?: string;
  INSTAGRAM_BASE_URL?: string;
  REDLIB_BASE_URL?: string;
  PROXITOK_BASE_URL?: string;
  SAFETWITCH_BASE_URL?: string;
  RIMGO_BASE_URL?: string;
  SCRIBE_BASE_URL?: string;
  QUETRE_BASE_URL?: string;
  BREEZEWIKI_BASE_URL?: string;
  SKYVIEW_BASE_URL?: string;
  SHOELACE_BASE_URL?: string;
  PRIVIBLUR_BASE_URL?: string;
}

export interface RewriteResult {
  service: string;
  url: string;
}

interface RewriteRule {
  service: string;
  requiresMention?: boolean;
  rewrite(url: URL, env: RewriteEnv): string | null;
}

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
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);
const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "amp.reddit.com",
]);
const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
]);
const IMGUR_HOSTS = new Set([
  "imgur.com",
  "www.imgur.com",
  "m.imgur.com",
  "i.imgur.com",
  "stack.imgur.com",
  "i.stack.imgur.com",
]);

export function candidateUrls(text: string): URL[] {
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

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function proxiedUrl(url: URL, baseUrl: string): string {
  return `${normalizedBaseUrl(baseUrl)}${url.pathname}${url.search}${url.hash}`;
}

function optionalProxy(url: URL, baseUrl?: string): string | null {
  return baseUrl ? proxiedUrl(url, baseUrl) : null;
}

function hostIsOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();

  if (host === "youtu.be" || host === "www.youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] ?? null;
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (url.pathname === "/watch") return url.searchParams.get("v");

  const pathMatch = url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/i);
  return pathMatch?.[1] ?? null;
}

function redlibUrl(url: URL, baseUrl: string): string | null {
  const host = url.hostname.toLowerCase();
  const base = normalizedBaseUrl(baseUrl);

  if (REDDIT_HOSTS.has(host)) return `${base}${url.pathname}${url.search}${url.hash}`;
  if (host === "redd.it" || host === "www.redd.it") {
    return `${base}/comments${url.pathname}${url.search}${url.hash}`;
  }
  if (host === "i.redd.it") return `${base}/img${url.pathname}`;
  if (host === "preview.redd.it") {
    return `${base}/preview/pre${url.pathname}${url.search}`;
  }
  if (host === "external-preview.redd.it") {
    return `${base}/preview/external-pre${url.pathname}${url.search}`;
  }

  return null;
}

function breezeWikiUrl(url: URL, baseUrl: string): string | null {
  const host = url.hostname.toLowerCase();
  const match = host.match(/^([a-z0-9-]+)\.(?:fandom|wikia)\.com$/i);
  if (!match) return null;

  const wiki = match[1] === "www" ? "" : `/${match[1]}`;
  return `${normalizedBaseUrl(baseUrl)}${wiki}${url.pathname}${url.search}${url.hash}`;
}

function quetreUrl(url: URL, baseUrl: string): string | null {
  const host = url.hostname.toLowerCase();
  if (!hostIsOrSubdomain(host, "quora.com")) return null;

  const rewritten = new URL(`${normalizedBaseUrl(baseUrl)}${url.pathname}${url.search}${url.hash}`);
  const language = host.match(/^([a-z]{2,3})\.quora\.com$/)?.[1];
  if (language && language !== "www") rewritten.searchParams.set("lang", language);
  return rewritten.toString();
}

function priviblurUrl(url: URL, baseUrl: string): string | null {
  const host = url.hostname.toLowerCase();
  const base = normalizedBaseUrl(baseUrl);

  if (host === "tumblr.com" || host === "www.tumblr.com") {
    return `${base}${url.pathname}${url.search}${url.hash}`;
  }
  if (host === "assets.tumblr.com") return `${base}/tblr/assets${url.pathname}${url.search}`;
  if (host === "static.tumblr.com") return `${base}/tblr/static${url.pathname}${url.search}`;

  const media = host.match(/^([0-9]+)\.media\.tumblr\.com$/);
  if (media) return `${base}/tblr/media/${media[1]}${url.pathname}${url.search}`;

  const blog = host.match(/^([a-z0-9-]+)\.tumblr\.com$/i);
  if (!blog) return null;

  const path = url.pathname.startsWith("/post") ? url.pathname.slice(5) : url.pathname;
  return `${base}/${blog[1]}${path}${url.search}${url.hash}`;
}

const REWRITE_RULES: RewriteRule[] = [
  {
    service: "YouTube",
    requiresMention: true,
    rewrite(url, env) {
      const videoId = youtubeVideoId(url);
      if (!videoId) return null;
      const base = normalizedBaseUrl(env.INVIDIOUS_BASE_URL ?? "https://y.com.sb");
      return `${base}/watch?v=${encodeURIComponent(videoId)}`;
    },
  },
  {
    service: "Twitter/X",
    rewrite(url) {
      if (!TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
      if (!match) return null;
      return `https://fxtwitter.com/${match[1]}/status/${match[2]}`;
    },
  },
  {
    service: "Instagram",
    rewrite(url, env) {
      if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
      return proxiedUrl(url, env.INSTAGRAM_BASE_URL ?? "https://oginstagram.com");
    },
  },
  {
    service: "Reddit",
    rewrite(url, env) {
      return redlibUrl(url, env.REDLIB_BASE_URL ?? "https://redlib.privacyredirect.com");
    },
  },
  {
    service: "TikTok",
    rewrite(url, env) {
      if (!TIKTOK_HOSTS.has(url.hostname.toLowerCase())) return null;
      return optionalProxy(url, env.PROXITOK_BASE_URL);
    },
  },
  {
    service: "Twitch",
    rewrite(url, env) {
      const host = url.hostname.toLowerCase();
      if (host !== "twitch.tv" && host !== "www.twitch.tv" && host !== "clips.twitch.tv") return null;
      if (!env.SAFETWITCH_BASE_URL) return null;

      const base = normalizedBaseUrl(env.SAFETWITCH_BASE_URL);
      if (host === "clips.twitch.tv") return `${base}/clip${url.pathname}${url.search}${url.hash}`;
      return `${base}${url.pathname}${url.search}${url.hash}`;
    },
  },
  {
    service: "Imgur",
    rewrite(url, env) {
      const host = url.hostname.toLowerCase();
      if (!IMGUR_HOSTS.has(host) || !env.RIMGO_BASE_URL) return null;

      const prefix = host.includes("stack.imgur.com") ? "/stack" : "";
      return `${normalizedBaseUrl(env.RIMGO_BASE_URL)}${prefix}${url.pathname}${url.search}${url.hash}`;
    },
  },
  {
    service: "Bluesky",
    rewrite(url, env) {
      if (url.hostname.toLowerCase() !== "bsky.app" || !env.SKYVIEW_BASE_URL) return null;
      if (url.pathname === "/") return normalizedBaseUrl(env.SKYVIEW_BASE_URL);
      return `${normalizedBaseUrl(env.SKYVIEW_BASE_URL)}?url=${encodeURIComponent(url.href)}`;
    },
  },
  {
    service: "Threads",
    rewrite(url, env) {
      const host = url.hostname.toLowerCase();
      const isThreads = new Set(["threads.net", "www.threads.net", "threads.com", "www.threads.com"]).has(host);
      if (!isThreads) return null;
      return optionalProxy(url, env.SHOELACE_BASE_URL);
    },
  },
  {
    service: "Tumblr",
    rewrite(url, env) {
      if (!env.PRIVIBLUR_BASE_URL) return null;
      return priviblurUrl(url, env.PRIVIBLUR_BASE_URL);
    },
  },
  {
    service: "Medium",
    rewrite(url, env) {
      const host = url.hostname.toLowerCase();
      if (!hostIsOrSubdomain(host, "medium.com") || !env.SCRIBE_BASE_URL) return null;

      const subdomain = host.match(/^([a-z0-9-]+)\.medium\.com$/)?.[1];
      if (subdomain && !["www", "medium", "link"].includes(subdomain)) {
        return `${normalizedBaseUrl(env.SCRIBE_BASE_URL)}/@${subdomain}${url.pathname}${url.search}${url.hash}`;
      }
      return proxiedUrl(url, env.SCRIBE_BASE_URL);
    },
  },
  {
    service: "Quora",
    rewrite(url, env) {
      if (!env.QUETRE_BASE_URL) return null;
      return quetreUrl(url, env.QUETRE_BASE_URL);
    },
  },
  {
    service: "Fandom",
    rewrite(url, env) {
      if (!env.BREEZEWIKI_BASE_URL) return null;
      return breezeWikiUrl(url, env.BREEZEWIKI_BASE_URL);
    },
  },
];

export function findRewrite(urls: URL[], env: RewriteEnv, mentioned: boolean): RewriteResult | null {
  for (const rule of REWRITE_RULES) {
    if (rule.requiresMention && !mentioned) continue;

    for (const url of urls) {
      const rewritten = rule.rewrite(url, env);
      if (rewritten) return { service: rule.service, url: rewritten };
    }
  }

  return null;
}
