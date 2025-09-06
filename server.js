/**
 * WhatsApp Group Notifier API (RemoteAuth + MongoDB)
 *
 * ENV:
 *  - BOT_TOKEN        required   shared secret; clients send as body field "bot-token"
 *  - MONGO_URL        required   mongodb+srv://.../wa_remoteauth?...
 *  - PORT             optional   default 3000
 *  - WAPP_CLIENT_ID   optional   stable id for RemoteAuth session, default "ci-notifier"
 */

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import qrcode from "qrcode-terminal";
import mongoose from "mongoose";
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";

const { Client, RemoteAuth } = pkg;

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MONGO_URL = process.env.MONGO_URL || "";
const CLIENT_ID = process.env.WAPP_CLIENT_ID || "ci-notifier";

if (!BOT_TOKEN || !MONGO_URL) {
  console.error("❌ Missing required env: BOT_TOKEN and/or MONGO_URL");
  process.exit(1);
}

// ----- MongoDB (RemoteAuth store) -----
await mongoose.connect(MONGO_URL, {
  // keep defaults sensible; dbName can be in the URI
  serverSelectionTimeoutMS: 15000,
});
const store = new MongoStore({
  mongoose,
  // keep this collection name stable so sessions persist where you expect
  collectionName: "auth-data",
});

// ----- WhatsApp client (RemoteAuth) -----
let isReady = false;

const client = new Client({
  authStrategy: new RemoteAuth({
    store,
    clientId: CLIENT_ID, // if this changes, you'll get a fresh session (QR again)
    backupSyncIntervalMs: 300_000, // 5 min
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  },
});

client.on("qr", (qr) => {
  // Shown only on first link or when session is invalid/missing
  console.log("📲 Scan this QR to link the bot number:");
  qrcode.generate(qr, { small: true });
});

client.on("remote_session_saved", () => {
  console.log("💾 Remote session saved to MongoDB.");
});

client.on("authenticated", () => {
  console.log("🔐 Authenticated.");
});

client.on("ready", () => {
  isReady = true;
  console.log("✅ WhatsApp client ready");
});

client.on("disconnected", (reason) => {
  isReady = false;
  console.error("❌ WhatsApp client disconnected:", reason);
});

client.on("auth_failure", (m) => {
  isReady = false;
  console.error("🚫 Authentication failure:", m);
});

await client.initialize();

// ----- HTTP API -----
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(helmet());
app.use(rateLimit({ windowMs: 60_000, max: 40 }));

function requireBodyToken(req, res, next) {
  const t = req.body?.["bot-token"];
  if (t === BOT_TOKEN) return next();
  return res.status(401).json({ error: "unauthorized" });
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ready: isReady });
});

/**
 * POST /send-group
 * body: { group: "Group Name", message: "text", "bot-token": "..." }
 */
app.post("/send-group", requireBodyToken, async (req, res) => {
  try {
    if (!isReady) return res.status(503).json({ error: "whatsapp not ready" });

    const group = String(req.body?.group || "").trim();
    const message = String(req.body?.message || "").trim();
    if (!group || !message) {
      return res.status(400).json({ error: "group and message are required" });
    }

    const chats = await client.getChats();
    const g = chats.find(
      (c) => c.isGroup && String(c.name || "").toLowerCase() === group.toLowerCase()
    );
    if (!g) return res.status(404).json({ error: "group not found" });

    await client.sendMessage(g.id._serialized, message);
    res.json({ ok: true, groupId: g.id._serialized });
  } catch (err) {
    console.error("Error in /send-group:", err);
    res.status(500).json({ error: "send failed" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 API listening on :${PORT}`);
});

// ----- Graceful shutdown -----
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      await client.destroy();
    } catch (_) {}
    server.close(() => process.exit(0));
  });
}

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
