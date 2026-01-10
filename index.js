// index.js
require("dotenv").config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing DISCORD_TOKEN or CLIENT_ID");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});


// =====================
// COMMANDS
// =====================
const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is online"),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Show server info"),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to kick").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user")
    .addUserOption(opt => opt.setName("user").setDescription("User to ban").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a user")
    .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(opt => opt.setName("minutes").setDescription("Minutes").setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
].map(cmd => cmd.toJSON());


// =====================
// REGISTER COMMANDS
// =====================
const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("⏳ Registering commands...");
    await rest.put(
      Routes.applicationCommands(CLIENT_ID), // GLOBAL commands (all servers)
      { body: commands }
    );
    console.log("✅ Commands registered globally!");
  } catch (err) {
    console.error(err);
  }
})();


// =====================
// BOT LOGIC
// =====================
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply("🏓 Pong! Bot is online.");
  }

  if (interaction.commandName === "serverinfo") {
    return interaction.reply(`📊 Server: **${interaction.guild.name}**\n👥 Members: **${interaction.guild.memberCount}**`);
  }

  if (interaction.commandName === "kick") {
    const user = interaction.options.getUser("user");
    const member = interaction.guild.members.cache.get(user.id);

    if (!member) return interaction.reply({ content: "User not found.", ephemeral: true });

    await member.kick();
    return interaction.reply(`👢 Kicked ${user.tag}`);
  }

  if (interaction.commandName === "ban") {
    const user = interaction.options.getUser("user");
    await interaction.guild.members.ban(user.id);
    return interaction.reply(`🔨 Banned ${user.tag}`);
  }

  if (interaction.commandName === "timeout") {
    const user = interaction.options.getUser("user");
    const minutes = interaction.options.getInteger("minutes");
    const member = interaction.guild.members.cache.get(user.id);

    await member.timeout(minutes * 60 * 1000);
    return interaction.reply(`⏳ Timed out ${user.tag} for ${minutes} minutes`);
  }
});

client.login(TOKEN);
