export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

// Match complete HTTP(S) URLs or bare domains. The boundary prevents extracting
// a supported hostname from an email address, another hostname or another scheme.
const URL_RE = /(?<![\w@/.:+-])(?:https?:\/\/[^\s<>()]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>()]*)?)/gi;

export function candidateUrls(text: string, entities: TelegramEntity[] = []): URL[] {
  // Telegram and JavaScript both measure offsets in UTF-16 code units.
  const links = entities.filter((entity) =>
    (entity.type === "url" || entity.type === "text_link") &&
    Number.isInteger(entity.offset) && Number.isInteger(entity.length) &&
    entity.offset >= 0 && entity.length > 0 &&
    entity.offset + entity.length <= text.length
  );
  const candidates = links.map((entity) => ({
    offset: entity.offset,
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
    candidates.push({ offset: match.index, value: match[0].replace(/[),.!?]+$/g, "") });
  }

  const urls = new Map<string, URL>();
  for (const { value } of candidates.sort((a, b) => a.offset - b.offset)) {
    if (!value) continue;
    try {
      const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value);
      const hasPort = /^[\w.-]+:\d+(?:[/?#]|$)/.test(value);
      const url = new URL(hasScheme && !hasPort ? value : `https://${value}`);
      if (url.protocol === "http:" || url.protocol === "https:") {
        urls.set(url.href, url);
      }
    } catch {
      // A malformed link must not prevent scanning the remaining candidates.
    }
  }
  return [...urls.values()];
}
