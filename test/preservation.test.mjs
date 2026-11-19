import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

async function load(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { default: worker } = await load("src/index.ts");
const { splitContent } = await load("src/replacement.ts");
const source = "x.com/jack/status/20";
const target = "https://fxtwitter.com/jack/status/20";
const env = { TELEGRAM_TOKEN: "test-token", TELEGRAM_WEBHOOK_SECRET: "test-secret" };

async function invoke(t, fields, options = {}) {
  const calls = [];
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).origin, "https://api.telegram.org");
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === "sendMessage") {
      sends++;
      assert.ok(body.text.length > 0 && body.text.length <= 4096);
      assert.equal(body.parse_mode, undefined);
      for (const entity of body.entities) {
        assert.ok(Number.isInteger(entity.offset) && Number.isInteger(entity.length));
        assert.ok(entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= body.text.length);
      }
      if (sends === options.failSend) return Response.json({ ok: false, description: "simulated send failure" }, { status: 400 });
      return Response.json({ ok: true, result: { message_id: 100 + sends } });
    }
    return Response.json({ ok: true, result: method === "getMe" ? { username: "WebSlingerBot" } : true });
  });
  const response = await worker.fetch(new Request("https://worker.example/webhook", {
    method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ update_id: 1, message: { message_id: 11, chat: { id: 22 }, from: { id: 33, username: "tester" }, ...fields } }),
  }), env);
  return { response, calls, sent: calls.filter(call => call.method === "sendMessage").map(call => call.body) };
}

const examples = [
  ["text before the URL", `Check this ${source}`, `Check this ${target}`],
  ["text after the URL", `${source} What a story`, `${target} What a story`],
  ["text on both sides", `Before ${source} after`, `Before ${target} after`],
  ["line breaks", `First line\n${source}\nLast line`, `First line\n${target}\nLast line`],
  ["HTTP URL", `See http://${source}.`, `See ${target}.`],
  ["HTTPS URL", `See https://${source}!`, `See ${target}!`],
  ["square brackets", `Look [${source}] (text: wow)`, `Look [${target}] (text: wow)`],
  ["braces", `Look {${source}}.`, `Look {${target}}.`],
  ["quoted URL", `He said "${source}"`, `He said "${target}"`],
  ["nested URL punctuation", `Look "{[${source}]}"!`, `Look "{[${target}]}"!`],
  ["emoji and literal markup", `😀 <tag> & *words* ${source} 🙃`, `😀 <tag> & *words* ${target} 🙃`],
  ["spacing", `  before  ${source}  after  `, `  before  ${target}  after  `],
  ["tracking parameters", `${source}?s=19&a=example!`, `${target}!`],
];

for (const [name, input, expected] of examples) {
  for (const format of ["text", "caption", "rich"]) {
    test(`preserve ${name} in ${format}`, async t => {
      const fields = format === "rich" ? { rich_message: { blocks: [{ type: "paragraph", text: input }] } } : { [format]: input };
      const { response, calls, sent } = await invoke(t, fields);
      assert.equal(response.status, 200);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text, `@tester wrote: ${expected}`);
      assert.deepEqual(calls.map(call => call.method), ["sendMessage", "deleteMessage"]);
    });
  }
}

test("preserve a normal URL entity and its surrounding text", async t => {
  const text = `😀 ${source} and comments`;
  const { sent } = await invoke(t, { text, entities: [{ type: "url", offset: 3, length: source.length }] });
  assert.equal(sent[0].text, `@tester wrote: 😀 ${target} and comments`);
});

for (const format of ["text", "caption", "rich"]) {
  test(`preserve named hyperlink labels and rewritten targets in ${format}`, async t => {
    const fields = format === "rich"
      ? { rich_message: { blocks: [{ type: "paragraph", text: ["😀 Before ", { type: "bold", text: { type: "url", text: "Read this", url: `https://${source}` } }, " after"] }] } }
      : { [format]: "😀 Before Read this after", [format === "caption" ? "caption_entities" : "entities"]: [{ type: "text_link", offset: 10, length: 9, url: `https://${source}` }] };
    const { sent } = await invoke(t, fields);
    assert.equal(sent[0].text, "@tester wrote: 😀 Before Read this after");
    const entity = sent[0].entities.find(entity => entity.url === target);
    assert.ok(entity);
    assert.equal(sent[0].text.slice(entity.offset, entity.offset + entity.length), "Read this");
  });
}

test("rewrite a shorthand URL-shaped rich label rather than leaving the old hostname visible", async t => {
  const { sent } = await invoke(t, { rich_message: { blocks: [{ type: "paragraph", text: ["Before ", { type: "url", text: source, url: `https://${source}` }, " after"] }] } });
  assert.equal(sent[0].text, `@tester wrote: Before ${target} after`);
});

test("preserve other hyperlinks when one supported link is rewritten", async t => {
  const { sent } = await invoke(t, { text: `Profile ${source} help`, entities: [{ type: "text_link", offset: 0, length: 7, url: "tg://user?id=123" }, { type: "text_link", offset: 29, length: 4, url: "https://example.com/help" }] });
  assert.equal(sent[0].text, `@tester sent: Profile ${target} help`);
  assert.equal(sent[0].entities.find(entity => entity.url === "tg://user?id=123").length, 7);
  assert.equal(sent[0].text.slice(sent[0].entities.find(entity => entity.url === "https://example.com/help").offset), "help");
});

test("rewrite repeated and mixed supported links in order with one response", async t => {
  const { sent, calls } = await invoke(t, { text: `${source} first instagram.com/p/example/ second ${source} third youtu.be/example` });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, `@tester wrote: ${target} first https://oginstagram.com/p/example/ second ${target} third youtu.be/example`);
  assert.deepEqual(calls.filter(call => call.method === "deleteMessage").map(call => call.body.message_id), [11]);
});

test("rewrite YouTube only when mentioned while preserving the comment", async t => {
  const { sent } = await invoke(t, { text: `My take: youtu.be/example @WebSlingerBot` });
  assert.equal(sent[0].text, "@tester wrote: My take: https://y.com.sb/watch?v=example @WebSlingerBot");
});

test("preserve balanced URL brackets that belong to an Instagram query", async t => {
  const { sent } = await invoke(t, { text: "See instagram.com/p/example/?values=[one]" });
  assert.equal(sent[0].text, "@tester wrote: See https://oginstagram.com/p/example/?values=[one]");
});

test("preserve a captured expanded-editor message's full wording", async t => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/expanded-editor-message.json", import.meta.url), "utf8"));
  const { sent } = await invoke(t, fixture);
  assert.equal(sent[0].text, "@tester wrote: For @reader, and @tester  https://fxtwitter.com/0xMarcB/status/2123108720154726784");
});

test("preserve paragraph and list order in rich messages", async t => {
  const { sent } = await invoke(t, { rich_message: { blocks: [
    { type: "heading", text: "My notes" },
    { type: "list", items: [{ label: "1.", blocks: [{ type: "paragraph", text: `${source} first` }] }, { label: "2.", blocks: [{ type: "paragraph", text: "second point" }] }] },
    { type: "paragraph", text: "That's all" },
  ] } });
  assert.equal(sent[0].text, `@tester wrote: My notes\n1. ${target} first\n2. second point\nThat's all`);
});

test("mention the sender by ID when no username exists", async t => {
  const { sent } = await invoke(t, { from: { id: 33, first_name: "Alice 😀" }, text: `${source} thoughts` });
  assert.equal(sent[0].text, `Alice 😀 wrote: ${target} thoughts`);
  const author = sent[0].entities.find(entity => entity.type === "text_mention");
  assert.equal(author.user.id, 33);
  assert.equal(sent[0].text.slice(author.offset, author.offset + author.length), "Alice 😀");
});

test("handle messages with no sender details", async t => {
  const { sent } = await invoke(t, { from: undefined, text: source });
  assert.equal(sent[0].text, `Someone sent: ${target}`);
});

test("attribute anonymous posts to the sender chat rather than the compatibility bot user", async t => {
  const { sent } = await invoke(t, { sender_chat: { id: -100123, title: "The group" }, from: { id: 44, username: "GroupAnonymousBot" }, text: source });
  assert.equal(sent[0].text, `The group sent: ${target}`);
  assert.equal(sent[0].entities.some(entity => entity.type === "text_mention" || entity.type === "mention"), false);
});

test("include a clickable attribution for a username", async t => {
  const { sent } = await invoke(t, { text: source });
  const author = sent[0].entities.find(entity => entity.type === "mention");
  assert.equal(sent[0].text.slice(author.offset, author.offset + author.length), "@tester");
});

for (const [name, fields, expected] of [
  ["shorthand URL", { text: source }, target],
  ["HTTPS URL", { text: `https://${source}` }, target],
  ["caption", { caption: source }, target],
  ["URL entity", { text: source, entities: [{ type: "url", offset: 0, length: source.length }] }, target],
  ["named hyperlink", { text: "Read this", entities: [{ type: "text_link", offset: 0, length: 9, url: `https://${source}` }] }, "Read this"],
  ["rich plaintext", { rich_message: { blocks: [{ type: "paragraph", text: source }] } }, target],
  ["rich URL", { rich_message: { blocks: [{ type: "paragraph", text: { type: "url", text: source, url: `https://${source}` } }] } }, target],
  ["rich named hyperlink", { rich_message: { blocks: [{ type: "paragraph", text: { type: "url", text: "Read this", url: `https://${source}` } }] } }, "Read this"],
  ["surrounding whitespace", { text: ` \n${source}\n ` }, ` \n${target}\n `],
  ["multiple links", { text: `${source}\ninstagram.com/p/example/` }, `${target}\nhttps://oginstagram.com/p/example/`],
]) {
  test(`use sent for link-only ${name}`, async t => {
    const { response, sent, calls } = await invoke(t, fields);
    assert.equal(response.status, 200);
    assert.equal(sent[0].text, `@tester sent: ${expected}`);
    assert.ok(sent[0].entities.some(entity => entity.url === target));
    assert.equal(calls.at(-1).method, "deleteMessage");
  });
}

for (const format of ["text", "caption", "rich"]) {
  test(`use wrote for commentary accompanying a link in ${format}`, async t => {
    const text = `😀 ${source}`;
    const fields = format === "rich" ? { rich_message: { blocks: [{ type: "paragraph", text }] } } : { [format]: text };
    const { sent } = await invoke(t, fields);
    assert.equal(sent[0].text, `@tester wrote: 😀 ${target}`);
  });
}

test("keep replacement messages in the original topic and reply chain", async t => {
  const { sent } = await invoke(t, { text: source, message_thread_id: 77, reply_to_message: { message_id: 66 } });
  assert.equal(sent[0].message_thread_id, 77);
  assert.deepEqual(sent[0].reply_parameters, { message_id: 66, allow_sending_without_reply: true });
});

test("split long content without truncation and delete only after every part is sent", async t => {
  const text = `${"A😀 ".repeat(1800)}${source} end`;
  const { sent, calls, response } = await invoke(t, { text });
  assert.equal(response.status, 200);
  assert.ok(sent.length > 1);
  assert.equal(sent.map(body => body.text).join(""), `@tester wrote: ${text.replace(source, target)}`);
  assert.equal(calls.at(-1).method, "deleteMessage");
  assert.equal(calls.at(-1).body.message_id, 11);
  for (const body of sent) assert.equal(body.text.isWellFormed(), true);
});

test("remove partial replacements and preserve the original on a later send failure", async t => {
  t.mock.method(console, "error", () => {});
  const { response, calls } = await invoke(t, { text: `${"word ".repeat(1000)}${source}` }, { failSend: 2 });
  assert.equal(response.status, 500);
  assert.deepEqual(calls.map(call => call.method), ["sendMessage", "sendMessage", "deleteMessage"]);
  assert.equal(calls.at(-1).body.message_id, 101);
  assert.equal(calls.some(call => call.method === "deleteMessage" && call.body.message_id === 11), false);
});

test("split oversized link labels without losing their targets or Unicode text", () => {
  const text = `😀${"x".repeat(5000)}`;
  const chunks = splitContent({ text, entities: [{ type: "text_link", offset: 0, length: text.length, url: target }] });
  assert.equal(chunks.map(chunk => chunk.text).join(""), text);
  assert.ok(chunks.every(chunk => chunk.text.isWellFormed() && chunk.entities[0].url === target));
});
