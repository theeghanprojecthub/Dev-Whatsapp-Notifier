/**
 * WhatsApp Group Notifier API (RemoteAuth + MongoDB)
 *
 * ENV:
 *  - BOT_TOKEN        required  shared secret; clients send as body field "bot-token"
 *  - MONGO_URL        required  mongodb+srv://.../wa_remoteauth?...
 *  - PORT             optional  default 3000
 *  - WAPP_CLIENT_ID   optional  stable id for RemoteAuth session, default "ci-notifier"
 *  - WA_BACKUP_MS     optional  >=60000 enables RemoteAuth ZIP backup; anything <60000 disables
 *  - WA_BACKUP_DIR    optional  directory for ZIPs when backup is enabled (default: /tmp)
 */

import "dotenv/config";
import fs from "node:fs";
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
await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 15000 });
const store = new MongoStore({
  mongoose,
  collectionName: "auth-data",
});

// ----- Backup / ZIP safety (CI friendly) -----
const BACKUP_MS_ENV = process.env.WA_BACKUP_MS;
const BACKUP_DIR = process.env.WA_BACKUP_DIR || "/tmp";
let backupSyncIntervalMs = undefined;

if (BACKUP_MS_ENV) {
  const n = Number(BACKUP_MS_ENV);
  if (Number.isFinite(n) && n >= 60000) {
    backupSyncIntervalMs = n;
    try {
      await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
      // Put ZIPs in a writable place on CI
      process.chdir(BACKUP_DIR);
    } catch (e) {
      console.warn("⚠️ Could not prepare backup dir:", e);
    }
    console.log(`🗂️  Backup enabled; writing ZIPs to ${BACKUP_DIR} every ${backupSyncIntervalMs}ms`);
  } else {
    console.log("ℹ️  WA_BACKUP_MS provided but <60000; backup disabled.");
  }
}

let isReady = false;

// ----- WhatsApp client (RemoteAuth) -----
const client = new Client({
  authStrategy: new RemoteAuth({
    store,
    clientId: CLIENT_ID,                // keep this stable to reuse session
    backupSyncIntervalMs,               // undefined = no ZIP backup
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
  console.log("📲 Scan this QR to link the bot number:");
  qrcode.generate(qr, { small: true });
});
client.on("remote_session_saved", () => console.log("💾 Remote session saved to MongoDB."));
client.on("authenticated", () => console.log("🔐 Authenticated."));
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
 * body: { group?: "Group Name", groupId?: "1203...@g.us", message: "text", "bot-token": "..." }
 *
 * - Prefers groupId when provided (no ambiguity).
 * - Waits for server ack (>=1) up to 10s before responding.
 */
app.post("/send-group", requireBodyToken, async (req, res) => {
  try {
    if (!isReady) return res.status(503).json({ error: "whatsapp not ready" });

    const groupName = String(req.body?.group || "").trim();
    const groupIdReq = String(req.body?.groupId || "").trim();
    const message = String(req.body?.message || "").trim();
    if ((!groupName && !groupIdReq) || !message) {
      return res.status(400).json({ error: "provide group or groupId and a message" });
    }

    let chat;
    if (groupIdReq) {
      try {
        chat = await client.getChatById(groupIdReq);
      } catch {
        return res.status(404).json({ error: "groupId not found" });
      }
      if (!chat?.isGroup) return res.status(400).json({ error: "groupId is not a group" });
    } else {
      const chats = await client.getChats();
      chat = chats.find(
        (c) => c.isGroup && String(c.name || "").toLowerCase() === groupName.toLowerCase()
      );
      if (!chat) return res.status(404).json({ error: "group not found" });
    }

    // Send and wait for server ack (<=10s)
    const sent = await client.sendMessage(chat.id._serialized, message);
    const acked = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      const onAck = (msg, ack) => {
        if (msg.id._serialized === sent.id._serialized && ack >= 1) {
          clearTimeout(timeout);
          client.removeListener("message_ack", onAck);
          resolve(true);
        }
      };
      client.on("message_ack", onAck);
    });

    console.log(`📨 Sent to ${chat.id._serialized}, ack=${acked ? "server" : "timeout"}`);

    return res.json({
      ok: true,
      groupId: chat.id._serialized,
      messageId: sent.id._serialized,
      ack: acked ? "server" : "pending",
    });
  } catch (e) {
    console.error("Error in /send-group:", e);
    return res.status(500).json({ error: "send failed" });
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
    } catch {}
    server.close(() => process.exit(0));
  });
}

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException",  (err) => console.error("UNCAUGHT EXCEPTION:", err));
