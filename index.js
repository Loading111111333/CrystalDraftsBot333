const express = require("express");
const app = express();

app.get("/", (req, res) => res.send("Bot is alive"));
app.listen(process.env.PORT || 3000, () => console.log("Web server running"));

const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  PermissionsBitField, 
  ChannelType 
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ================= SETTINGS =================
const HOST_ROLE_NAME = "Trusted Draft Host";
// ===========================================

// Active drafts per VC
const drafts = new Map();

// ---------- HELPERS ----------
function getBaseNick(member) {
  return member.nickname
    ? member.nickname.replace(/\s*\(🏆.*?\)$/, "")


