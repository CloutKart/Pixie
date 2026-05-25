// =============================================================================
// Discord Bot — Pixie by CloutKart
// Stack: discord.js v14+, groq-sdk, dotenv
// =============================================================================

import { Client, GatewayIntentBits, Events, ActivityType } from "discord.js";
import Groq from "groq-sdk";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// SECTION 1: VALIDATE ENV
// =============================================================================

const { DISCORD_TOKEN, GROQ_API_KEY } = process.env;

if (!DISCORD_TOKEN || !GROQ_API_KEY) {
  console.error("[FATAL] Missing DISCORD_TOKEN or GROQ_API_KEY in .env");
  process.exit(1);
}

// =============================================================================
// SECTION 2: GROQ + MODELS
// =============================================================================

const groq = new Groq({ apiKey: GROQ_API_KEY });

const TEXT_MODEL   = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

// Token budget — keep total well under Groq's 12,000 TPM limit.
// System prompt (~900 tokens) + reply buffer (1,200) + history = MAX_HISTORY_TOKENS.
const TOKEN_LIMIT         = 12000;
const REPLY_BUFFER        = 1200;  // headroom for the model's reply
const SYSTEM_PROMPT_TOKENS = 950;  // rough estimate for the system prompt below
const MAX_HISTORY_TOKENS  = TOKEN_LIMIT - REPLY_BUFFER - SYSTEM_PROMPT_TOKENS;
// ≈ 9,850 tokens available for history + new user message

const SYSTEM_PROMPT = `You are Pixie — the AI assistant and creative intelligence behind CloutKart.

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

// =============================================================================
// SECTION 3: TOKEN ESTIMATION
// =============================================================================

/**
 * Fast, conservative token estimator (~4 chars per token).
 * Slightly over-estimates to stay safely under the limit.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5); // conservative: ~3.5 chars/token
}

/**
 * Returns the estimated token cost of a single message object.
 */
function messageTokens(msg) {
  return estimateTokens(contentToString(msg.content)) + 4; // +4 for role/overhead
}

// =============================================================================
// SECTION 4: CONVERSATION HISTORY
// Map<userId, Array<{role, content}>>
// IMPORTANT: content is ALWAYS stored as a plain string.
// Array content (from vision messages) is flattened to text before storing.
// This prevents the "messages[N].content must be a string" Groq error.
// =============================================================================

const userHistories = new Map();

function getHistory(userId) {
  if (!userHistories.has(userId)) {
    console.log(`[Chat] New session for ${userId}`);
    userHistories.set(userId, []); // system prompt is injected at call time
  }
  return userHistories.get(userId);
}

/**
 * Extracts a plain string from any content value.
 * Handles: string, array of parts (vision messages), or anything else.
 */
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
  // Hard cap: never store more than 30 turns (60 messages) regardless of tokens
  while (h.length > 60) h.splice(0, 2);
}

/**
 * Sanitizes a history array before sending to Groq.
 * Ensures every message's content is a plain string.
 */
function sanitizeHistory(messages) {
  return messages.map(m => ({
    role:    m.role,
    content: contentToString(m.content),
  }));
}

/**
 * Builds the final messages array for a Groq text call.
 *
 * Strategy:
 *  1. Always include the system prompt.
 *  2. Always include the latest user message.
 *  3. Fill remaining token budget with the most recent history pairs,
 *     working backwards until we'd exceed MAX_HISTORY_TOKENS.
 *
 * This guarantees the request never exceeds TOKEN_LIMIT regardless of
 * how long the conversation history has grown.
 */
function buildTokenSafeMessages(history, newUserContent) {
  const newUserMsg   = { role: "user", content: contentToString(newUserContent) };
  const newUserTokens = messageTokens(newUserMsg);

  let budget = MAX_HISTORY_TOKENS - newUserTokens;
  const keptHistory = [];

  // Walk backwards through stored history, keeping pairs that fit
  for (let i = history.length - 1; i >= 1; i -= 2) {
    const assistantMsg = history[i];
    const userMsg      = history[i - 1];
    if (!assistantMsg || !userMsg) break;

    const pairTokens = messageTokens(userMsg) + messageTokens(assistantMsg);
    if (pairTokens > budget) {
      console.log(`[Tokens] Trimmed ${(history.length - 1 - i) / 2 + 1}+ old turns to stay under limit.`);
      break;
    }
    budget -= pairTokens;
    keptHistory.unshift(assistantMsg);
    keptHistory.unshift(userMsg);
  }

  const totalEstimate = SYSTEM_PROMPT_TOKENS + keptHistory.reduce((s, m) => s + messageTokens(m), 0) + newUserTokens;
  console.log(`[Tokens] Estimated input tokens: ~${totalEstimate} | History turns kept: ${keptHistory.length / 2}`);

  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...keptHistory,
    newUserMsg,
  ];
}

// =============================================================================
// SECTION 5: GROQ API CALL
// =============================================================================

async function askGroq(history, hasImages, rawUserContent) {
  if (hasImages) {
    // Vision call — single turn, array content is fine here
    console.log(`[Groq] model=${VISION_MODEL} (vision, single-turn)`);
    const res = await groq.chat.completions.create({
      model:       VISION_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: rawUserContent },
      ],
      max_tokens:  1200,
      temperature: 0.7,
    });
    const text = res.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from Groq (vision).");
    return text;
  }

  // Build token-safe message array from history + new message
  const messages  = buildTokenSafeMessages(history, rawUserContent);
  const sanitized = sanitizeHistory(messages);

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
// SECTION 6: HELPERS
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
// SECTION 7: DISCORD CLIENT
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
  console.log(`   Guilds: ${c.guilds.cache.size}`);
  console.log(`   Text:   ${TEXT_MODEL}`);
  console.log(`   Vision: ${VISION_MODEL}`);
  console.log(`   Token budget for history: ~${MAX_HISTORY_TOKENS}\n`);
  c.user.setActivity("CloutKart | AI Creatives", { type: ActivityType.Watching });
});

// =============================================================================
// SECTION 8: MESSAGE HANDLER
// =============================================================================

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user)) return;

  const prompt = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .trim();

  const cmd = prompt.toLowerCase();

  // ── Commands ──────────────────────────────────────────────────────────────
  if (cmd.startsWith("!reset")) {
    userHistories.delete(message.author.id);
    console.log(`[Chat] Reset for ${message.author.id}`);
    return message.reply("🔄 Conversation cleared! Fresh start ✨");
  }

  if (cmd.startsWith("!help")) {
    return message.reply(
      "**Hey! I'm Pixie 👋 — CloutKart's AI creative assistant.**\n\n" +
      "I can help you with ad concepts, hooks, creative strategy, campaign ideas, and more.\n\n" +
      "**Commands**\n" +
      "`!reset` — clear our conversation history\n" +
      "`!help` — show this message\n\n" +
      "Or just talk to me — mention me and ask anything.\n\n" +
      "🌐 **www.clout-kart.com** | ✉️ inquiry@clout-kart.com"
    );
  }

  if (!prompt && message.attachments.size === 0) {
    return message.reply("Hey! Ask me something or attach an image — I'm here 🙌");
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

      if (!hasImages && !prompt) { done(); return; }
      userContent = parts;
    } else {
      userContent = prompt;
    }

    // ── Get history and call Groq ───────────────────────────────────────────
    const history = getHistory(message.author.id);

    console.log(`[Groq] ${message.author.tag} | stored turns=${history.length / 2} images=${hasImages}`);

    const reply = await askGroq(history, hasImages, userContent);

    // Commit to history as plain strings only
    pushToHistory(message.author.id, userContent, reply);

    done();

    // ── Send response ───────────────────────────────────────────────────────
    const chunks = chunkText(reply);
    for (let i = 0; i < chunks.length; i++) {
      await (i === 0 ? message.reply(chunks[i]) : message.channel.send(chunks[i]));
    }

  } catch (err) {
    done();
    console.error(`[Error] ${message.author.tag}:`, err);

    let msg = "❌ Something went wrong. Please try again.";
    if (err?.status === 429)                               msg = "⏳ Rate limited — wait a moment and try again.";
    if (err?.status === 401)                               msg = "❌ Bad API key — contact the bot admin.";
    if (err?.status === 503)                               msg = "🔧 Groq is overloaded — try again in a few seconds.";
    if (err?.message?.includes("decommissioned"))          msg = "❌ Model retired — contact the bot admin to update.";
    if (err?.message?.includes("Image fetch"))             msg = "❌ Couldn't download your image. Try re-uploading it.";
    if (err?.code === 50013)                               msg = "❌ Missing permission to send messages here.";

    try { await message.reply(msg); } catch { /* already logged */ }
  }
});

// =============================================================================
// SECTION 9: PROCESS SAFETY
// =============================================================================

process.on("unhandledRejection", (r) => console.error("[Process] Unhandled rejection:", r));
process.on("uncaughtException",  (e) => console.error("[Process] Uncaught exception:",  e));

// =============================================================================
// SECTION 10: LOGIN
// =============================================================================

console.log("🚀 Starting Pixie...");
client.login(DISCORD_TOKEN);
