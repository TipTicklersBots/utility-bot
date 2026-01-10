"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// =======================
// ENV
// =======================
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_KEY_HEX = process.env.PUBLIC_KEY || "";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID || "";

// If you set GUILD_ID, it will register guild commands too.
// For GLOBAL everywhere: leave GUILD_ID EMPTY / remove it.
const GUILD_ID = process.env.GUILD_ID || "";

const REGISTER_COMMANDS = String(process.env.REGISTER_COMMANDS || "true").toLowerCase() === "true";

// =======================
// Minimal config (logs channel per guild)
// NOTE: Railway filesystem can reset on redeploy.
// This is fine for "simple" bots; if you want persistence forever,
// we’d move this to a DB later.
const CONFIG_PATH = path.join(process.cwd(), "config.json");
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { guilds: {} }; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8"); }
  catch {}
}
const config = loadConfig();
function guildCfg(guildId) {
  config.guilds[guildId] ||= { log_channel_id: null };
  return config.guilds[guildId];
}

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
  return { type: 4, data: { content, ...(ephemeral ? { flags: 64 } : {}) } };
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
function parseDurationToMs(input) {
  const raw = String(input || "").trim().toLowerCase();
  const re = /(\d+)\s*(d|h|m|s)/g;
  let match;
  let total = 0;
  let found = false;

  while ((match = re.exec(raw)) !== null) {
    found = true;
    const n = Number(match[1]);
    const unit = match[2];
    if (unit === "d") total += n * 24 * 60 * 60 * 1000;
    if (unit === "h") total += n * 60 * 60 * 1000;
    if (unit === "m") total += n * 60 * 1000;
    if (unit === "s") total += n * 1000;
  }
  if (!found || total <= 0) return null;
  return total;
}

// =======================
// Signature verify (Ed25519)
// =======================
function publicKeyToPemFromHex(hex) {
  const key = Buffer.from(String(hex || ""), "hex");
  if (key.length !== 32) {
    throw new Error(`PUBLIC_KEY invalid. Must be 64 hex chars. Got ${key.length * 2}.`);
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
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Discord API ${res.status} ${method} ${route}: ${msg}`);
  }
  return json;
}

async function sendLog(guildId, content) {
  const cfg = guildCfg(guildId);
  if (!cfg.log_channel_id) return;
  try {
    await discordApi("POST", `/channels/${cfg.log_channel_id}/messages`, { content });
  } catch {}
}

// =======================
// Commands definition
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

  // Setup (logging)
  {
    name: "setup",
    description: "Configure the bot for this server",
    default_member_permissions: String(0x20), // Manage Guild
    dm_permission: false,
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "logs",
        description: "Set the log channel",
        options: [{ type: 7, name: "channel", description: "Channel to send logs to", required: true }],
      },
      {
        type: 1,
        name: "view",
        description: "View current config",
      },
    ],
  },

  // Moderation
  {
    name: "kick",
    description: "Kick a member",
    default_member_permissions: String(0x2), // Kick Members
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to kick", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "ban",
    description: "Ban a member",
    default_member_permissions: String(0x4), // Ban Members
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to ban", required: true },
      { type: 4, name: "delete_days", description: "Delete message history (0-7 days)", required: false, min_value: 0, max_value: 7 },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "timeout",
    description: "Timeout a member",
    default_member_permissions: String(0x1_0000), // Moderate Members
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to timeout", required: true },
      { type: 3, name: "duration", description: 'e.g. "10m", "1h", "1d"', required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "untimeout",
    description: "Remove a member's timeout",
    default_member_permissions: String(0x1_0000),
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to untimeout", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
];

// =======================
// Registration logic
// - If you previously used guild commands, this clears them to stop duplicates.
// - Then registers either GLOBAL (default) or BOTH if you set GUILD_ID.
// =======================
async function registerCommands() {
  if (!REGISTER_COMMANDS) return;
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    log("⚠️ Not registering commands: missing DISCORD_TOKEN or CLIENT_ID.");
    return;
  }

  try {
    // Always register GLOBAL so it works everywhere
    await discordApi("PUT", `/applications/${CLIENT_ID}/commands`, COMMANDS);
    log("✅ Registered GLOBAL commands (works everywhere; may take a bit to appear)");

    // If a guild id is provided, we ALSO register guild commands (instant) — but that causes duplicates.
    // We'll only do guild commands if you *want* them for testing.
    if (GUILD_ID) {
      await discordApi("PUT", `/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`, COMMANDS);
      log(`✅ Registered GUILD commands for ${GUILD_ID} (instant)`);
    }

    // To stop duplicates, you should remove GUILD_ID from env.
    // Additionally, if you previously registered guild commands in a server and removed GUILD_ID,
    // you may still see duplicates until they are overwritten/cleared.
    // We can clear a specific guild's commands if you set CLEAR_GUILD_ID.
    const CLEAR_GUILD_ID = process.env.CLEAR_GUILD_ID || "";
    if (CLEAR_GUILD_ID) {
      await discordApi("PUT", `/applications/${CLIENT_ID}/guilds/${CLEAR_GUILD_ID}/commands`, []);
      log(`🧹 Cleared old guild commands in ${CLEAR_GUILD_ID}`);
    }
  } catch (e) {
    log("❌ Command registration failed:", e.message);
  }
}

// =======================
// Handlers
// =======================
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
      `Owner: <@${g.owner_id}>`,
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
    : "No avatar.";

  return reply([`**🖼️ ${u.username}'s avatar**`, url].join("\n"), { ephemeral: true });
}

async function handlePurge(interaction) {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  const count = Number(getOption(interaction, "count") || 0);

  if (!guildId || !channelId) return reply("Run this in a server channel.", { ephemeral: true });
  if (!count || count < 1 || count > 100) return reply("Count must be 1-100.", { ephemeral: true });

  const messages = await discordApi("GET", `/channels/${channelId}/messages?limit=${count}`);
  const ids = messages.map((m) => m.id);
  if (!ids.length) return reply("Nothing to delete.", { ephemeral: true });

  try {
    await discordApi("POST", `/channels/${channelId}/messages/bulk-delete`, { messages: ids });
    await sendLog(guildId, `🧹 Purge: deleted ${ids.length} messages in <#${channelId}> by <@${interaction.member?.user?.id || interaction.user?.id}>`);
    return reply(`🧹 Deleted **${ids.length}** message(s).`, { ephemeral: true });
  } catch {
    return reply("⚠️ Could not bulk delete (messages may be older than 14 days or missing perms).", { ephemeral: true });
  }
}

async function handleSetup(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return reply("Run this inside a server.", { ephemeral: true });

  const sub = interaction.data?.options?.[0]?.name; // logs | view
  const cfg = guildCfg(guildId);

  if (sub === "view" || !sub) {
    return reply(
      [
        "**⚙️ Setup — Current Settings**",
        `Log channel: ${cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : "Not set"}`,
        "",
        "Use `/setup logs channel:#your-channel` to set it.",
      ].join("\n"),
      { ephemeral: true }
    );
  }

  if (sub === "logs") {
    const channelId = interaction.data.options?.[0]?.options?.find((o) => o.name === "channel")?.value;
    cfg.log_channel_id = channelId;
    saveConfig(config);
    return reply(`✅ Log channel set to <#${channelId}>`, { ephemeral: true });
  }

  return reply("Unknown setup option.", { ephemeral: true });
}

async function handleKick(interaction) {
  const guildId = interaction.guild_id;
  const userId = getOption(interaction, "user");
  const reason = getOption(interaction, "reason") || "No reason provided.";
  if (!guildId || !userId) return reply("Missing guild/user.", { ephemeral: true });

  await discordApi("DELETE", `/guilds/${guildId}/members/${userId}`, { reason });
  await sendLog(guildId, `👢 Kicked: <@${userId}> • Reason: ${reason}`);
  return reply(`👢 Kicked <@${userId}>.`, { ephemeral: true });
}

async function handleBan(interaction) {
  const guildId = interaction.guild_id;
  const userId = getOption(interaction, "user");
  const deleteDays = Number(getOption(interaction, "delete_days") ?? 0);
  const reason = getOption(interaction, "reason") || "No reason provided.";
  if (!guildId || !userId) return reply("Missing guild/user.", { ephemeral: true });

  await discordApi("PUT", `/guilds/${guildId}/bans/${userId}?delete_message_seconds=${deleteDays * 86400}`, { reason });
  await sendLog(guildId, `🔨 Banned: <@${userId}> • Deleted days: ${deleteDays} • Reason: ${reason}`);
  return reply(`🔨 Banned <@${userId}>.`, { ephemeral: true });
}

async function handleTimeout(interaction, untimeout = false) {
  const guildId = interaction.guild_id;
  const userId = getOption(interaction, "user");
  const reason = getOption(interaction, "reason") || "No reason provided.";
  if (!guildId || !userId) return reply("Missing guild/user.", { ephemeral: true });

  let untilIso = null;
  if (!untimeout) {
    const durationStr = getOption(interaction, "duration");
    const ms = parseDurationToMs(durationStr);
    if (!ms || ms < 5_000 || ms > 28 * 24 * 60 * 60 * 1000) {
      return reply('Invalid duration. Use like "10m", "1h", "1d". Max 28d.', { ephemeral: true });
    }
    untilIso = new Date(Date.now() + ms).toISOString();
  }

  await discordApi("PATCH", `/guilds/${guildId}/members/${userId}`, {
    communication_disabled_until: untimeout ? null : untilIso,
    reason,
  });

  const msg = untimeout ? "✅ Timeout removed" : "⏳ Timed out";
  await sendLog(guildId, `${msg}: <@${userId}> • Reason: ${reason}`);
  return reply(`${msg} <@${userId}>.`, { ephemeral: true });
}

async function routeInteraction(interaction) {
  if (interaction.type === 1) return { type: 1 }; // PING

  const name = interaction.data?.name;

  if (name === "ping") return reply("🏓 Pong!");
  if (name === "help")
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
        "- `/purge count:`",
        "- `/setup view` / `/setup logs channel:`",
        "- `/kick` `/ban` `/timeout` `/untimeout`",
      ].join("\n"),
      { ephemeral: true }
    );

  if (name === "serverinfo") return handleServerInfo(interaction);
  if (name === "userinfo") return handleUserInfo(interaction);
  if (name === "avatar") return handleAvatar(interaction);
  if (name === "purge") return handlePurge(interaction);

  if (name === "setup") return handleSetup(interaction);
  if (name === "kick") return handleKick(interaction);
  if (name === "ban") return handleBan(interaction);
  if (name === "timeout") return handleTimeout(interaction, false);
  if (name === "untimeout") return handleTimeout(interaction, true);

  return reply("Unknown command. Try `/help`.", { ephemeral: true });
}

// =======================
// HTTP Server
// =======================
const server = http.createServer((req, res) => {
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

