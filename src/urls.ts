export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: { id: number; is_bot: boolean; first_name: string };
}

export interface MessageLink {
  offset: number;
  length: number;
  textLink: boolean;
  destination?: string;
  url?: URL;
}

// Match complete HTTP(S) URLs or bare domains. The boundary prevents extracting
// a supported hostname from an email address, another hostname or another scheme.
const URL_RE = /(?<![\w@/.:+-])(?:https?:\/\/[^\s<>()]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>()]*)?)/gi;

function trimPunctuation(value: string): string {
  let previous: string;
  do {
    previous = value;
    value = value.replace(/[),.!?;:'"’”]+$/g, "");
    for (const [open, close] of [["[", "]"], ["{", "}"]]) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
    }
  } while (value !== previous);
  return value;
}

export function messageLinks(text: string, entities: TelegramEntity[] = []): MessageLink[] {
  // Telegram and JavaScript both measure offsets in UTF-16 code units.
  const links = entities.filter((entity) =>
    (entity.type === "url" || entity.type === "text_link") &&
    Number.isInteger(entity.offset) && Number.isInteger(entity.length) &&
    entity.offset >= 0 && entity.length > 0 &&
    entity.offset + entity.length <= text.length
  );
  const candidates = links.map((entity) => ({
    offset: entity.offset,
    length: entity.length,
    textLink: entity.type === "text_link",
    value: entity.type === "text_link"
      ? entity.url
      : text.slice(entity.offset, entity.offset + entity.length),
  }));

  for (const match of text.matchAll(URL_RE)) {
    // Hyperlink labels can look like URLs; their destination is authoritative.
    if (links.some((entity) =>
      match.index < entity.offset + entity.length &&
      match.index + match[0].length > entity.offset
    )) continue;
    const value = trimPunctuation(match[0]);
    candidates.push({ offset: match.index, length: value.length, textLink: false, value });
  }

  return candidates.sort((a, b) => a.offset - b.offset).map(({ value, ...span }) => {
    const result: MessageLink = { ...span, destination: value };
    if (!value) return result;
    try {
      const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
      const hasPort = /^[\w.-]+:\d+(?:[/?#]|$)/.test(value);
      const url = new URL(hasScheme && !hasPort ? value : `https://${value}`);
      if (url.protocol === "http:" || url.protocol === "https:") {
        result.url = url;
      }
    } catch {
      // A malformed link must not prevent scanning the remaining candidates.
    }
    return result;
  });
}

export function candidateUrls(text: string, entities: TelegramEntity[] = []): URL[] {
  const urls = new Map<string, URL>();
  for (const { url } of messageLinks(text, entities)) {
    if (url) urls.set(url.href, url);
  }
  return [...urls.values()];
}
