import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

async function loadModule(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint], bundle: true, write: false,
    format: "esm", platform: "neutral", target: "es2022",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { candidateUrls } = await loadModule("src/urls.ts");
const { richMessageContent } = await loadModule("src/rich-message.ts");
const { default: worker } = await loadModule("src/index.ts");
const bareTwitter = "twitter.com/JeffJacksonNC/status/2094527969897169014";
const env = { TELEGRAM_TOKEN: "test-token", TELEGRAM_WEBHOOK_SECRET: "test-secret" };
const message = { message_id: 11, chat: { id: 22 }, from: { id: 33, username: "tester" } };
const expandedEditorMessage = JSON.parse(await readFile(new URL("./fixtures/expanded-editor-message.json", import.meta.url), "utf8"));

const links = [
  bareTwitter,
  "x.com/jack/status/20",
  "www.instagram.com/p/example/?img_index=2#media",
  "old.reddit.com/r/example/comments/abc/title/?sort=new#comment",
  "redd.it/abc",
  "youtu.be/example?t=10",
  "www.youtube.com/watch?v=example",
];

for (const link of links) {
  for (const scheme of ["", "https://", "http://"]) {
    test(`extract ${scheme}${link} from plaintext and url entities`, () => {
      const value = `${scheme}${link}`;
      const text = `Look: ${value}`;
      const expected = new URL(scheme ? value : `https://${value}`).href;
      assert.deepEqual(candidateUrls(text).map(url => url.href), [expected]);
      assert.deepEqual(candidateUrls(text, [{ type: "url", offset: 6, length: value.length }]).map(url => url.href), [expected]);
    });
  }
}

test("extract formatted destinations with UTF-16 offsets and exact punctuation", () => {
  const text = "😀 Watch this";
  const value = "https://instagram.com/p/example/?value=hello!";
  assert.deepEqual(candidateUrls(text, [{ type: "text_link", offset: 3, length: 10, url: value }]).map(url => url.href), [value]);
});

test("prefer the hyperlink destination over its URL-shaped display label", () => {
  const text = "https://youtu.be/display-label";
  assert.deepEqual(candidateUrls(text, [{ type: "text_link", offset: 0, length: text.length, url: bareTwitter }]).map(url => url.href), [`https://${bareTwitter}`]);
});

test("deduplicate a destination repeated in entities and plaintext", () => {
  const text = `Post ${bareTwitter} ${bareTwitter}`;
  assert.equal(candidateUrls(text, [{ type: "text_link", offset: 0, length: 4, url: `https://${bareTwitter}` }]).length, 1);
});

test("trim surrounding punctuation on plaintext links", () => {
  assert.equal(candidateUrls(`(${bareTwitter}), next`)[0].href, `https://${bareTwitter}`);
});

test("ignore malformed entities without losing a valid plaintext URL", () => {
  const entities = [
    { type: "text_link", offset: -1, length: 5, url: "https://x.com/wrong/status/1" },
    { type: "url", offset: 0, length: 99999 },
    { type: "url", offset: 0.5, length: 5 },
  ];
  assert.equal(candidateUrls(bareTwitter, entities)[0].href, `https://${bareTwitter}`);
});

test("ignore malformed or non-HTTP hyperlink destinations", () => {
  for (const url of [undefined, "https://[", "javascript:alert(1)", "tg://resolve?domain=example", "mailto:test@example.com"]) {
    assert.deepEqual(candidateUrls(bareTwitter, [{ type: "text_link", offset: 0, length: bareTwitter.length, url }]), []);
  }
});

test("do not extract bare hostnames from emails or non-HTTP schemes", () => {
  for (const text of ["someone@twitter.com/Jeff/status/123", "ftp://twitter.com/Jeff/status/123", "tg://twitter.com/Jeff/status/123"]) {
    assert.deepEqual(candidateUrls(text), []);
  }
});

function webhook(update, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  return new Request("https://worker.example/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
  });
}

async function invoke(t, fields, failMethod) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.telegram.org");
    const method = new URL(url).pathname.split("/").pop();
    calls.push({ method, body: JSON.parse(options.body) });
    return method === failMethod
      ? Response.json({ ok: false, description: "simulated failure" }, { status: 400 })
      : Response.json({ ok: true, result: method === "getMe" ? { username: "WebSlingerBot" } : { message_id: 44 } });
  });
  const response = await worker.fetch(webhook({ update_id: 1, message: { ...message, ...fields } }), env);
  return { response, calls };
}

test("rewrite the captured expanded editor rich_message without text or caption", async t => {
  assert.equal(expandedEditorMessage.text, undefined);
  assert.equal(expandedEditorMessage.caption, undefined);
  const { response, calls } = await invoke(t, expandedEditorMessage);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
  assert.ok(calls[0].body.text.includes("https://fxtwitter.com/0xMarcB/status/2123108720154726784"));
});

const rewrites = [
  { input: bareTwitter, expected: "https://fxtwitter.com/JeffJacksonNC/status/2094527969897169014" },
  { input: "x.com/jack/status/20", expected: "https://fxtwitter.com/jack/status/20" },
  { input: "instagram.com/p/example/?img_index=2#media", expected: "https://oginstagram.com/p/example/?img_index=2#media" },
  { input: "youtu.be/example?t=10", expected: "https://y.com.sb/watch?v=example", mention: " @WebSlingerBot" },
];

for (const { input, expected, mention = "" } of rewrites) {
  const formats = [
    ["plaintext", { text: input + mention }],
    ["HTTPS plaintext", { text: `https://${input}${mention}` }],
    ["url entity", { text: input + mention, entities: [{ type: "url", offset: 0, length: input.length }] }],
    ["formatted hyperlink", { text: `Read this${mention}`, entities: [{ type: "text_link", offset: 0, length: 9, url: `https://${input}` }] }],
    ["caption", { caption: input + mention }],
    ["caption hyperlink", { caption: `Read this${mention}`, caption_entities: [{ type: "text_link", offset: 0, length: 9, url: `https://${input}` }] }],
    ["formatting over a pasted URL", { text: input + mention, entities: [{ type: "bold", offset: 0, length: input.length }] }],
    ["expanded-editor plaintext", { rich_message: { blocks: [{ type: "paragraph", text: input + mention }] } }],
    ["expanded-editor hyperlink", { rich_message: { blocks: [{ type: "paragraph", text: [{ type: "url", text: "Read this", url: `https://${input}` }, mention] }] } }],
  ];
  for (const [format, fields] of formats) {
    test(`rewrite ${input} as ${format}, then delete the original once`, async t => {
      const { response, calls } = await invoke(t, fields);
      assert.equal(response.status, 200);
      const replacements = calls.filter(call => call.method === "sendMessage");
      assert.equal(replacements.length, 1);
      assert.ok(replacements[0].body.text.includes(expected));
      assert.equal(replacements[0].body.chat_id, message.chat.id);
      assert.equal(calls.at(-1).method, "deleteMessage");
      assert.deepEqual(calls.at(-1).body, { chat_id: message.chat.id, message_id: message.message_id });
    });
  }
}

const richLink = { type: "url", text: "Read this", url: `https://${bareTwitter}` };
const paragraph = { type: "paragraph", text: richLink };
const richContainers = [
  ["heading", { type: "heading", size: 2, text: richLink }],
  ["preformatted text", { type: "pre", text: richLink }],
  ["footer", { type: "footer", text: richLink }],
  ["list", { type: "list", items: [{ label: "1.", blocks: [paragraph] }] }],
  ["block quote", { type: "blockquote", blocks: [paragraph] }],
  ["expandable quote", { type: "expandable_blockquote", text: richLink }],
  ["quote credit", { type: "pullquote", text: "Quoted text", credit: richLink }],
  ["details summary", { type: "details", summary: richLink, blocks: [] }],
  ["details body", { type: "details", summary: "Open", blocks: [paragraph] }],
  ["table cell", { type: "table", cells: [[{ text: richLink, align: "left", valign: "top" }]] }],
  ["table caption", { type: "table", cells: [], caption: richLink }],
  ["photo caption", { type: "photo", photo: [], caption: { text: richLink } }],
  ["video caption credit", { type: "video", video: {}, caption: { text: "Caption", credit: richLink } }],
  ["collage caption", { type: "collage", blocks: [], caption: { text: richLink } }],
  ["slideshow", { type: "slideshow", blocks: [{ type: "photo", photo: [], caption: { text: richLink } }] }],
  ["inline button", { type: "paragraph", text: { type: "button", button: { text: "Open", url: `https://${bareTwitter}` } } }],
  ["button row", { type: "buttons", buttons: [{ text: "Open", url: `https://${bareTwitter}` }] }],
];

for (const [name, block] of richContainers) {
  test(`rewrite a link in a rich-message ${name}`, async t => {
    const { calls } = await invoke(t, { rich_message: { blocks: [block] } });
    assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
    assert.ok(calls[0].body.text.includes("https://fxtwitter.com/JeffJacksonNC/status/2094527969897169014"));
  });
}

test("keep inline text contiguous across nested formatting and emoji", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [{
    type: "paragraph",
    text: ["😀 ", { type: "bold", text: ["https://x.com/", { type: "italic", text: "jack" }, "/status/20"] }],
  }] } });
  assert.ok(calls[0].body.text.includes("https://fxtwitter.com/jack/status/20"));
});

test("keep a rich link destination authoritative over a URL-shaped label", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [{
    type: "paragraph", text: { type: "url", text: "https://youtu.be/wrong @WebSlingerBot", url: `https://${bareTwitter}` },
  }] } });
  assert.ok(calls.find(call => call.method === "sendMessage").body.text.includes("https://fxtwitter.com/JeffJacksonNC/status/2094527969897169014"));
});

test("ignore non-HTTP rich destinations even when the label looks supported", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [{
    type: "paragraph", text: { type: "url", text: `https://${bareTwitter}`, url: "tg://resolve?domain=example" },
  }] } });
  assert.deepEqual(calls, []);
});

test("do not join URLs across rich-message block boundaries", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [
    { type: "paragraph", text: "https://x.com/jack/" },
    { type: "paragraph", text: "status/20" },
  ] } });
  assert.deepEqual(calls, []);
});

test("deduplicate links repeated in rich text and block captions", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [paragraph, paragraph, { type: "photo", photo: [], caption: { text: richLink } }] } });
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
});

test("handle empty rich hyperlink labels", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [{ type: "paragraph", text: { type: "url", text: "", url: `https://${bareTwitter}` } }] } });
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
});

test("ignore media metadata and empty rich messages", async t => {
  for (const rich_message of [{ blocks: [] }, { blocks: [{ type: "photo", photo: [{ file_id: `https://${bareTwitter}` }] }] }]) {
    const { calls } = await invoke(t, { rich_message });
    assert.deepEqual(calls, []);
  }
});

test("a bot mention hidden in a rich URL destination does not enable YouTube rewriting", async t => {
  const { calls } = await invoke(t, { rich_message: { blocks: [{
    type: "paragraph", text: { type: "url", text: "Video", url: "https://youtu.be/example?ref=@WebSlingerBot" },
  }] } });
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 0);
});

test("extract every supported-domain candidate from rich text through the shared extractor", () => {
  for (const input of links) {
    const content = richMessageContent({ blocks: [{ type: "paragraph", text: { type: "bold", text: [{ type: "url", text: "Link", url: `https://${input}` }] } }] });
    assert.deepEqual(candidateUrls(content.text, content.entities).map(url => url.href), [new URL(`https://${input}`).href]);
  }
});

test("emit one replacement when the same URL occurs multiple times", async t => {
  const { calls } = await invoke(t, { text: `${bareTwitter} ${bareTwitter}`, entities: [{ type: "url", offset: 0, length: bareTwitter.length }] });
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
});

test("preserve the deployed YouTube mention requirement", async t => {
  const { calls } = await invoke(t, { text: "youtu.be/example" });
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 0);
});

test("preserve service priority when a mentioned YouTube URL follows Twitter", async t => {
  const { calls } = await invoke(t, { text: `${bareTwitter} youtu.be/example @WebSlingerBot` });
  const sent = calls.find(call => call.method === "sendMessage");
  assert.ok(sent.body.text.includes("https://y.com.sb/watch?v=example"));
});

for (const text of ["/start", "hello", "twitter.com/example", "https://twitter.com.evil.example/a/status/123", "nottwitter.com/a/status/123", "https://example.com/?next=twitter.com/a/status/123"]) {
  test(`ignore unsupported input: ${text}`, async t => {
    const { calls } = await invoke(t, { text });
    assert.deepEqual(calls, []);
  });
}

test("do not delete the original if sending its replacement fails", async t => {
  t.mock.method(console, "error", () => {});
  const { response, calls } = await invoke(t, { text: bareTwitter }, "sendMessage");
  assert.equal(response.status, 500);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage"]);
});

test("acknowledge a successful replacement even if deletion fails", async t => {
  t.mock.method(console, "error", () => {});
  const { response, calls } = await invoke(t, { text: bareTwitter }, "deleteMessage");
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
});

test("reject an unauthenticated update before making Telegram calls", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected call"); });
  const response = await worker.fetch(webhook({ update_id: 1, message: { ...message, text: bareTwitter } }, "wrong-secret"), env);
  assert.equal(response.status, 403);
  assert.equal(fetch.mock.callCount(), 0);
});
