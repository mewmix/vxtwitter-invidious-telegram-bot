import type { TelegramEntity } from "./urls";

type RichText = string | RichText[] | {
  type: string;
  text?: RichText;
  url?: string;
  button?: RichButton;
  alternative_text?: string;
};

interface RichButton {
  text: RichText;
  url?: string;
}

interface RichCaption {
  text: RichText;
  credit?: RichText;
}

interface RichBlock {
  type: string;
  text?: RichText;
  summary?: RichText;
  credit?: RichText;
  caption?: RichText | RichCaption;
  blocks?: RichBlock[];
  items?: { label?: string; blocks: RichBlock[] }[];
  cells?: { text?: RichText }[][];
  buttons?: RichButton[];
}

export interface TelegramRichMessage {
  blocks: RichBlock[];
}

// Render the visible text and link spans so all message formats use the same
// URL extractor. Do not scan unrelated media metadata or URL-shaped link labels.
export function richMessageContent(message?: TelegramRichMessage): {
  text: string;
  entities: TelegramEntity[];
} {
  let text = "";
  const entities: TelegramEntity[] = [];

  function link(offset: number, url?: string): void {
    if (!url) return;
    // Keep destinations of empty-label links without introducing visible URL text.
    if (text.length === offset) text += "\uFFFC";
    entities.push({ type: "text_link", offset, length: text.length - offset, url });
  }

  function button(value: RichButton): void {
    const offset = text.length;
    inline(value.text);
    link(offset, value.url);
  }

  function inline(value?: RichText): void {
    if (typeof value === "string") {
      text += value;
    } else if (Array.isArray(value)) {
      value.forEach(inline);
    } else if (value) {
      if (value.type === "button" && value.button) {
        button(value.button);
        return;
      }
      const offset = text.length;
      inline(value.text);
      if (value.type === "custom_emoji") text += value.alternative_text ?? "";
      if (value.type === "url") link(offset, value.url);
    }
  }

  function field(value?: RichText): void {
    const offset = text.length;
    inline(value);
    // Keep inline formatting contiguous, but do not combine URLs across blocks.
    if (text.length > offset) text += "\n";
  }

  function block(value: RichBlock): void {
    field(value.summary);
    field(value.text);
    value.blocks?.forEach(block);
    value.items?.forEach(item => {
      if (item.label) text += `${item.label} `;
      item.blocks.forEach(block);
    });
    value.cells?.forEach(row => row.forEach(cell => field(cell.text)));
    value.buttons?.forEach(item => { button(item); text += "\n"; });
    const caption = value.caption;
    if (caption && typeof caption === "object" && !Array.isArray(caption) && !("type" in caption)) {
      field(caption.text);
      field(caption.credit);
    } else {
      field(caption);
    }
    field(value.credit);
  }

  message?.blocks.forEach(block);
  return { text, entities };
}
