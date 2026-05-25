// =============================================================================
// Discord Bot — Pixie by CloutKart
// Stack: discord.js v14+, groq-sdk, mongodb, dotenv
// =============================================================================

import { Client, GatewayIntentBits, Events, ActivityType, PermissionFlagsBits } from "discord.js";
import Groq from "groq-sdk";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// SECTION 1: VALIDATE ENV
// =============================================================================

const { DISCORD_TOKEN, GROQ_API_KEY, MONGODB_URI, BOT_OWNER_ID } = process.env;

if (!DISCORD_TOKEN || !GROQ_API_KEY || !MONGODB_URI) {
  console.error("[FATAL] Missing DISCORD_TOKEN, GROQ_API_KEY, or MONGODB_URI in .env");
  process.exit(1);
}

if (!BOT_OWNER_ID) {
  console.warn("[WARN] BOT_OWNER_ID not set — only server admins will be able to use !teach");
}

// =============================================================================
// SECTION 2: MONGODB SETUP
// =============================================================================

let knowledgeCollection;

async function connectMongo() {
  const mongo = new MongoClient(MONGODB_URI);
  await mongo.connect();
  const db = mongo.db("pixie");
  knowledgeCollection = db.collection("knowledge");
  // Index for fast full-text search on the 'fact' field
  await knowledgeCollection.createIndex({ fact: "text" });
  // Index for looking up by topic tag
  await knowledgeCollection.createIndex({ topic: 1 });
  console.log("[MongoDB] Connected and indexes ensured.");
}

/**
 * Save a new fact to MongoDB.
 * Each entry: { fact, topic, addedBy, addedAt }
 */
async function saveFact(fact, topic, addedBy) {
  await knowledgeCollection.insertOne({
    fact,
    topic:   topic || "general",
    addedBy,
    addedAt: new Date(),
  });
}

/**
 * Delete a fact by its 1-based index in the full list.
 * Returns true if something was deleted.
 */
async function deleteFact(index) {
  const all = await knowledgeCollection.find({}).sort({ addedAt: 1 }).toArray();
  const target = all[index - 1];
  if (!target) return false;
  await knowledgeCollection.deleteOne({ _id: target._id });
  return true;
}

/**
 * Fetch all stored facts as plain strings for injection into the system prompt.
 */
async function getAllFacts() {
  const docs = await knowledgeCollection.find({}).sort({ addedAt: 1 }).toArray();
  return docs.map(d => `[${d.topic}] ${d.fact}`);
}

/**
 * Fetch facts filtered by topic tag.
 */
async function getFactsByTopic(topic) {
  const docs = await knowledgeCollection
    .find({ topic: { $regex: new RegExp(topic, "i") } })
    .sort({ addedAt: 1 })
    .toArray();
  return docs.map(d => `[${d.topic}] ${d.fact}`);
}

// =============================================================================
// SECTION 3: GROQ + MODELS
// =============================================================================

const groq = new Groq({ apiKey: GROQ_API_KEY });

const TEXT_MODEL   = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

const TOKEN_LIMIT          = 12000;
const REPLY_BUFFER         = 1200;
const SYSTEM_PROMPT_TOKENS = 950;
const MAX_HISTORY_TOKENS   = TOKEN_LIMIT - REPLY_BUFFER - SYSTEM_PROMPT_TOKENS;

const BASE_SYSTEM_PROMPT = `You are Pixie — the AI assistant and creative intelligence behind CloutKart.

## Who You Are
You were built by Shivam Bailwal, co-founder of CloutKart. You represent the CloutKart brand in every conversation — warm, sharp, and genuinely excited about helping brands grow through better creative.

You're not a cold chatbot. You're like that brilliant friend on the team who actually gets marketing, knows the creative game inside out, and genuinely wants to help. You make people feel heard, understood, and excited about what's possible.

## CloutKart — The Brand You Represent
**Tagline:** CloutKart helps brands find the winning message and turn it into high-converting creative.

**Mission:** We build premium, AI-powered ads and creative systems made to stop scrolls and drive action. We're not just making pretty visuals — we're building creative that converts.

**Founders:** Shivam Bailwal, Rounak Shrivastava, and Adhiraj Singh.

**Website:** https://www.clout-kart.com/
**Inquiries:** inquiry@clout-kart.com

## What CloutKart Does
CloutKart is a premium AI creative studio. Our services include:
- **AI Ad Images** — scroll-stopping visuals built for performance
- **Short-Form Video Ad Concepts** — concepts and scripts for Reels, TikTok, YouTube Shorts
- **Ad Copy & Hooks** — high-converting copy that grabs attention in the first second
- **Creative Strategy** — message-first thinking before a single pixel is made
- **Campaign Ideation** — full concept packs built around a core message
- **Social Media Ad Creatives** — platform-native creative for Meta, TikTok, Google
- **Landing Page Headline Direction** — copy that keeps people from bouncing
- **Concept Packs for Testing** — multiple creative angles to find your winner fast
- **UGC-Style Ad Ideas** — authentic-feeling content concepts that perform
- **Brand Visual Direction** — campaign-level aesthetic direction for launches and pushes

## Who We Work With
- D2C and e-commerce brands
- Supplement, wellness, and health brands
- Beauty and skincare brands
- Fashion and lifestyle brands
- Small to mid-sized businesses that want better-performing ads
- Founders and growth marketers who need creative that actually converts
- Agencies that need creative support or concept production at scale

## Your Personality
- **Warm and genuine** — you actually care. You ask follow-up questions. You celebrate people's ideas. You make them feel like they're talking to someone who gets it.
- **Premium but approachable** — polished, never stiff. Think luxury brand with a human heartbeat.
- **Cinematic and creative** — your language is vivid and intentional. You don't say "good idea", you say "that's a strong angle."
- **Slightly Gen Z energy** — modern, culturally aware, never sounds like a corporate press release.
- **Conversion-minded** — you always think about what drives action.
- **Honest** — if you don't know something, say so. No fluff, no hallucinations.

## How You Communicate
- Use Discord Markdown: **bold**, *italics*, and code blocks where relevant.
- Keep responses punchy and scannable — short paragraphs, line breaks, occasional lists.
- Never open with "Certainly!", "Of course!", "Absolutely!", "Great!" or hollow filler.
- Match the user's energy — if they're excited, be excited. If they're stuck, be calm and solutions-focused.
- Ask one good follow-up question when it would help you give a better answer.

## What You Always Do
Whenever it naturally fits, guide people toward:
1. **The CloutKart website** → https://www.clout-kart.com/
2. **The 3 free creatives offer** — mention this for anyone curious about trying CloutKart
3. **A creative audit or concept pack** — great for brands feeling stuck or inconsistent
4. **Reaching out directly** → inquiry@clout-kart.com
5. **Booking a discovery call** — for anyone who sounds like a serious fit

Never be pushy. Weave it in naturally — be helpful first, let the CTA feel like the obvious next step.

## What You Know
- Performance marketing, D2C growth, creative testing, Meta and TikTok ads, hooks, UGC, and brand strategy.
- You can brainstorm ad hooks, review creative concepts, suggest campaign angles, explain what makes an ad convert, or vibe on brand direction.
- If someone shares their brand or product, treat it like a creative brief and bring real ideas.
- You never pretend to be human. If asked: "Yep, I'm Pixie — CloutKart's AI assistant. Built by Shivam. Powered by good taste."`;

/**
 * Builds the full system prompt by appending any learned facts from MongoDB.
 * Facts are injected as a clearly labelled section so Pixie treats them
 * as authoritative knowledge.
 */
async function buildSystemPrompt() {
  const facts = await getAllFacts();
  if (facts.length === 0) return BASE_SYSTEM_PROMPT;

  const knowledgeBlock = facts
    .map((f, i) => `${i + 1}. ${f}`)
    .join("\n");

  return (
    BASE_SYSTEM_PROMPT +
    `\n\n## What You've Been Taught (Treat as Ground Truth)\nThe following facts were added by CloutKart admins. Always use them when relevant:\n${knowledgeBlock}`
  );
}

// =============================================================================
// SECTION 4: TOKEN ESTIMATION
// =============================================================================

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function messageTokens(msg) {
  return estimateTokens(contentToString(msg.content)) + 4;
}

// =============================================================================
// SECTION 5: CONVERSATION HISTORY
// =============================================================================

const userHistories = new Map();

function getHistory(userId) {
  if (!userHistories.has(userId)) {
    console.log(`[Chat] New session for ${userId}`);
    userHistories.set(userId, []);
  }
  return userHistories.get(userId);
}

function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === "text")
      .map(p => p.text || "")
      .join(" ")
      .trim() || "[image]";
  }
  return String(content);
}

function pushToHistory(userId, userContent, assistantText) {
  const h = getHistory(userId);
  h.push({ role: "user",      content: contentToString(userContent) });
  h.push({ role: "assistant", content: assistantText                 });
  while (h.length > 60) h.splice(0, 2);
}

function sanitizeHistory(messages) {
  return messages.map(m => ({
    role:    m.role,
    content: contentToString(m.content),
  }));
}

function buildTokenSafeMessages(systemPrompt, history, newUserContent) {
  const newUserMsg    = { role: "user", content: contentToString(newUserContent) };
  const newUserTokens = messageTokens(newUserMsg);
  const sysTokens     = estimateTokens(systemPrompt) + 4;
  let budget = TOKEN_LIMIT - REPLY_BUFFER - sysTokens - newUserTokens;

  const keptHistory = [];
  for (let i = history.length - 1; i >= 1; i -= 2) {
    const assistantMsg = history[i];
    const userMsg      = history[i - 1];
    if (!assistantMsg || !userMsg) break;
    const pairTokens = messageTokens(userMsg) + messageTokens(assistantMsg);
    if (pairTokens > budget) {
      console.log(`[Tokens] Trimmed history at turn ${Math.floor(i / 2)} to stay under limit.`);
      break;
    }
    budget -= pairTokens;
    keptHistory.unshift(assistantMsg);
    keptHistory.unshift(userMsg);
  }

  const totalEstimate = sysTokens + keptHistory.reduce((s, m) => s + messageTokens(m), 0) + newUserTokens;
  console.log(`[Tokens] ~${totalEstimate} input tokens | ${keptHistory.length / 2} history turns kept`);

  return [
    { role: "system", content: systemPrompt },
    ...keptHistory,
    newUserMsg,
  ];
}

// =============================================================================
// SECTION 6: GROQ API CALL
// =============================================================================

async function askGroq(history, hasImages, rawUserContent) {
  if (hasImages) {
    const systemPrompt = await buildSystemPrompt();
    console.log(`[Groq] model=${VISION_MODEL} (vision, single-turn)`);
    const res = await groq.chat.completions.create({
      model:       VISION_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: rawUserContent },
      ],
      max_tokens:  1200,
      temperature: 0.7,
    });
    const text = res.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from Groq (vision).");
    return text;
  }

  const systemPrompt = await buildSystemPrompt();
  const messages     = buildTokenSafeMessages(systemPrompt, history, rawUserContent);
  const sanitized    = sanitizeHistory(messages);

  console.log(`[Groq] model=${TEXT_MODEL} messages=${sanitized.length}`);

  const res = await groq.chat.completions.create({
    model:       TEXT_MODEL,
    messages:    sanitized,
    max_tokens:  1200,
    temperature: 0.7,
  });
  const text = res.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty response from Groq (text).");
  return text;
}

// =============================================================================
// SECTION 7: PERMISSION HELPERS
// =============================================================================

/**
 * Returns true if the message author is allowed to use admin commands.
 * Allowed if: they are the BOT_OWNER_ID, OR they have the Administrator
 * or ManageGuild permission in the current server.
 */
function isAuthorized(message) {
  if (BOT_OWNER_ID && message.author.id === BOT_OWNER_ID) return true;
  if (!message.member) return false; // DM with no guild context
  return (
    message.member.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

// =============================================================================
// SECTION 8: HELPERS
// =============================================================================

const SUPPORTED_IMAGES = new Set(["image/jpeg","image/png","image/webp","image/gif"]);

async function fetchImagePart(url, mimeType) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image fetch failed: ${r.status}`);
  const base64 = Buffer.from(await r.arrayBuffer()).toString("base64");
  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${base64}` },
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
// SECTION 9: DISCORD CLIENT
// =============================================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`\n✅ Pixie is online! (${c.user.tag})`);
  console.log(`   Guilds:       ${c.guilds.cache.size}`);
  console.log(`   Text model:   ${TEXT_MODEL}`);
  console.log(`   Vision model: ${VISION_MODEL}`);
  console.log(`   Owner ID:     ${BOT_OWNER_ID || "not set"}\n`);
  c.user.setActivity("CloutKart | AI Creatives", { type: ActivityType.Watching });
});

// =============================================================================
// SECTION 10: MESSAGE HANDLER
// =============================================================================

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const prompt = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  const cmd = prompt.toLowerCase();

  // ── !help ──────────────────────────────────────────────────────────────────
  if (cmd.startsWith("!help")) {
    const adminSection = isAuthorized(message)
      ? "\n**Admin Commands**\n" +
        "`!teach <fact>` — teach Pixie a new fact\n" +
        "`!teach topic:<tag> <fact>` — teach with a topic tag (e.g. `topic:pricing`)\n" +
        "`!knowledge` — list everything Pixie has been taught\n" +
        "`!knowledge topic:<tag>` — filter by topic\n" +
        "`!forget <number>` — remove a fact by its list number\n"
      : "";

    return message.reply(
      "**Hey! I'm Pixie 👋 — CloutKart's AI creative assistant.**\n\n" +
      "I can help you with ad concepts, hooks, creative strategy, campaign ideas, and more.\n\n" +
      "**Commands**\n" +
      "`!reset` — clear our conversation history\n" +
      "`!help` — show this message\n" +
      adminSection +
      "\nOr just talk to me — mention me and ask anything.\n\n" +
      "🌐 **www.clout-kart.com** | ✉️ inquiry@clout-kart.com"
    );
  }

  // ── !reset ─────────────────────────────────────────────────────────────────
  if (cmd.startsWith("!reset")) {
    userHistories.delete(message.author.id);
    console.log(`[Chat] Reset for ${message.author.id}`);
    return message.reply("🔄 Conversation cleared! Fresh start ✨");
  }

  // ── !teach ─────────────────────────────────────────────────────────────────
  // Usage:  !teach <fact>
  //         !teach topic:<tag> <fact>
  if (cmd.startsWith("!teach")) {
    if (!isAuthorized(message)) {
      return message.reply("🔒 Only server admins or the bot owner can teach Pixie new things.");
    }

    let body = prompt.slice("!teach".length).trim();
    if (!body) {
      return message.reply(
        "**Usage:**\n" +
        "`!teach <fact>` — e.g. `!teach Our cheapest plan is $49/month`\n" +
        "`!teach topic:<tag> <fact>` — e.g. `!teach topic:pricing Our cheapest plan is $49/month`"
      );
    }

    let topic = "general";
    const topicMatch = body.match(/^topic:(\S+)\s+([\s\S]+)$/i);
    if (topicMatch) {
      topic = topicMatch[1].toLowerCase();
      body  = topicMatch[2].trim();
    }

    await saveFact(body, topic, message.author.tag);
    console.log(`[Teach] "${body}" (topic: ${topic}) added by ${message.author.tag}`);
    return message.reply(`✅ Got it! I've learned:\n> **[${topic}]** ${body}`);
  }

  // ── !knowledge ─────────────────────────────────────────────────────────────
  // Usage:  !knowledge
  //         !knowledge topic:<tag>
  if (cmd.startsWith("!knowledge")) {
    if (!isAuthorized(message)) {
      return message.reply("🔒 Only server admins or the bot owner can view Pixie's knowledge base.");
    }

    const topicFilter = prompt.match(/topic:(\S+)/i)?.[1];
    const facts = topicFilter
      ? await getFactsByTopic(topicFilter)
      : await getAllFacts();

    if (facts.length === 0) {
      return message.reply(
        topicFilter
          ? `No facts found for topic \`${topicFilter}\`.`
          : "I haven't been taught anything yet. Use `!teach` to add facts."
      );
    }

    const header = topicFilter
      ? `📚 **Pixie's knowledge — topic: \`${topicFilter}\`** (${facts.length} facts)\n\n`
      : `📚 **Pixie's full knowledge base** (${facts.length} facts)\n\n`;

    const list = facts.map((f, i) => `**${i + 1}.** ${f}`).join("\n");
    const chunks = chunkText(header + list);
    for (let i = 0; i < chunks.length; i++) {
      await (i === 0 ? message.reply(chunks[i]) : message.channel.send(chunks[i]));
    }
    return;
  }

  // ── !forget ────────────────────────────────────────────────────────────────
  // Usage:  !forget <number>
  if (cmd.startsWith("!forget")) {
    if (!isAuthorized(message)) {
      return message.reply("🔒 Only server admins or the bot owner can remove facts.");
    }

    const num = parseInt(prompt.split(/\s+/)[1], 10);
    if (isNaN(num) || num < 1) {
      return message.reply("**Usage:** `!forget <number>` — use `!knowledge` to find the number.");
    }

    const deleted = await deleteFact(num);
    if (!deleted) {
      return message.reply(`❌ No fact found at position **${num}**. Use \`!knowledge\` to check the list.`);
    }
    console.log(`[Forget] Fact #${num} removed by ${message.author.tag}`);
    return message.reply(`🗑️ Fact **#${num}** has been removed from my knowledge base.`);
  }

  // ── Empty message guard ────────────────────────────────────────────────────
  if (!prompt && message.attachments.size === 0) {
    return message.reply("Hey! Ask me something or attach an image — I'm here 🙌");
  }

  // ── Typing indicator ───────────────────────────────────────────────────────
  let typing;
  try {
    await message.channel.sendTyping();
    typing = setInterval(() => message.channel.sendTyping(), 8000);
  } catch { /* non-critical */ }

  const done = () => clearInterval(typing);

  try {
    // ── Build user content ───────────────────────────────────────────────────
    let userContent;
    let hasImages = false;

    if (message.attachments.size > 0) {
      const parts = [{ type: "text", text: prompt || "Describe this image in detail." }];

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

      if (!hasImages && !prompt) { done(); return; }
      userContent = parts;
    } else {
      userContent = prompt;
    }

    // ── Call Groq ────────────────────────────────────────────────────────────
    const history = getHistory(message.author.id);
    console.log(`[Groq] ${message.author.tag} | stored turns=${history.length / 2} images=${hasImages}`);

    const reply = await askGroq(history, hasImages, userContent);
    pushToHistory(message.author.id, userContent, reply);
    done();

    const chunks = chunkText(reply);
    for (let i = 0; i < chunks.length; i++) {
      await (i === 0 ? message.reply(chunks[i]) : message.channel.send(chunks[i]));
    }

  } catch (err) {
    done();
    console.error(`[Error] ${message.author.tag}:`, err);

    let msg = "❌ Something went wrong. Please try again.";
    if (err?.status === 429)                      msg = "⏳ Rate limited — wait a moment and try again.";
    if (err?.status === 401)                      msg = "❌ Bad API key — contact the bot admin.";
    if (err?.status === 503)                      msg = "🔧 Groq is overloaded — try again in a few seconds.";
    if (err?.message?.includes("decommissioned")) msg = "❌ Model retired — contact the bot admin to update.";
    if (err?.message?.includes("Image fetch"))    msg = "❌ Couldn't download your image. Try re-uploading it.";
    if (err?.code === 50013)                      msg = "❌ Missing permission to send messages here.";

    try { await message.reply(msg); } catch { /* already logged */ }
  }
});

// =============================================================================
// SECTION 11: PROCESS SAFETY
// =============================================================================

process.on("unhandledRejection", (r) => console.error("[Process] Unhandled rejection:", r));
process.on("uncaughtException",  (e) => console.error("[Process] Uncaught exception:",  e));

// =============================================================================
// SECTION 12: BOOT
// =============================================================================

console.log("🚀 Starting Pixie...");
connectMongo()
  .then(() => client.login(DISCORD_TOKEN))
  .catch((err) => {
    console.error("[FATAL] MongoDB connection failed:", err);
    process.exit(1);
  });
