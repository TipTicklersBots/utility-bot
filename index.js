"use strict";

const http = require("http");
const crypto = require("crypto");

// =======================
// ENV
// =======================
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_KEY_HEX = process.env.PUBLIC_KEY || "";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID || "";
const GUILD_ID = process.env.GUILD_ID || "";
const REGISTER_COMMANDS = String(process.env.REGISTER_COMMANDS || "true").toLowerCase() === "true";

// =======================
// Helpers
// =======================
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

function reply(content, { ephemeral = false } = {}) {
  return {
    type: 4,
    data: {
      content,
      ...(ephemeral ? { flags: 64 } : {}),
    },
  };
}

function getOption(interaction, name) {
  const opts = interaction.data?.options || [];
  return opts.find((o) => o.name === name)?.value;
}

function snowflakeToDate(id) {
  const DISCORD_EPOCH = 1420070400000n;
  const n = BigInt(id);
  const ms = Number((n >> 22n) + DISCORD_EPOCH);
  return new Date(ms);
}

// =======================
// Signature verify (Ed25519)
// =======================
function publicKeyToPemFromHex(hex) {
  const key = Buffer.from(String(hex || ""), "hex");
  if (key.length !== 32) {
    throw new Error(`PUBLIC_KEY invalid. Must be 64 hex chars (32 bytes). Got ${key.length * 2} hex chars.`);
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
// Discord REST helper
// =======================
async function discordApi(method, route, body) {
  if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN env var.");
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
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Discord API ${res.status} ${method} ${route}: ${msg}`);
  }
  return json;
}

// =======================
// Command registration (auto)
// =======================
const COMMANDS = [
  { name: "ping", description: "Check if the bot is online" },
  { name: "help", description: "Show bot help" },
  { name: "serverinfo", description: "Show server info" },
  {
    name: "userinfo",
    description: "Show info about a user",
    options: [{ type: 6, name: "user", description: "User to look up", required: true }],
  },
  {
    name: "avatar",
    description: "Get a user's avatar",
    options: [{ type: 6, name: "user", description: "User to get avatar for", required: true }],
  },
  {
    name: "purge",
    description: "Delete the last N messages (max 100, <14 days old)",
    default_member_permissions: String(0x2000), // Manage Messages
    dm_permission: false,
    options: [{ type: 4, name: "count", description: "1-100", required: true, min_value: 1, max_value: 100 }],
  },
];

async function registerCommands() {
  if (!REGISTER_COMMANDS) return;
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    log("⚠️ Not registering commands: missing DISCORD_TOKEN or CLIENT_ID.");
    return;
  }

  try {
    if (GUILD_ID) {
      await discordApi("PUT", `/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`, COMMANDS);
      log(`✅ Registered commands for guild ${GUILD_ID} (instant)`);
    } else {
      await discordApi("PUT", `/applications/${CLIENT_ID}/commands`, COMMANDS);
      log("✅ Registered GLOBAL commands (may take a bit to appear)");
    }
  } catch (e) {
    log("❌ Command registration failed:", e.message);
  }
}

// =======================
// Command handlers
// =======================
async function handlePing() {
  return reply("🏓 Pong! (endpoint + bot token working)");
}

async function handleHelp() {
  return reply(
    [
      "**Utility Bot ✅**",
      "",
      "**Commands:**",
      "- `/ping`",
      "- `/help`",
      "- `/serverinfo`",
      "- `/userinfo user:`",
      "- `/avatar user:`",
      "- `/purge count:` (needs Manage Messages)",
      "",
      "If commands don’t show up, make sure `REGISTER_COMMANDS=true` and `GUILD_ID` is set (for instant).",
    ].join("\n"),
    { ephemeral: true }
  );
}

async function handleServerInfo(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply("Run this inside a server.", { ephemeral: true });

  const g = await discordApi("GET", `/guilds/${guildId}?with_counts=true`);
  const created = snowflakeToDate(g.id);
  const boosts = g.premium_subscription_count ?? 0;
  const tier = g.premium_tier ?? 0;
  const members = g.approximate_member_count ?? "Unknown";

  return reply(
    [
      `**🏰 ${g.name}**`,
      `Owner: <@${g.owner_id}> (\`${g.owner_id}\`)`,
      `Created: <t:${Math.floor(created.getTime() / 1000)}:F>`,
      `Members: **${members}**`,
      `Boosts: **${boosts}** (Tier ${tier})`,
      `Guild ID: \`${g.id}\``,
    ].join("\n")
  );
}

async function handleUserInfo(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply("Run this inside a server.", { ephemeral: true });

  const userId = getOption(interaction, "user");
  const member = await discordApi("GET", `/guilds/${guildId}/members/${userId}`);
  const user = member.user;

  const created = snowflakeToDate(user.id);
  const joined = member.joined_at ? new Date(member.joined_at) : null;

  return reply(
    [
      `**👤 ${user.username}**`,
      `ID: \`${user.id}\``,
      `Account created: <t:${Math.floor(created.getTime() / 1000)}:F>`,
      joined ? `Joined server: <t:${Math.floor(joined.getTime() / 1000)}:F>` : "Joined server: Unknown",
      `Roles: **${(member.roles || []).length}**`,
    ].join("\n"),
    { ephemeral: true }
  );
}

async function handleAvatar(interaction) {
  const userId = getOption(interaction, "user");
  const u = await discordApi("GET", `/users/${userId}`);

  const avatarHash = u.avatar;
  const isGif = avatarHash && avatarHash.startsWith("a_");
  const ext = isGif ? "gif" : "png";
  const url = avatarHash
    ? `https://cdn.discordapp.com/avatars/${u.id}/${avatarHash}.${ext}?size=1024`
    : `https://cdn.discordapp.com/embed/avatars/${Number(u.discriminator) % 5}.png`;

  return reply([`**🖼️ ${u.username}'s avatar**`, url].join("\n"), { ephemeral: true });
}

async function handlePurge(interaction) {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  if (!guildId || !channelId) return reply("Run this inside a server channel.", { ephemeral: true });

  const count = Number(getOption(interaction, "count") || 0);
  if (!count || count < 1 || count > 100) return reply("Count must be 1-100.", { ephemeral: true });

  const messages = await discordApi("GET", `/channels/${channelId}/messages?limit=${count}`);
  const ids = messages.map((m) => m.id);

  if (!ids.length) return reply("Nothing to delete.", { ephemeral: true });

  try {
    await discordApi("POST", `/channels/${channelId}/messages/bulk-delete`, { messages: ids });
    return reply(`🧹 Deleted **${ids.length}** message(s).`, { ephemeral: true });
  } catch {
    return reply("⚠️ Could not bulk delete. Messages may be older than 14 days or I lack permissions.", { ephemeral: true });
  }
}

async function routeInteraction(interaction) {
  if (interaction.type === 1) return { type: 1 }; // PING

  const name = interaction.data?.name;

  if (name === "ping") return handlePing(interaction);
  if (name === "help") return handleHelp(interaction);
  if (name === "serverinfo") return handleServerInfo(interaction);
  if (name === "userinfo") return handleUserInfo(interaction);
  if (name === "avatar") return handleAvatar(interaction);
  if (name === "purge") return handlePurge(interaction);

  return reply("Unknown command. Try `/help`.", { ephemeral: true });
}

// =======================
// HTTP Server
// =======================
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    const status = PUBLIC_KEY_PEM ? "OK" : "PUBLIC_KEY_ERROR";
    return sendText(res, 200, `✅ Bot is running.\nStatus: ${status}\n`);
  }

  // Interactions endpoint
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
      const response = await routeInteraction(interaction);
      return sendJson(res, 200, response);
    } catch (e) {
      log("❌ Error:", e.stack || e.message);
      return sendJson(res, 500, { error: "server error" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`✅ Listening on ${PORT}`);
  registerCommands();
});

process.on("uncaughtException", (err) => log("❌ uncaughtException:", err.stack || err));
process.on("unhandledRejection", (err) => log("❌ unhandledRejection:", err && (err.stack || err)));

