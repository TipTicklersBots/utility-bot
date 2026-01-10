/**
 * Zero-deps Discord moderation + setup bot (Interactions endpoint style).
 * Requires: Node 18+ (for global fetch).
 *
 * How it works:
 * - You host this as a web server.
 * - Discord sends slash command interactions to your endpoint.
 * - We verify requests using PUBLIC_KEY (Ed25519) with built-in crypto.
 * - We use Discord REST API to moderate + configure AutoMod rules.
 */

"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config(); // If you truly want ZERO deps, remove this line and set env vars in your host instead.

// --------------------
// ENV
// --------------------
const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.CLIENT_ID; // Application ID
const PUBLIC_KEY_HEX = process.env.PUBLIC_KEY; // from Discord dev portal
const PORT = Number(process.env.PORT || 3000);
const REGISTER_COMMANDS = String(process.env.REGISTER_COMMANDS || "false").toLowerCase() === "true";

if (!TOKEN || !APP_ID || !PUBLIC_KEY_HEX) {
  console.error("Missing env vars. Need DISCORD_TOKEN, CLIENT_ID, PUBLIC_KEY. (And PORT optional.)");
  process.exit(1);
}

// --------------------
// CONFIG STORAGE (local)
// --------------------
const CONFIG_PATH = path.join(process.cwd(), "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { guilds: {} };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

const config = loadConfig();

// --------------------
// DISCORD REST helper
// --------------------
async function discordApi(method, route, body) {
  const url = `https://discord.com/api/v10${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "zero-deps-mod-bot (node)",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Discord API error ${res.status} on ${method} ${route}: ${msg}`);
  }

  return json;
}

function isManageGuild(memberPermsIntString) {
  // Not reliable to parse without Gateway; we’ll enforce permissions at Discord level via default_member_permissions in commands.
  // Still, in case you want extra checks later.
  return true;
}

// --------------------
// Snowflake -> timestamp
// --------------------
function snowflakeToDate(id) {
  // Discord epoch: 2015-01-01
  const DISCORD_EPOCH = 1420070400000n;
  const n = BigInt(id);
  const ms = Number((n >> 22n) + DISCORD_EPOCH);
  return new Date(ms);
}

// --------------------
// Ed25519 verify (built-in crypto)
// Discord sends signature & timestamp headers.
// Verify signature over: timestamp + rawBody
// --------------------
function ed25519PublicKeyPemFromHex(hex) {
  // SubjectPublicKeyInfo DER prefix for Ed25519:
  // 302a300506032b6570032100 + 32-byte key
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("PUBLIC_KEY must be 32 bytes hex");
  const der = Buffer.concat([prefix, key]);
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

const PUBLIC_KEY_PEM = ed25519PublicKeyPemFromHex(PUBLIC_KEY_HEX);

function verifyDiscordRequest(signatureHex, timestamp, rawBody) {
  if (!signatureHex || !timestamp) return false;
  const msg = Buffer.from(timestamp + rawBody);
  const sig = Buffer.from(signatureHex, "hex");
  const keyObj = crypto.createPublicKey(PUBLIC_KEY_PEM);
  return crypto.verify(null, msg, keyObj, sig);
}

// --------------------
// Discord Interaction response helpers
// --------------------
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

// Interaction response types:
// 1 = PONG
// 4 = CHANNEL_MESSAGE_WITH_SOURCE
// 5 = DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
};

// --------------------
// Command registration (Guild commands for fast updates)
// --------------------
async function registerCommandsForGuild(guildId) {
  const commands = [
    {
      name: "serverinfo",
      description: "Show clean info about this server.",
    },
    {
      name: "setup",
      description: "Configure moderation & AutoMod for this server.",
      default_member_permissions: String(0x20), // Manage Guild (bit 5) — Discord checks this
      dm_permission: false,
      options: [
        {
          type: 1, // SUB_COMMAND
          name: "view",
          description: "View current setup for this server.",
        },
        {
          type: 1,
          name: "automod",
          description: "Apply AutoMod rules based on your settings.",
          options: [
            {
              type: 5, // BOOLEAN
              name: "anti_spam",
              description: "Block common spam (keyword presets).",
              required: false,
            },
            {
              type: 5,
              name: "mention_spam",
              description: "Limit mass mentions.",
              required: false,
            },
            {
              type: 4, // INTEGER
              name: "mention_limit",
              description: "Max mentions per message (default 5).",
              required: false,
              min_value: 1,
              max_value: 50,
            },
            {
              type: 5,
              name: "block_invites",
              description: "Block discord invite links.",
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: "logging",
          description: "Set the log channel for mod actions.",
          options: [
            {
              type: 7, // CHANNEL
              name: "channel",
              description: "Channel to send logs to.",
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: "timeout",
      description: "Timeout a member.",
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
      description: "Remove a member's timeout.",
      default_member_permissions: String(0x1_0000),
      dm_permission: false,
      options: [
        { type: 6, name: "user", description: "User to untimeout", required: true },
        { type: 3, name: "reason", description: "Reason", required: false },
      ],
    },
    {
      name: "kick",
      description: "Kick a member.",
      default_member_permissions: String(0x2), // Kick Members
      dm_permission: false,
      options: [
        { type: 6, name: "user", description: "User to kick", required: true },
        { type: 3, name: "reason", description: "Reason", required: false },
      ],
    },
    {
      name: "ban",
      description: "Ban a member.",
      default_member_permissions: String(0x4), // Ban Members
      dm_permission: false,
      options: [
        { type: 6, name: "user", description: "User to ban", required: true },
        { type: 4, name: "delete_days", description: "Delete message history days (0-7)", required: false, min_value: 0, max_value: 7 },
        { type: 3, name: "reason", description: "Reason", required: false },
      ],
    },
    {
      name: "unban",
      description: "Unban a user by ID.",
      default_member_permissions: String(0x4),
      dm_permission: false,
      options: [
        { type: 3, name: "user_id", description: "User ID to unban", required: true },
        { type: 3, name: "reason", description: "Reason", required: false },
      ],
    },
    {
      name: "purge",
      description: "Delete the last N messages in this channel (max 100).",
      default_member_permissions: String(0x2000), // Manage Messages
      dm_permission: false,
      options: [
        { type: 4, name: "count", description: "How many messages? (1-100)", required: true, min_value: 1, max_value: 100 },
        { type: 5, name: "include_bots", description: "Include bot messages? (default true)", required: false },
      ],
    },
  ];

  return discordApi(
    "PUT",
    `/applications/${APP_ID}/guilds/${guildId}/commands`,
    commands
  );
}

// --------------------
// Utils
// --------------------
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

function nowIso() {
  return new Date().toISOString();
}

function guildCfg(guildId) {
  config.guilds[guildId] ||= {
    logging_channel_id: null,
    automod: {
      anti_spam: true,
      mention_spam: true,
      mention_limit: 5,
      block_invites: false,
    },
    automod_rule_ids: [], // we’ll store created rule IDs
  };
  return config.guilds[guildId];
}

async function sendLog(guildId, content) {
  const cfg = guildCfg(guildId);
  if (!cfg.logging_channel_id) return;
  try {
    await discordApi("POST", `/channels/${cfg.logging_channel_id}/messages`, { content });
  } catch {
    // ignore
  }
}

function cleanBool(v, fallback) {
  if (typeof v === "boolean") return v;
  return fallback;
}

// --------------------
// AutoMod builder
// --------------------
async function clearOurAutomodRules(guildId) {
  const cfg = guildCfg(guildId);
  const ids = Array.isArray(cfg.automod_rule_ids) ? cfg.automod_rule_ids : [];
  for (const id of ids) {
    try {
      await discordApi("DELETE", `/guilds/${guildId}/auto-moderation/rules/${id}`);
    } catch {
      // ignore
    }
  }
  cfg.automod_rule_ids = [];
  saveConfig(config);
}

async function applyAutomod(guildId) {
  const cfg = guildCfg(guildId);

  // Remove previously created rules by THIS bot (stored IDs).
  await clearOurAutomodRules(guildId);

  const createdIds = [];

  // Rule 1: Anti-spam presets (block obvious scam terms)
  if (cfg.automod.anti_spam) {
    const rule = await discordApi("POST", `/guilds/${guildId}/auto-moderation/rules`, {
      name: "ServerShield • Anti-Spam Keywords",
      event_type: 1, // MESSAGE_SEND
      trigger_type: 1, // KEYWORD
      trigger_metadata: {
        keyword_filter: [
          "free nitro", "steam gift", "gift card", "crypto", "airdrop",
          "dm me", "check my profile", "onlyfans", "telegram", "whatsapp",
          "click here", "limited time", "giveaway ends", "verify account",
        ],
        regex_patterns: [],
        allow_list: [],
      },
      actions: [
        { type: 1, metadata: { custom_message: "Message blocked by AutoMod: suspected spam." } }, // BLOCK_MESSAGE
      ],
      enabled: true,
      exempt_roles: [],
      exempt_channels: [],
    });
    createdIds.push(rule.id);
  }

  // Rule 2: Mention spam
  if (cfg.automod.mention_spam) {
    const limit = cfg.automod.mention_limit || 5;
    const rule = await discordApi("POST", `/guilds/${guildId}/auto-moderation/rules`, {
      name: `ServerShield • Mention Limit (${limit})`,
      event_type: 1,
      trigger_type: 5, // MENTION_SPAM
      trigger_metadata: { mention_total_limit: limit },
      actions: [
        { type: 1, metadata: { custom_message: `Too many mentions in one message (limit: ${limit}).` } },
      ],
      enabled: true,
      exempt_roles: [],
      exempt_channels: [],
    });
    createdIds.push(rule.id);
  }

  // Rule 3: Block invite links
  if (cfg.automod.block_invites) {
    const rule = await discordApi("POST", `/guilds/${guildId}/auto-moderation/rules`, {
      name: "ServerShield • Block Invite Links",
      event_type: 1,
      trigger_type: 1, // KEYWORD
      trigger_metadata: {
        keyword_filter: [
          "discord.gg/", "discord.com/invite/", "discordapp.com/invite/",
        ],
        regex_patterns: [],
        allow_list: [],
      },
      actions: [
        { type: 1, metadata: { custom_message: "Invite links are not allowed here." } },
      ],
      enabled: true,
      exempt_roles: [],
      exempt_channels: [],
    });
    createdIds.push(rule.id);
  }

  cfg.automod_rule_ids = createdIds;
  saveConfig(config);
  return createdIds;
}

// --------------------
// Interaction handlers
// --------------------
function replyMessage(content, { ephemeral = false, embeds = null } = {}) {
  const data = { content };
  if (ephemeral) data.flags = 64; // EPHEMERAL
  if (embeds) data.embeds = embeds;
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  };
}

function embed(title, fields = [], extra = {}) {
  return {
    title,
    color: 0x5865F2,
    fields,
    timestamp: nowIso(),
    ...extra,
  };
}

async function handleServerInfo(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return replyMessage("This command only works in a server.", { ephemeral: true });

  const g = await discordApi("GET", `/guilds/${guildId}?with_counts=true`);
  const ownerId = g.owner_id;
  const created = snowflakeToDate(g.id);
  const boosts = g.premium_subscription_count ?? 0;
  const boostTier = g.premium_tier ?? 0;

  const fields = [
    { name: "Owner", value: `<@${ownerId}> (\`${ownerId}\`)`, inline: false },
    { name: "Created", value: `<t:${Math.floor(created.getTime() / 1000)}:F>`, inline: true },
    { name: "Members", value: String(g.approximate_member_count ?? "Unknown"), inline: true },
    { name: "Boosts", value: `${boosts} (Tier ${boostTier})`, inline: true },
    { name: "Verification", value: String(g.verification_level ?? 0), inline: true },
    { name: "Locale", value: g.preferred_locale ?? "Unknown", inline: true },
  ];

  const e = embed(`📌 Server Info — ${g.name}`, fields, {
    thumbnail: g.icon ? { url: `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=256` } : undefined,
  });

  return replyMessage("", { embeds: [e] });
}

async function handleSetup(interaction) {
  const guildId = interaction.guild_id;
  if (!guildId) return replyMessage("This command only works in a server.", { ephemeral: true });

  const sub = interaction.data?.options?.[0]?.name; // view | logging | automod
  const cfg = guildCfg(guildId);

  if (sub === "view" || !sub) {
    const fields = [
      { name: "Log Channel", value: cfg.logging_channel_id ? `<#${cfg.logging_channel_id}>` : "Not set", inline: false },
      { name: "Anti-Spam", value: cfg.automod.anti_spam ? "✅ On" : "❌ Off", inline: true },
      { name: "Mention Spam", value: cfg.automod.mention_spam ? `✅ On (limit ${cfg.automod.mention_limit})` : "❌ Off", inline: true },
      { name: "Block Invites", value: cfg.automod.block_invites ? "✅ On" : "❌ Off", inline: true },
      { name: "AutoMod Rules Managed", value: String(cfg.automod_rule_ids?.length || 0), inline: true },
    ];
    const e = embed("🛡️ Setup — Current Settings", fields, {
      description:
        "Use `/setup logging` to set logs.\nUse `/setup automod` to apply AutoMod rules.\n\nTip: AutoMod runs even when this bot is offline.",
    });
    return replyMessage("", { embeds: [e], ephemeral: true });
  }

  if (sub === "logging") {
    const channelOpt = interaction.data.options?.[0]?.options?.find(o => o.name === "channel");
    const channelId = channelOpt?.value;

    cfg.logging_channel_id = channelId;
    saveConfig(config);

    return replyMessage(`✅ Logging channel set to <#${channelId}>`, { ephemeral: true });
  }

  if (sub === "automod") {
    const opts = interaction.data.options?.[0]?.options || [];

    const getOpt = (name) => opts.find(o => o.name === name)?.value;

    cfg.automod.anti_spam = cleanBool(getOpt("anti_spam"), cfg.automod.anti_spam);
    cfg.automod.mention_spam = cleanBool(getOpt("mention_spam"), cfg.automod.mention_spam);
    cfg.automod.block_invites = cleanBool(getOpt("block_invites"), cfg.automod.block_invites);

    const mentionLimit = getOpt("mention_limit");
    if (typeof mentionLimit === "number") cfg.automod.mention_limit = mentionLimit;

    saveConfig(config);

    const ids = await applyAutomod(guildId);
    await sendLog(guildId, `🛡️ AutoMod applied by <@${interaction.member?.user?.id || interaction.user?.id}> • Rules created: ${ids.length}`);

    const fields = [
      { name: "Anti-Spam", value: cfg.automod.anti_spam ? "✅ On" : "❌ Off", inline: true },
      { name: "Mention Spam", value: cfg.automod.mention_spam ? `✅ On (limit ${cfg.automod.mention_limit})` : "❌ Off", inline: true },
      { name: "Block Invites", value: cfg.automod.block_invites ? "✅ On" : "❌ Off", inline: true },
      { name: "Rules Created", value: String(ids.length), inline: true },
    ];

    const e = embed("✅ Setup — AutoMod Applied", fields, {
      description: "Your server now has AutoMod rules that help block spam and abuse.\nYou can re-run `/setup automod` anytime to change them.",
    });

    return replyMessage("", { embeds: [e], ephemeral: true });
  }

  return replyMessage("Unknown setup option.", { ephemeral: true });
}

async function handleTimeout(interaction, untimeout = false) {
  const guildId = interaction.guild_id;
  const opts = interaction.data.options || [];
  const userId = opts.find(o => o.name === "user")?.value;
  const reason = opts.find(o => o.name === "reason")?.value || "No reason provided.";

  if (!guildId || !userId) return replyMessage("Missing guild/user.", { ephemeral: true });

  let untilIso = null;
  if (!untimeout) {
    const durationStr = opts.find(o => o.name === "duration")?.value;
    const ms = parseDurationToMs(durationStr);
    if (!ms || ms < 5_000 || ms > 28 * 24 * 60 * 60 * 1000) {
      return replyMessage('Invalid duration. Use like "10m", "1h", "1d". Max is 28d.', { ephemeral: true });
    }
    untilIso = new Date(Date.now() + ms).toISOString();
  }

  await discordApi("PATCH", `/guilds/${guildId}/members/${userId}`, {
    communication_disabled_until: untimeout ? null : untilIso,
    reason,
  });

  const actionText = untimeout ? "✅ Timeout removed" : "⏳ User timed out";
  await sendLog(guildId, `${actionText}: <@${userId}> • Reason: ${reason}`);

  return replyMessage(`${actionText} for <@${userId}>.`, { ephemeral: true });
}

async function handleKickBan(interaction, mode) {
  const guildId = interaction.guild_id;
  const opts = interaction.data.options || [];
  const userId = opts.find(o => o.name === "user")?.value;
  const reason = opts.find(o => o.name === "reason")?.value || "No reason provided.";

  if (!guildId || !userId) return replyMessage("Missing guild/user.", { ephemeral: true });

  if (mode === "kick") {
    await discordApi("DELETE", `/guilds/${guildId}/members/${userId}`, { reason });
    await sendLog(guildId, `👢 Kicked: <@${userId}> • Reason: ${reason}`);
    return replyMessage(`👢 Kicked <@${userId}>.`, { ephemeral: true });
  }

  if (mode === "ban") {
    const deleteDays = opts.find(o => o.name === "delete_days")?.value ?? 0;
    await discordApi("PUT", `/guilds/${guildId}/bans/${userId}?delete_message_seconds=${deleteDays * 86400}`, { reason });
    await sendLog(guildId, `🔨 Banned: <@${userId}> • Deleted days: ${deleteDays} • Reason: ${reason}`);
    return replyMessage(`🔨 Banned <@${userId}>.`, { ephemeral: true });
  }

  return replyMessage("Unknown action.", { ephemeral: true });
}

async function handleUnban(interaction) {
  const guildId = interaction.guild_id;
  const opts = interaction.data.options || [];
  const userId = String(opts.find(o => o.name === "user_id")?.value || "").trim();
  const reason = opts.find(o => o.name === "reason")?.value || "No reason provided.";

  if (!guildId || !userId) return replyMessage("Missing guild/user_id.", { ephemeral: true });

  await discordApi("DELETE", `/guilds/${guildId}/bans/${userId}`, { reason });
  await sendLog(guildId, `✅ Unbanned: \`${userId}\` • Reason: ${reason}`);

  return replyMessage(`✅ Unbanned \`${userId}\`.`, { ephemeral: true });
}

async function handlePurge(interaction) {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  const opts = interaction.data.options || [];

  const count = opts.find(o => o.name === "count")?.value;
  const includeBots = opts.find(o => o.name === "include_bots")?.value;
  const include = typeof includeBots === "boolean" ? includeBots : true;

  if (!guildId || !channelId || !count) return replyMessage("Missing channel/count.", { ephemeral: true });

  // Fetch last N messages
  const messages = await discordApi("GET", `/channels/${channelId}/messages?limit=${Math.min(100, count)}`);
  const ids = messages
    .filter(m => include || !m.author?.bot)
    .map(m => m.id);

  if (ids.length === 0) return replyMessage("Nothing to delete (based on your filters).", { ephemeral: true });

  // Bulk delete only works for messages < 14 days old, Discord will error otherwise.
  // We'll attempt bulk delete; if it fails, tell user.
  try {
    await discordApi("POST", `/channels/${channelId}/messages/bulk-delete`, { messages: ids });
  } catch (e) {
    return replyMessage("⚠️ Could not bulk delete. Messages might be older than 14 days, or I lack permissions.", { ephemeral: true });
  }

  await sendLog(guildId, `🧹 Purge: deleted ${ids.length} message(s) in <#${channelId}> by <@${interaction.member?.user?.id || interaction.user?.id}>`);
  return replyMessage(`🧹 Deleted **${ids.length}** message(s).`, { ephemeral: true });
}

// --------------------
// Main interaction router
// --------------------
async function handleInteraction(interaction) {
  // PING from Discord
  if (interaction.type === 1) {
    return { type: InteractionResponseType.PONG };
  }

  const name = interaction.data?.name;

  if (name === "serverinfo") return handleServerInfo(interaction);
  if (name === "setup") return handleSetup(interaction);
  if (name === "timeout") return handleTimeout(interaction, false);
  if (name === "untimeout") return handleTimeout(interaction, true);
  if (name === "kick") return handleKickBan(interaction, "kick");
  if (name === "ban") return handleKickBan(interaction, "ban");
  if (name === "unban") return handleUnban(interaction);
  if (name === "purge") return handlePurge(interaction);

  return replyMessage("Unknown command.", { ephemeral: true });
}

// --------------------
// HTTP server
// --------------------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK - Discord interactions endpoint is running.");
  }

  if (req.method !== "POST" || req.url !== "/interactions") {
    res.writeHead(404);
    return res.end("Not found");
  }

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    try {
      const isValid = verifyDiscordRequest(signature, timestamp, raw);
      if (!isValid) return json(res, 401, { error: "invalid request signature" });

      const interaction = JSON.parse(raw);
      const response = await handleInteraction(interaction);
      return json(res, 200, response);
    } catch (e) {
      console.error(e);
      return json(res, 500, { error: "server error" });
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`➡️ Set Discord Interactions Endpoint URL to: https://YOUR_DOMAIN/interactions`);
});

// --------------------
// Optional: command registration
// This requires you to run / use the bot in a guild first (we need a guild id).
// Easiest: temporarily set a GUILD_ID env var and register on startup.
// --------------------
(async () => {
  const GUILD_ID = process.env.GUILD_ID;
  if (REGISTER_COMMANDS) {
    if (!GUILD_ID) {
      console.warn("REGISTER_COMMANDS=true but no GUILD_ID set. Add GUILD_ID to .env to auto-register commands.");
      return;
    }
    try {
      await registerCommandsForGuild(GUILD_ID);
      console.log(`✅ Commands registered for guild ${GUILD_ID}`);
    } catch (e) {
      console.error("Command registration failed:", e.message);
    }
  }
})();
