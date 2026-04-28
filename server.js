/**
 * Facebook Messenger AI Chatbot — Powered by Claude
 *
 * When someone messages your Facebook Page, Claude AI automatically
 * reads the full conversation history and replies on its own.
 * No manual input needed.
 */

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  PAGE_ACCESS_TOKEN,
  VERIFY_TOKEN,
  ANTHROPIC_API_KEY,
  BOT_NAME = "Assistant",
  BOT_PERSONA = "You are a helpful, friendly assistant. Respond naturally and conversationally. Keep replies concise unless the user asks for detail.",
  PORT = 3000,
} = process.env;

// ── AI client ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY || "placeholder" });

// ── Per-user conversation history (Map<senderId, Message[]>) ──────────────────
const conversationHistory = new Map();
const MAX_HISTORY = 20;

// ── Dashboard message log ─────────────────────────────────────────────────────
const messageLog = [];

// ── Generate AI reply using Claude ───────────────────────────────────────────
async function getAIReply(senderId, userMessage) {
  if (!conversationHistory.has(senderId)) {
    conversationHistory.set(senderId, []);
  }
  const history = conversationHistory.get(senderId);

  history.push({ role: "user", content: userMessage });

  // Trim to avoid token overflow
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: BOT_PERSONA,
    messages: history,
  });

  const reply = response.content[0].text.trim();
  history.push({ role: "assistant", content: reply });

  return reply;
}

// ── Webhook verification ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ── Receive & auto-reply to messages ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender.id;
      const userText = event.message.text;
      if (!userText) continue;

      console.log(`📨 [${senderId}] "${userText}"`);
      messageLog.push({ direction: "in", senderId, text: userText, timestamp: new Date().toISOString() });

      await sendTypingOn(senderId);

      try {
        const reply = await getAIReply(senderId, userText);
        await sendMessage(senderId, reply);
        console.log(`🤖 [${senderId}] "${reply.slice(0, 80)}"`);
        messageLog.push({ direction: "out", senderId, text: reply, timestamp: new Date().toISOString() });
      } catch (err) {
        console.error("AI error:", err.message);
        await sendMessage(senderId, "Sorry, something went wrong. Please try again.");
      }
    }
  }
});

// ── Messenger API helpers ─────────────────────────────────────────────────────
async function callMessengerAPI(payload) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("⚠️  No PAGE_ACCESS_TOKEN — skipping Messenger send");
    return;
  }
  await axios.post("https://graph.facebook.com/v19.0/me/messages", payload, {
    params: { access_token: PAGE_ACCESS_TOKEN },
  });
}

async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 2000);
  for (const chunk of chunks) {
    await callMessengerAPI({
      recipient: { id: recipientId },
      message: { text: chunk },
      messaging_type: "RESPONSE",
    });
  }
}

async function sendTypingOn(recipientId) {
  await callMessengerAPI({
    recipient: { id: recipientId },
    sender_action: "typing_on",
  });
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const breakAt = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (breakAt > start) end = breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ── Dashboard APIs ────────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  res.json({
    total: messageLog.length,
    inbound: messageLog.filter((m) => m.direction === "in").length,
    outbound: messageLog.filter((m) => m.direction === "out").length,
    uniqueUsers: new Set(messageLog.map((m) => m.senderId)).size,
    activeConversations: conversationHistory.size,
    aiStatus: ANTHROPIC_API_KEY ? "configured" : "missing",
    pageToken: PAGE_ACCESS_TOKEN ? "configured" : "missing",
    verifyToken: VERIFY_TOKEN ? "configured" : "missing",
    botName: BOT_NAME,
  });
});

app.get("/api/messages", (req, res) => {
  res.json(messageLog.slice(-100).reverse());
});

// Test endpoint — no Facebook needed
app.post("/api/test", async (req, res) => {
  const { text, senderId = "test_user" } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  messageLog.push({ direction: "in", senderId, text, timestamp: new Date().toISOString() });

  try {
    const reply = await getAIReply(senderId, text);
    messageLog.push({ direction: "out", senderId, text: reply, timestamp: new Date().toISOString() });
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear test conversation history
app.delete("/api/test/history", (req, res) => {
  conversationHistory.delete("test_user");
  res.json({ ok: true, message: "Conversation history cleared" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 Messenger AI Chatbot  →  http://localhost:${PORT}`);
  console.log(`📊 Dashboard             →  http://localhost:${PORT}/`);
  console.log(`🔗 Webhook               →  http://localhost:${PORT}/webhook\n`);
  console.log(`Claude AI:     ${ANTHROPIC_API_KEY ? "✅ ready" : "⚠️  set ANTHROPIC_API_KEY in .env"}`);
  console.log(`Page Token:    ${PAGE_ACCESS_TOKEN ? "✅ set" : "⚠️  set PAGE_ACCESS_TOKEN in .env"}`);
  console.log(`Verify Token:  ${VERIFY_TOKEN ? "✅ set" : "⚠️  set VERIFY_TOKEN in .env"}\n`);
});
