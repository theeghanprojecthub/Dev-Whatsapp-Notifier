/**
 * WhatsApp Group Notifier API (RemoteAuth + MongoDB)
 *
 * ENV:
 *  - BOT_TOKEN          required   shared secret; clients send as "bot-token" in body
 *  - MONGO_URL          required   mongodb+srv://.../wa_remoteauth?...
 *  - PORT               optional   default 3000
 *  - WAPP_CLIENT_ID     optional   stable id for RemoteAuth session, default "ci-notifier"
 *  - WA_BACKUP_MS       optional   >=60000 enables periodic ZIP backup; "0" disables
 *  - WA_BACKUP_DIR      optional   where ZIPs are written (default "/tmp")
 *  - ACK_LEVEL_DEFAULT  optional   default ack to wait for: server|device|read|played (default "device")
 *  - ACK_TIMEOUT_MS     optional   how long to wait for ack (default 20000)
 */

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import qrcode from "qrcode-terminal";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";

const { Client, RemoteAuth } = pkg;

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MONGO_URL = process.env.MONGO_URL || "";
const CLIENT_ID = process.env.WAPP_CLIENT_ID || "ci-notifier";

const ACK_LEVEL_DEFAULT = String(process.env.ACK_LEVEL_DEFAULT || "device").toLowerCase();
const ACK_TIMEOUT_MS = Number(process.env.ACK_TIMEOUT_MS || 20000);

const BACKUP_MS_RAW = process.env.WA_BACKUP_MS ?? "0";
const BACKUP_MS = Number(BACKUP_MS_RAW);
const BACKUP_DIR = process.env.WA_BACKUP_DIR || "/tmp";

if (!BOT_TOKEN || !MONGO_URL) {
  console.error("❌ Missing required env: BOT_TOKEN and/or MONGO_URL");
  process.exit(1);
}
if (Number.isNaN(BACKUP_MS) || BACKUP_MS < 0) {
  console.error("❌ Invalid WA_BACKUP_MS");
  process.exit(1);
}
if (BACKUP_MS !== 0 && BACKUP_MS < 60000) {
  console.error("❌ WA_BACKUP_MS must be >= 60000 or 0 to disable");
  process.exit(1);
}

// ---------- Mongo (RemoteAuth store) ----------
await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 15000 });
const store = new MongoStore({ mongoose, collectionName: "auth-data" });

// ---------- WhatsApp client ----------
let isReady = false;

const client = new Client({
  authStrategy: new RemoteAuth({
    store,
    clientId: CLIENT_ID,
    backupSyncIntervalMs: BACKUP_MS === 0 ? 600000 : BACKUP_MS, // library requires >= 60000
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

// ---------- Optional periodic ZIP backups of RemoteAuth (best-effort) ----------
if (BACKUP_MS >= 60000) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`🗂️  Backup enabled; writing ZIPs to ${BACKUP_DIR} every ${BACKUP_MS}ms`);
    setInterval(async () => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = path.join(BACKUP_DIR, `RemoteAuth-${CLIENT_ID}-${ts}.zip`);
        const out = fs.createWriteStream(outPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        archive.on("error", (e) => console.error("backup zip error:", e));
        archive.pipe(out);
        // dump auth-data collection JSON
        const col = mongoose.connection.db.collection("auth-data");
        const docs = await col.find({}).toArray();
        archive.append(JSON.stringify(docs, null, 2), { name: "auth-data.json" });
        await archive.finalize();
      } catch (e) {
        console.error("backup error:", e);
      }
    }, BACKUP_MS).unref();
  } catch (e) {
    console.error("backup init error:", e);
  }
}

// ---------- helpers ----------
const AckMap = { server: 1, device: 2, read: 3, played: 4 };
function parseAckLevel(s, fallback = ACK_LEVEL_DEFAULT) {
  const k = String(s || fallback).toLowerCase();
  return AckMap[k] ? { name: k, code: AckMap[k] } : { name: "server", code: 1 };
}

function waitForAck(message, minAckCode, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const targetId = message.id?._serialized || message._serialized;
    const cleanup = () => {
      settled = true;
      client.removeListener("message_ack", onAck);
    };
    const onAck = (msg, ack) => {
      try {
        const id = msg?.id?._serialized || msg?._serialized;
        if (!id || id !== targetId) return;
        if (ack >= minAckCode) {
          cleanup();
          resolve({ ack, timedOut: false });
        }
      } catch {
        // ignore
      }
    };
    client.on("message_ack", onAck);
    setTimeout(() => {
      if (!settled) {
        cleanup();
        resolve({ ack: message.ack ?? 1, timedOut: true });
      }
    }, timeoutMs).unref();
  });
}

// ---------- HTTP API ----------
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
  res.json({
    ok: true,
    ready: isReady,
    clientId: CLIENT_ID,
    backup: BACKUP_MS >= 60000 ? { everyMs: BACKUP_MS, dir: BACKUP_DIR } : { disabled: true },
    ackDefault: ACK_LEVEL_DEFAULT,
    ackTimeoutMs: ACK_TIMEOUT_MS,
  });
});

/**
 * POST /send-group
 * Body:
 *   - group      (optional) group name (case-insensitive)
 *   - groupId    (optional) 1203...@g.us  (preferred)
 *   - message    required
 *   - ack        optional "server"|"device"|"read"|"played"  (default ACK_LEVEL_DEFAULT)
 *   - timeoutMs  optional number (default ACK_TIMEOUT_MS)
 *   - bot-token  required shared secret
 */
app.post("/send-group", requireBodyToken, async (req, res) => {
  try {
    if (!isReady) return res.status(503).json({ error: "whatsapp not ready" });

    const group = String(req.body?.group || "").trim();
    const groupId = String(req.body?.groupId || "").trim();
    const text = String(req.body?.message || "").trim();
    if (!text) return res.status(400).json({ error: "message is required" });

    const { name: ackName, code: minAck } = parseAckLevel(req.body?.ack);
    const timeoutMs = Number(req.body?.timeoutMs || ACK_TIMEOUT_MS);

    // resolve chat
    let chatId;
    if (groupId) {
      chatId = groupId;
    } else if (group) {
      const chats = await client.getChats();
      const g = chats.find(
        (c) => c.isGroup && String(c.name || "").toLowerCase() === group.toLowerCase()
      );
      if (!g) return res.status(404).json({ error: "group not found" });
      chatId = g.id._serialized;
    } else {
      return res.status(400).json({ error: "groupId or group is required" });
    }

    const msg = await client.sendMessage(chatId, text);
    const { ack, timedOut } = await waitForAck(msg, minAck, timeoutMs);

    const ackNames = { 0: "error", 1: "server", 2: "device", 3: "read", 4: "played" };
    const ackStr = ackNames[ack] || String(ack);

    console.log(`📨 Sent to ${chatId}, ack=${ackStr}${timedOut ? " (timeout)" : ""}`);

    return res.json({
      ok: true,
      groupId: chatId,
      messageId: msg?.id?._serialized || null,
      ack: ackStr,
      timedOut,
      waitedFor: ackName,
      timeoutMs,
    });
  } catch (err) {
    console.error("Error in /send-group:", err);
    res.status(500).json({ error: "send failed" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 API listening on :${PORT}`);
});

// ---------- Shutdown ----------
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try {
      await client.destroy();
    } catch {}
    server.close(() => process.exit(0));
  });
}
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
