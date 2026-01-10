"use strict";

const http = require("http");
const crypto = require("crypto");

// =======================
// ENV
// =======================
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_KEY_HEX = process.env.PUBLIC_KEY || "";

// REQUIRED to register commands:
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID || "";

// Optional: register commands only in one server for instant updates
// (recommended while testing)
const GUILD_ID = process.env.GUILD_ID || "";

// Set true to auto-register on startup
const REGISTER_COMMANDS = String(process.env.REGISTER_COMMANDS || "true").toLowerCase() === "true";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function interactionReply(content, { ephemeral = false } = {}) {
  return {
    type: 4,
    data: { content, ...(ephemeral ? { flags: 64 } : {}) },
  };
}

// =======================
// Signature verify
// =======================
function publicKeyToPemFromHex(hex) {
  const key = Buffer.from(String(hex || ""), "hex");
  if (key.length !== 32) {
    throw new Error(`PUBLIC_KEY invalid length. Expected 64 hex chars, got ${key.length * 2}.`);
  }
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([prefix, key]);
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

let PUBLIC_KEY_PEM = null;
try {
  if (!PUBLIC_KEY_HEX) throw new Error("Missing PUBLIC_KEY env var.");
  PUBLIC_KEY_PEM = publicKeyToPemFromHex(PUBLIC_KEY_HEX);
  log("✅ PUBLIC_KEY loaded");
} catch (e) {
  log("❌ PUBLIC_KEY error:", e.message);
}

function verifyDiscordRequest(signatureHex, timestamp, rawBody) {
  if (!PUBLIC_KEY_PEM) return false;
  if (!signatureHex || !timestamp) return false;
  const msg = Buffer.from(timestamp + rawBody);
  const sig = Buffer.from(signatureHex, "hex");
  const keyObj = crypto.createPublicKey(PUBLIC_KEY_PEM);
  return crypto.verify(null, msg, keyObj, sig);
}

// =======================
// Discord REST
// =======================
async function discordApi(method, route, body) {
  const url = `https://discord.com/api/v10${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "utility-bot (zero-deps)",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Discord API ${res.status} ${method} ${route}: ${msg}`);
  }
  return json;
}

// =======================
// Command registration (THIS is what you're missing)
// =======================
const COMMANDS = [
  { name: "ping", description: "Check if the bot is online" },
  { name: "help", description: "Show bot help" },
  { name: "serverinfo", description: "Show server info" },
];

async function registerCommands() {
  if (!REGISTER_COMMANDS) return;
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    log("⚠️ Not registering commands: missing DISCORD_TOKEN or CLIENT_ID env vars.");
    return;
  }

  try {
    if (GUILD_ID) {
      // Guild commands appear instantly (best for testing)
      await discordApi("PUT", `/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`, COMMANDS);
      log(`✅ Registered GUILD commands for ${GUILD_ID}`);
    } else {
      // Global commands can take a few minutes to appear
      await discordApi("PUT", `/applications/${CLIENT_ID}/commands`, COMMANDS);
      log("✅ Registered GLOBAL commands (may take a few minutes to show)");
    }
  } catch (e) {
    log("❌ Command registration failed:", e.message);
  }
}

// =======================
// Handlers
// =======================
async function handleCommand(interaction) {
  const name = interaction.data?.name;

  if (name === "ping") return interactionReply("🏓 Pong! Bot endpoint is working.");
  if (name === "help")
    return interactionReply(
      ["**Utility Bot ✅**", "", "Commands:", "- `/ping`", "- `/serverinfo`", "- `/help`"].join("\n"),
      { ephemeral: true }
    );

  if (name === "serverinfo") {
    const guildId = interaction.guild_id;
    if (!guildId) return interactionReply("Run this in a server.", { ephemeral: true });

    if (!DISCORD_TOKEN) {
      return interactionReply("Set DISCORD_TOKEN to enable full server info.", { ephemeral: true });
    }

    try {
      const g = await discordApi("GET", `/guilds/${guildId}?with_counts=true`);
      const ownerId = g.owner_id;
      const members = g.approximate_member_count ?? "Unknown";
      const boosts = g.premium_subscription_count ?? 0;
      const tier = g.premium_tier ?? 0;

      return interactionReply(
        [
          `**🏰 ${g.name}**`,
          `Owner: <@${ownerId}>`,
          `Members: **${members}**`,
          `Boosts: **${boosts}** (Tier ${tier})`,
          `Guild ID: \`${g.id}\``,
        ].join("\n")
      );
    } catch (e) {
      log("serverinfo error:", e.message);
      return interactionReply("Could not fetch server info. Check bot permissions.", { ephemeral: true });
    }
  }

  return interactionReply("Unknown command. Try `/help`.", { ephemeral: true });
}

// =======================
// Server
// =======================
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    const status = PUBLIC_KEY_PEM ? "OK" : "PUBLIC_KEY_ERROR";
    return sendText(res, 200, `✅ Bot is running.\nStatus: ${status}\n`);
  }

  if (req.method !== "POST" || req.url !== "/interactions") {
    return sendText(res, 404, "Not found");
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    try {
      const valid = verifyDiscordRequest(signature, timestamp, raw);
      if (!valid) return sendJson(res, 401, { error: "invalid request signature" });

      const interaction = JSON.parse(raw);

      // Ping for endpoint verification
      if (interaction.type === 1) return sendJson(res, 200, { type: 1 });

      // Slash commands
      const response = await handleCommand(interaction);
      return sendJson(res, 200, response);
    } catch (e) {
      log("❌ error:", e.stack || e.message);
      return sendJson(res, 500, { error: "server error" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`✅ Listening on ${PORT}`);
  // Register commands at boot
  registerCommands();
});
