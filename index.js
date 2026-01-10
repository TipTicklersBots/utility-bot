"use strict";

/**
 * Utility Bot (discord.js) + Railway-friendly web listener
 *
 * REQUIRED ENV:
 *   DISCORD_TOKEN=your_bot_token
 *   CLIENT_ID=your_application_id
 *
 * OPTIONAL ENV:
 *   REGISTER_COMMANDS=true   (default true)
 *   PORT=3000                (Railway sets this)
 *
 * Notes:
 * - This is a normal Gateway bot (discord.js). You DO NOT need Interactions Endpoint URL set in the Dev Portal.
 * - Railway public URL will work because we run a small HTTP server.
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
// Simple config storage (logs channel per guild)
// NOTE: Railway disk can reset on redeploy. This is "best effort" storage.
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
      {
        type: 1,
        name: "view",
        description: "View current config",
      },
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

  console.log("⏳ Registering global commands...");
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS });
  console.log("✅ Commands registered globally!");
}

// =======================
// Discord client
// =======================
// Key intent: Guilds (required for slash commands)
// GuildMembers helps moderation/member fetch (recommended)
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// =======================
// Helpers
// =======================
function niceEmbed(title, fields = [], extra = {}) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .addFields(fields)
    .setTimestamp(new Date())
    .setFooter({ text: "Utility Bot" })
    .setDescription(extra.description || null)
    .setThumbnail(extra.thumbnail || null);
}

// =======================
// Interaction handler
// =======================
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === "ping") {
      return interaction.reply({ content: "🏓 Pong!", ephemeral: true });
    }

    if (commandName === "help") {
      return interaction.reply({
        ephemeral: true,
        content: [
          "**Utility Bot Commands**",
          "",
          "• `/ping`",
          "• `/serverinfo`",
          "• `/setup view`",
          "• `/setup logs channel:#channel`",
          "• `/purge count:1-100`",
          "• `/kick user:`",
          "• `/ban user: delete_days: reason:`",
          "• `/timeout user: duration: reason:`",
          "• `/untimeout user: reason:`",
        ].join("\n"),
      });
    }

    if (commandName === "serverinfo") {
      if (!interaction.guild)
        return interaction.reply({
          content: "Run this inside a server.",
          ephemeral: true,
        });

      const g = interaction.guild;
      const owner = await g.fetchOwner().catch(() => null);

      const boosts = g.premiumSubscriptionCount ?? 0;
      const tier = g.premiumTier ?? 0;

      const e = niceEmbed(`📌 Server Info — ${g.name}`, [
        {
          name: "Owner",
          value: owner ? `${owner.user} (\`${owner.id}\`)` : "Unknown",
          inline: false,
        },
        {
          name: "Created",
          value: `<t:${Math.floor(g.createdTimestamp / 1000)}:F>`,
          inline: true,
        },
        { name: "Members", value: `${g.memberCount}`, inline: true },
        { name: "Boosts", value: `${boosts} (Tier ${tier})`, inline: true },
        { name: "Server ID", value: `\`${g.id}\``, inline: false },
      ]);

      if (g.iconURL()) e.setThumbnail(g.iconURL({ size: 256 }));

      return interaction.reply({ embeds: [e] });
    }

    if (commandName === "setup") {
      if (!interaction.guild)
        return interaction.reply({
          content: "Run this inside a server.",
          ephemeral: true,
        });

      const sub = interaction.options.getSubcommand(true);
      const cfg = guildCfg(interaction.guild.id);

      if (sub === "view") {
        return interaction.reply({
          ephemeral: true,
          content: [
            "**⚙️ Current Setup**",
            `Log channel: ${
              cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : "Not set"
            }`,
            "",
            "Use `/setup logs channel:#your-channel` to set logs.",
          ].join("\n"),
        });
      }

      if (sub === "logs") {
        const channel = interaction.options.getChannel("channel", true);
        cfg.log_channel_id = channel.id;
        saveConfig(config);

        await interaction.reply({
          ephemeral: true,
          content: `✅ Log channel set to ${channel}`,
        });
        await sendLog(
          interaction.guild,
          `🧾 Logging enabled in ${channel} by ${interaction.user}`
        );
        return;
      }
    }

    if (commandName === "purge") {
      if (!interaction.guild || !interaction.channel || !interaction.channel.isTextBased())
        return interaction.reply({
          content: "Run this in a server text channel.",
          ephemeral: true,
        });

      const count = interaction.options.getInteger("count", true);

      await interaction.deferReply({ ephemeral: true });

      // Fetch & bulk delete
      const messages = await interaction.channel.messages.fetch({ limit: count });
      const deleted = await interaction.channel
        .bulkDelete(messages, true)
        .catch(() => null);

      if (!deleted) {
        return interaction.editReply(
          "⚠️ Could not bulk delete. Messages may be older than 14 days, or I lack permission."
        );
      }

      await interaction.editReply(`🧹 Deleted **${deleted.size}** message(s).`);
      await sendLog(
        interaction.guild,
        `🧹 Purge: ${deleted.size} in ${interaction.channel} by ${interaction.user}`
      );
      return;
    }

    if (commandName === "kick") {
      if (!interaction.guild)
        return interaction.reply({
          content: "Run this inside a server.",
          ephemeral: true,
        });

      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";

      await interaction.deferReply({ ephemeral: true });

      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("User not found in this server.");

      await member.kick(reason).catch((e) => {
        throw new Error(`Kick failed: ${e.message}`);
      });

      await interaction.editReply(`👢 Kicked ${user}.`);
      await sendLog(
        interaction.guild,
        `👢 Kicked ${user} • By: ${interaction.user} • Reason: ${reason}`
      );
      return;
    }

    if (commandName === "ban") {
      if (!interaction.guild)
        return interaction.reply({
          content: "Run this inside a server.",
          ephemeral: true,
        });

      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";
      const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

      await interaction.deferReply({ ephemeral: true });

      await interaction.guild.members
        .ban(user.id, { reason, deleteMessageSeconds: deleteDays * 86400 })
        .catch((e) => {
          throw new Error(`Ban failed: ${e.message}`);
        });

      await interaction.editReply(`🔨 Banned ${user}.`);
      await sendLog(
        interaction.guild,
        `🔨 Banned ${user} • Deleted days: ${deleteDays} • By: ${interaction.user} • Reason: ${reason}`
      );
      return;
    }

    if (commandName === "timeout" || commandName === "untimeout") {
      if (!interaction.guild)
        return interaction.reply({
          content: "Run this inside a server.",
          ephemeral: true,
        });

      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason provided.";

      await interaction.deferReply({ ephemeral: true });

      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("User not found in this server.");

      if (commandName === "untimeout") {
        await member.timeout(null, reason).catch((e) => {
          throw new Error(`Remove timeout failed: ${e.message}`);
        });

        await interaction.editReply(`✅ Timeout removed for ${user}.`);
        await sendLog(
          interaction.guild,
          `✅ Timeout removed: ${user} • By: ${interaction.user} • Reason: ${reason}`
        );
        return;
      }

      // timeout
      const duration = interaction.options.getString("duration", true);
      const ms = parseDurationMs(duration);

      if (!ms || ms < 5000 || ms > 28 * 24 * 60 * 60 * 1000) {
        return interaction.editReply(
          'Invalid duration. Use like "10m", "1h", "1d". Max 28d.'
        );
      }

      await member.timeout(ms, reason).catch((e) => {
        throw new Error(`Timeout failed: ${e.message}`);
      });

      await interaction.editReply(`⏳ Timed out ${user} for **${duration}**.`);
      await sendLog(
        interaction.guild,
        `⏳ Timed out: ${user} • For: ${duration} • By: ${interaction.user} • Reason: ${reason}`
      );
      return;
    }

    // Fallback
    return interaction.reply({
      content: "Unknown command.",
      ephemeral: true,
    });
  } catch (err) {
    console.error("❌ interaction error:", err);

    // Always try to respond so Discord doesn't say "did not respond"
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply(
        `⚠️ Error: ${String(err.message || err).slice(0, 1800)}`
      ).catch(() => {});
    }
    return interaction
      .reply({
        ephemeral: true,
        content: `⚠️ Error: ${String(err.message || err).slice(0, 1800)}`,
      })
      .catch(() => {});
  }
});

// =======================
// Login + register commands
// =======================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register global commands (works in any server, may take a bit to show)
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
// Railway web listener (fixes "Application failed to respond" on your domain)
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
  .listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Web listener on port ${PORT}`);
  });

// Crash safety
process.on("unhandledRejection", (e) =>
  console.error("❌ unhandledRejection:", e)
);
process.on("uncaughtException", (e) => console.error("❌ uncaughtException:", e));
