// =============================================================================
// Discord Bot Powered by Groq API
// Stack: discord.js v14+, groq-sdk, dotenv
// =============================================================================

import { Client, GatewayIntentBits, Events, ActivityType } from "discord.js";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// SECTION 1: VALIDATE ENVIRONMENT VARIABLES
// =============================================================================

const { DISCORD_TOKEN, GROQ_API_KEY } = process.env;

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error("[FATAL] Missing DISCORD_TOKEN or GROQ_API_KEY in .env file.");
  process.exit(1);
}

// =============================================================================
// SECTION 2: GROQ CLIENT + MODELS
// =============================================================================

const groq = new Groq({ apiKey: GROQ_API_KEY });

const TEXT_MODEL   = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const SYSTEM_PROMPT = `You are "Axiom", a highly intelligent, slightly witty AI assistant living inside Discord.
- Be direct and concise, but elaborate when the topic demands it.
- Use dry humor sparingly and only when appropriate.
- If you don't know something, say so. Never hallucinate facts.
- Format all responses with Discord Markdown: **bold**, *italics*, \`code\`, code blocks with language tags.
- Never open with "Certainly!", "Of course!", "Absolutely!", "Great!", or similar filler phrases.
- Treat users as intelligent adults.`;

// =============================================================================
// SECTION 3: PER-USER CONVERSATION HISTORY
// Map<userId, Array<{role, content}>>
// The system prompt is always index 0 and never removed.
// =============================================================================

const userHistories = new Map();

function getHistory(userId) {
  if (!userHistories.has(userId)) {
    console.log(`[Chat] New session for user ${userId}`);
    userHistories.set(userId, [
      { role: "system", content: SYSTEM_PROMPT },
    ]);
  }
  return userHistories.get(userId);
}

function pushToHistory(userId, userContent, assistantText) {
  const h = getHistory(userId);
  h.push({ role: "user",      content: userContent    });
  h.push({ role: "assistant", content: assistantText  });
  // Cap at system prompt + 19 turns (40 total entries)
  while (h.length > 40) h.splice(1, 2);
}

// =============================================================================
// SECTION 4: GROQ API CALL
// =============================================================================

async function askGroq(messages, hasImages) {
  const model = hasImages ? VISION_MODEL : TEXT_MODEL;
  console.log(`[Groq] model=${model} messages=${messages.length}`);

  const res = await groq.chat.completions.create({
    model,
    messages,
    max_tokens:  8192,
    temperature: 0.7,
  });

  const text = res.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty response from Groq.");
  return text;
}

// =============================================================================
// SECTION 5: HELPERS
// =============================================================================

const SUPPORTED_IMAGES = new Set(["image/jpeg","image/png","image/webp","image/gif"]);

async function fetchImagePart(url, mimeType) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${buf.toString("base64")}` },
  };
}

function chunkText(text, max = 1990) {
  if (text.length <= max) return [text];
  const out = [];
  let s = text;
  while (s.length > max) {
    let i = s.lastIndexOf("\n", max);
    if (i < max * 0.5) i = s.lastIndexOf(" ", max);
    if (i < max * 0.5) i = max;
    out.push(s.slice(0, i).trimEnd());
    s = s.slice(i).trimStart();
  }
  if (s) out.push(s);
  return out;
}

// =============================================================================
// SECTION 6: DISCORD CLIENT
// =============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // Privileged — enable in Dev Portal
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`\n✅ ${c.user.tag} is online (${c.guilds.cache.size} guild(s))`);
  console.log(`   Text:   ${TEXT_MODEL}`);
  console.log(`   Vision: ${VISION_MODEL}\n`);
  c.user.setActivity("your prompts | Groq", { type: ActivityType.Watching });
});

// =============================================================================
// SECTION 7: MESSAGE HANDLER
// =============================================================================

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and messages that don't mention us
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  // Strip our mention and clean whitespace
  const prompt = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  const cmd = prompt.toLowerCase();

  // ── Commands ─────────────────────────────────────────────────────────────
  if (cmd.startsWith("!reset")) {
    userHistories.delete(message.author.id);
    console.log(`[Chat] Reset for ${message.author.id}`);
    return message.reply("🔄 Conversation cleared. Starting fresh!");
  }

  if (cmd.startsWith("!help")) {
    return message.reply(
      "**Axiom · Help**\n\n" +
      "Mention me to chat. You can also attach an image.\n\n" +
      "**Commands**\n" +
      "`!reset` — clear your conversation history\n" +
      "`!help`  — show this message\n\n" +
      `Models: \`${TEXT_MODEL}\` · \`${VISION_MODEL}\``
    );
  }

  // Require at least a prompt or an attachment
  if (!prompt && message.attachments.size === 0) {
    return message.reply("Hey! Ask me something or attach an image.");
  }

  // ── Typing indicator ──────────────────────────────────────────────────────
  let typing;
  try {
    await message.channel.sendTyping();
    typing = setInterval(() => message.channel.sendTyping(), 8000);
  } catch { /* non-critical */ }

  const done = () => clearInterval(typing);

  try {
    // ── Build user content ──────────────────────────────────────────────────
    let userContent;
    let hasImages = false;

    if (message.attachments.size > 0) {
      const parts = [{
        type: "text",
        text: prompt || "Describe this image in detail.",
      }];

      for (const [, att] of message.attachments) {
        const mime = att.contentType?.split(";")[0];
        if (!SUPPORTED_IMAGES.has(mime)) {
          await message.reply(`⚠️ Skipped \`${att.name}\` — unsupported type \`${mime || "unknown"}\`.`);
          continue;
        }
        console.log(`[Vision] Fetching ${att.name} (${mime})`);
        parts.push(await fetchImagePart(att.url, mime));
        hasImages = true;
      }

      // If every attachment was invalid and there's no text, bail
      if (!hasImages && !prompt) { done(); return; }
      userContent = parts;

    } else {
      userContent = prompt;
    }

    // ── Build full message list and call Groq ───────────────────────────────
    // We snapshot the current history + the new user turn.
    // We do NOT write to history until we have a successful response,
    // preventing a corrupt history on error.
    const history  = getHistory(message.author.id);
    const apiMsgs  = [...history, { role: "user", content: userContent }];

    console.log(`[Groq] ${message.author.tag} | history=${history.length} images=${hasImages}`);

    const reply = await askGroq(apiMsgs, hasImages);

    // Only now do we commit the exchange to history
    pushToHistory(message.author.id, userContent, reply);

    done();

    // ── Send response ───────────────────────────────────────────────────────
    const chunks = chunkText(reply);
    console.log(`[Discord] ${chunks.length} chunk(s) → ${message.author.tag}`);

    for (let i = 0; i < chunks.length; i++) {
      await (i === 0 ? message.reply(chunks[i]) : message.channel.send(chunks[i]));
    }

  } catch (err) {
    done();
    console.error(`[Error] ${message.author.tag}:`, err);

    let msg = "❌ Something went wrong. Please try again.";
    if (err?.status === 429)  msg = "⏳ Rate limited by Groq — wait a moment and try again.";
    if (err?.status === 401)  msg = "❌ Bad API key — contact the bot admin.";
    if (err?.status === 503)  msg = "🔧 Groq is overloaded — try again in a few seconds.";
    if (err?.message?.includes("decommissioned")) msg = "❌ Model retired — contact the bot admin to update.";
    if (err?.message?.includes("Image fetch"))    msg = "❌ Couldn't download your image. Try re-uploading it.";
    if (err?.code === 50013)                      msg = "❌ Missing permission to send messages here.";

    try { await message.reply(msg); } catch { /* already logged */ }
  }
});

// =============================================================================
// SECTION 8: PROCESS SAFETY
// =============================================================================

process.on("unhandledRejection", (r) => console.error("[Process] Unhandled rejection:", r));
process.on("uncaughtException",  (e) => console.error("[Process] Uncaught exception:",  e));

// =============================================================================
// SECTION 9: LOGIN
// =============================================================================

console.log("🚀 Starting...");
client.login(DISCORD_TOKEN);
