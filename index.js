"use strict";

const http = require("http");
const crypto = require("crypto");

// =======================
// ENV (Railway)
// =======================
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_KEY_HEX = process.env.PUBLIC_KEY || "";

// OPTIONAL (for real server info + future moderation)
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID || "";

// =======================
// Small helpers
// =======================
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function interactionReply(content, { ephemeral = false } = {}) {
  return {
    type: 4,
    data: {
      content,
      ...(ephemeral ? { flags: 64 } : {}),
    },
  };
}

// =======================
// Discord signature verify (Ed25519)
// =======================
function publicKeyToPemFromHex(hex) {
  const key = Buffer.from(String(hex || ""), "hex");
  if (key.length !== 32) {
    throw new Error(
      `PUBLIC_KEY invalid length. Expected 32 bytes (64 hex chars), got ${key.length} bytes.`
    );
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
  // Keep server alive so you can still see status at /
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
// Discord REST helper (optional)
// =======================
async function discordApi(method, route) {
  const url = `https://discord.com/api/v10${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "utility-bot (zero-deps)",
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Discord API ${res.status}: ${msg}`);
  }
  return json;
}

// =======================
// Command handlers
// =======================
async function handleCommand(interaction) {
  const name = interaction.data?.name;

  if (name === "ping") {
    return interactionReply("🏓 Pong! (bot endpoint is working)");
  }

  if (name === "help") {
    return interactionReply(
      [
        "**Utility Bot is online ✅**",
        "",
        "**Commands:**",
        "- `/ping` — check bot",
        "- `/serverinfo` — show server info (basic unless token is set)",
        "",
        "**If commands don’t appear:**",
        "You must **register slash commands** once via the Discord API.",
      ].join("\n"),
      { ephemeral: true }
    );
  }

  if (name === "serverinfo") {
    const guildId = interaction.guild_id;

    if (!guildId) {
      return interactionReply("This command only works in a server.", { ephemeral: true });
    }

    // If token is set, fetch real server info
    if (DISCORD_TOKEN) {
      try {
        const g = await discordApi("GET", `/guilds/${guildId}?with_counts=true`);
        const ownerId = g.owner_id;
        const boosts = g.premium_subscription_count ?? 0;
        const tier = g.premium_tier ?? 0;
        const members = g.approximate_member_count ?? "Unknown";

        return {
          type: 4,
          data: {
            // simple embed-style message without embeds (keeps it super compatible)
            content: [
              `**🏰 Server Info — ${g.name}**`,
              `Owner: <@${ownerId}> (\`${ownerId}\`)`,
              `Members: **${members}**`,
              `Boosts: **${boosts}** (Tier ${tier})`,
              `Guild ID: \`${g.id}\``,
            ].join("\n"),
          },
        };
      } catch (e) {
        log("serverinfo REST error:", e.message);
        return interactionReply(
          "I couldn’t fetch server info (check my DISCORD_TOKEN permissions).",
          { ephemeral: true }
        );
      }
    }

    // Basic info without token
    return interactionReply(
      [
        "**🏰 Server Info**",
        `Guild ID: \`${guildId}\``,
        "",
        "Tip: Set `DISCORD_TOKEN` in Railway Variables to enable full server details.",
      ].join("\n"),
      { ephemeral: true }
    );
  }

  return interactionReply("Unknown command. Try `/help`.", { ephemeral: true });
}

// =======================
// HTTP Server
// =======================
const server = http.createServer((req, res) => {
  try {
    // Health check page
    if (req.method === "GET" && req.url === "/") {
      const status = PUBLIC_KEY_PEM ? "OK" : "PUBLIC_KEY_ERROR";
      return sendText(
        res,
        200,
        `✅ Bot is running.\nStatus: ${status}\nPort: ${PORT}\n`
      );
    }

    // Discord interactions endpoint (POST only)
    if (req.method !== "POST" || req.url !== "/interactions") {
      return sendText(res, 404, "Not found");
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        // Verify Discord signature
        const valid = verifyDiscordRequest(signature, timestamp, raw);
        if (!valid) {
          log("❌ Invalid signature (or PUBLIC_KEY not loaded)");
          return sendJson(res, 401, { error: "invalid request signature" });
        }

        const interaction = JSON.parse(raw);

        // Discord ping for endpoint verification
        if (interaction.type === 1) {
          return sendJson(res, 200, { type: 1 });
        }

        // Handle slash command
        const response = await handleCommand(interaction);
        return sendJson(res, 200, response);
      } catch (e) {
        log("❌ Interaction handler error:", e.stack || e.message);
        return sendJson(res, 500, { error: "server error" });
      }
    });
  } catch (e) {
    log("❌ Request error:", e.stack || e.message);
    return sendJson(res, 500, { error: "server error" });
  }
});

// Start server (Railway compatible)
server.listen(PORT, "0.0.0.0", () => {
  log(`✅ Listening on ${PORT}`);
});

// Safety: log crashes instead of silent exit
process.on("uncaughtException", (err) => log("❌ uncaughtException:", err.stack || err));
process.on("unhandledRejection", (err) => log("❌ unhandledRejection:", err && (err.stack || err)));
