import { messageLinks, type TelegramEntity } from "./urls";

export interface MessageContent {
  text: string;
  entities: TelegramEntity[];
}

export function isLinkOnly(content: MessageContent): boolean {
  let cursor = 0;
  let found = false;
  const links = content.entities.filter(entity => entity.type === "url" || entity.type === "text_link")
    .sort((a, b) => a.offset - b.offset);
  for (const link of links) {
    if (link.offset < cursor) continue;
    if (content.text.slice(cursor, link.offset).trim()) return false;
    cursor = link.offset + link.length;
    found = true;
  }
  return found && !content.text.slice(cursor).trim();
}

export function combineContent(parts: MessageContent[]): MessageContent {
  const result: MessageContent = { text: "", entities: [] };
  for (const part of parts) {
    if (!part.text) continue;
    if (result.text) result.text += "\n";
    const offset = result.text.length;
    result.text += part.text;
    result.entities.push(...part.entities.map(entity => ({ ...entity, offset: entity.offset + offset })));
  }
  return result;
}

// Preserve the author's wording and link order. Ordinary URLs are replaced in
// place; named hyperlinks keep their labels and receive the new destination.
export function rewriteContent(content: MessageContent, rewrite: (url: URL) => string | null): {
  content: MessageContent;
  changed: boolean;
} {
  const result: MessageContent = { text: "", entities: [] };
  let cursor = 0;
  let changed = false;
  for (const link of messageLinks(content.text, content.entities)) {
    if (link.offset < cursor) continue;
    result.text += content.text.slice(cursor, link.offset);
    const original = content.text.slice(link.offset, link.offset + link.length);
    const replacement = link.url ? rewrite(link.url) : null;
    changed ||= replacement !== null;
    const labelLinks = link.textLink ? messageLinks(original) : [];
    const urlLabel = original === link.destination || original === "\uFFFC" ||
      (labelLinks.length === 1 && labelLinks[0].offset === 0 && labelLinks[0].length === original.length &&
       labelLinks[0].url?.href === link.url?.href);
    const label = replacement && (!link.textLink || urlLabel) ? replacement : original;
    const offset = result.text.length;
    result.text += label;
    const destination = replacement ?? (link.textLink ? link.destination : link.url?.href);
    if (destination && label) {
      result.entities.push({ type: "text_link", offset, length: label.length, url: destination });
    }
    cursor = link.offset + link.length;
  }
  result.text += content.text.slice(cursor);
  return { content: result, changed };
}

// Attribution and longer rewritten URLs can make a valid incoming message exceed
// sendMessage's limit. Keep all text, link targets and UTF-16 surrogate pairs.
export function splitContent(content: MessageContent, limit = 4096): MessageContent[] {
  const chunks: MessageContent[] = [];
  for (let start = 0; start < content.text.length;) {
    let end = Math.min(start + limit, content.text.length);
    if (end < content.text.length) {
      const newline = content.text.lastIndexOf("\n", end - 1) + 1;
      const space = content.text.lastIndexOf(" ", end - 1) + 1;
      const boundary = Math.max(newline, space);
      if (boundary > start + limit / 2) end = boundary;
      for (const entity of content.entities) {
        if (entity.offset > start && entity.offset < end && entity.offset + entity.length > end) end = entity.offset;
      }
      const before = content.text.charCodeAt(end - 1);
      const after = content.text.charCodeAt(end);
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--;
    }
    chunks.push({
      text: content.text.slice(start, end),
      entities: content.entities
        .filter(entity => entity.offset < end && entity.offset + entity.length > start)
        .map(entity => ({ ...entity, offset: Math.max(entity.offset, start) - start,
          length: Math.min(entity.offset + entity.length, end) - Math.max(entity.offset, start) })),
    });
    start = end;
  }
  return chunks;
}
