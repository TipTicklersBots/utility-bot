"use strict";

/**
 * Utility Bot (discord.js v14) — Railway-ready
 *
 * REQUIRED ENV on Railway:
 *   DISCORD_TOKEN=your_bot_token
 *   CLIENT_ID=your_application_id   (same as "Application ID")
 *
 * OPTIONAL ENV:
 *   PORT=3000
 *   REGISTER_COMMANDS=true   (default true)
 *   CLEAR_GUILD_ID=123...    (optional: clears old guild commands causing duplicates)
 *
 * IMPORTANT:
 * - If you are using THIS discord.js Gateway bot:
 *   ✅ Leave "Interactions Endpoint URL" BLANK in the Dev Portal.
 *   ✅ Turn OFF "Requires OAuth2 Code Grant" in the Dev Portal.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  EmbedBuilder,
} = require("discord.js");

// =======================
// ENV
// =======================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const CLIENT_ID = process.env.CLIENT_ID || process.env.APPLICATION_ID || "";
const PORT = Number(process.env.PORT || 3000);
const REGISTER_COMMANDS =
  String(process.env.REGISTER_COMMANDS || "true").toLowerCase() === "true";

if (!DISCORD_TOKEN) {
  console.error("❌ Missing DISCORD_TOKEN env var");
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error("❌ Missing CLIENT_ID (Application ID) env var");
  process.exit(1);
}

// =======================
// Simple config storage
// =======================
const CONFIG_PATH = path.join(process.cwd(), "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return { guilds: {} };
  }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch {}
}
const config = loadConfig();

function guildCfg(guildId) {
  config.guilds[guildId] ||= { log_channel_id: null };
  return config.guilds[guildId];
}

async function sendLog(guild, content) {
  try {
    const cfg = guildCfg(guild.id);
    if (!cfg.log_channel_id) return;
    const ch = await guild.channels.fetch(cfg.log_channel_id).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ content }).catch(() => {});
  } catch {}
}

// =======================
// Duration parser for /timeout
// =======================
function parseDurationMs(input) {
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
// Commands (GLOBAL)
// =======================
const COMMANDS = [
  { name: "ping", description: "Check if the bot is online" },
  { name: "help", description: "Show bot help" },
  { name: "serverinfo", description: "Show server info" },
  {
    name: "setup",
    description: "Configure the bot for this server",
    default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
    dm_permission: false,
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "logs",
        description: "Set the log channel",
        options: [
          {
            type: 7, // CHANNEL
            name: "channel",
            description: "Channel to send logs to",
            required: true,
          },
        ],
      },
      { type: 1, name: "view", description: "View current config" },
    ],
  },
  {
    name: "purge",
    description: "Delete the last N messages (max 100, under 14 days old)",
    default_member_permissions: String(PermissionsBitField.Flags.ManageMessages),
    dm_permission: false,
    options: [
      {
        type: 4, // INTEGER
        name: "count",
        description: "How many? (1-100)",
        required: true,
        min_value: 1,
        max_value: 100,
      },
    ],
  },
  {
    name: "kick",
    description: "Kick a member",
    default_member_permissions: String(PermissionsBitField.Flags.KickMembers),
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to kick", required: true },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "ban",
    description: "Ban a member",
    default_member_permissions: String(PermissionsBitField.Flags.BanMembers),
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to ban", required: true },
      {
        type: 4,
        name: "delete_days",
        description: "Delete message history (0-7 days)",
        required: false,
        min_value: 0,
        max_value: 7,
      },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "timeout",
    description: "Timeout a member",
    default_member_permissions: String(
      PermissionsBitField.Flags.ModerateMembers
    ),
    dm_permission: false,
    options: [
      { type: 6, name: "user", description: "User to timeout", required: true },
      {
        type: 3,
        name: "duration",
        description: 'e.g. "10m", "1h", "1d" (max 28d)',
        required: true,
      },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
  {
    name: "untimeout",
    description: "Remove a member's timeout",
    default_member_permissions: String(
      PermissionsBitField.Flags.ModerateMembers
    ),
    dm_permission: false,
    options: [
      {
        type: 6,
        name: "user",
        description: "User to remove timeout from",
        required: true,
      },
      { type: 3, name: "reason", description: "Reason", required: false },
    ],
  },
];

// =======================
// Register commands globally
// =======================
async function registerCommands() {
  if (!REGISTER_COMMANDS) return;

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  console.log("⏳ Registering GLOBAL commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
  console.log("✅ Commands registered globally!");

  // OPTIONAL: clear old guild commands that cause duplicates
  const CLEAR_GUILD_ID = process.env.CLEAR_GUILD_ID || "";
  if (CLEAR_GUILD_ID) {
    console.log(`🧹 Clearing old guild commands in ${CLEAR_GUILD_ID}...`);
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, CLEAR_GUILD_ID),
      { body: [] }
    );
    console.log("✅ Cleared guild commands.");
  }
}

// =======================
// Discord client
// =======================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

function niceEmbed(title, fields = []) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .addFields(fields)
    .setTimestamp(new Date())
    .setFooter({ text: "Utility Bot" });
}

// =======================
// Express Interactions Endpoint
// =======================
const express = require("express");
const app = express();
app.use(express.json());

app.post("/api/interactions", (req, res) => {
  const interaction = req.body;

  // Discord PING request verification
  if (interaction.type === 1) return res.json({ type: 1 });

  // Example response for slash command
  if (interaction.type === 2)
    return res.json({
      type: 4,
      data: { content: "✅ Utility Bot is online and ready!" },
    });

  res.status(400).send("Unknown interaction type");
});

app.listen(PORT, () => console.log(`🌐 Interactions endpoint running on port ${PORT}`));

// =======================
// Original interaction handling
// =======================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // ... (existing command handling from your file remains unchanged) ...
    // You can copy your full interactionCreate code here (all the commands)
  } catch (err) {
    console.error("❌ interaction error:", err);

    const msg = `⚠️ Error: ${String(err.message || err).slice(0, 1800)}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(msg).catch(() => {});
    }
    return interaction.reply({ ephemeral: true, content: msg }).catch(() => {});
  }
});

// =======================
// Login + register commands
// =======================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("❌ Command registration failed:", e.message);
  }
});

client.login(DISCORD_TOKEN).catch((e) => {
  console.error("❌ Login failed:", e.message);
  process.exit(1);
});

// =======================
// Optional Railway web listener for "/"
// =======================
http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("✅ Utility Bot is running.\n");
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  })
  .listen(PORT, "0.0.0.0", () =>
    console.log(`🌐 Web listener (/) on port ${PORT}`)
  );

process.on("unhandledRejection", (e) => console.error("❌ unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));
