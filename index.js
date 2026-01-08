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
const express = require("express");

// Keep-alive server for Replit
const app = express();
app.get("/", (_, res) => res.send("Bot is alive!"));
app.listen(process.env.PORT || 5000, () => console.log("Keep-alive server running"));

// ================= SETTINGS =================
const HOST_ROLE_NAME = "Trusted Draft Host";
// ===========================================

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

// Map drafts by text channel ID
const drafts = new Map();

// ---------- HELPERS ----------
function getBaseNick(member) {
  return member.nickname
    ? member.nickname.replace(/\s*\(🏆.*?\)$/, "")
    : member.user.username;
}

async function setNick(member, stats) {
  const base = getBaseNick(member);
  const nick = `${base} (🏆${stats.wins}❌${stats.losses}🔥${stats.streak})`;
  await member.setNickname(nick).catch(() => {});
}

// ---------- READY ----------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- INTERACTIONS ----------
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  const guild = interaction.guild;
  const member = interaction.member;

  // ---------- HOST CHECK ----------
  if (!member.roles.cache.some(r => r.name === HOST_ROLE_NAME) && member.id !== guild.ownerId) {
    return interaction.reply({ content: "❌ Only Trusted Draft Host can use this.", ephemeral: true });
  }

  // ---------- RANDOM TEAMS ----------
  if (interaction.customId === "random_teams") {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: "❌ Join a VC first.", ephemeral: true });
    if ([...drafts.values()].some(d => d.vc.id === vc.id)) 
      return interaction.reply({ content: "❌ Draft already active in this VC.", ephemeral: true });

    const players = [...vc.members.values()];
    if (players.length < 2) return interaction.reply({ content: "❌ Not enough players in VC.", ephemeral: true });

    players.sort(() => Math.random() - 0.5);
    const half = Math.ceil(players.length / 2);
    const team1 = players.slice(0, half);
    const team2 = players.slice(half);

    const draftId = Math.floor(Math.random() * 9999);

    // Create draft role
    const draftRole = await guild.roles.create({
      name: `draft-${draftId}`,
      reason: "Draft role for temporary access"
    });
    for (const p of players) await p.roles.add(draftRole);

    // Save original VC of each member
    const originalVCs = {};
    for (const p of players) originalVCs[p.id] = p.voice.channelId;

    // Draft text channel
    const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes("Community"));
    const draftText = await guild.channels.create({
      name: `draft-${draftId}`,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: draftRole.id, allow: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("start_game").setLabel("▶️ Start Game").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("shuffle").setLabel("🔀 Shuffle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("t1_win").setLabel("🏆 Team 1 Wins").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("t2_win").setLabel("🏆 Team 2 Wins").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("end_game").setLabel("❌ End Game").setStyle(ButtonStyle.Danger)
    );

    await draftText.send({
      content:
        `<@&${draftRole.id}>\n\n**Team 1:**\n${team1.map(m => getBaseNick(m)).join("\n")}\n\n**Team 2:**\n${team2.map(m => getBaseNick(m)).join("\n")}`,
      components: [buttons]
    });

    drafts.set(draftText.id, {
      vc,
      draftRole,
      draftText,
      team1,
      team2,
      originalVCs,
      tempVCs: [],
      draftId,
      host: member.user.id, // store host ID for button checks
      vcCount: 1
    });

    return interaction.reply({ content: "✅ Draft created.", ephemeral: true });
  }

  // ---------- DRAFT ACTIONS ----------
  const draft = drafts.get(interaction.channel.id);
  if (!draft) return interaction.reply({ content: "❌ No active draft here.", ephemeral: true });

  // ---------- BUTTON HOST CHECK ----------
  if (member.id !== draft.host && member.id !== guild.ownerId) {
    return interaction.reply({ content: "❌ Only the draft host can use these buttons.", ephemeral: true });
  }

  // Shuffle
  if (interaction.customId === "shuffle") {
    const allPlayers = [...draft.team1, ...draft.team2].sort(() => Math.random() - 0.5);
    const half = Math.ceil(allPlayers.length / 2);
    draft.team1 = allPlayers.slice(0, half);
    draft.team2 = allPlayers.slice(half);

    await interaction.deferUpdate();
    await draft.draftText.bulkDelete(5).catch(() => {});
    return draft.draftText.send({
      content:
        `<@&${draft.draftRole.id}>\n\n**Team 1:**\n${draft.team1.map(m => getBaseNick(m)).join("\n")}\n\n**Team 2:**\n${draft.team2.map(m => getBaseNick(m)).join("\n")}`,
      components: interaction.message.components
    });
  }

  // Start Game
  if (interaction.customId === "start_game") {
    const cat = draft.draftText.parent;

    draft.vcCount++;
    const t1VC = await guild.channels.create({
      name: `Draft VC ${draft.vcCount} - Hosted by ${member.user.username}`,
      type: ChannelType.GuildVoice,
      parent: cat?.id,
      userLimit: draft.team1.length
    });
    draft.vcCount++;
    const t2VC = await guild.channels.create({
      name: `Draft VC ${draft.vcCount} - Hosted by ${member.user.username}`,
      type: ChannelType.GuildVoice,
      parent: cat?.id,
      userLimit: draft.team2.length
    });

    draft.tempVCs.push(t1VC, t2VC);

    for (const p of draft.team1) await p.voice.setChannel(t1VC).catch(() => {});
    for (const p of draft.team2) await p.voice.setChannel(t2VC).catch(() => {});

    return interaction.reply({ content: "▶️ Game started.", ephemeral: true });
  }

  // End / Win
  if (["end_game", "t1_win", "t2_win"].includes(interaction.customId)) {
    const winTeam = interaction.customId === "t1_win" ? draft.team1 : interaction.customId === "t2_win" ? draft.team2 : null;
    const loseTeam = interaction.customId === "t1_win" ? draft.team2 : interaction.customId === "t2_win" ? draft.team1 : null;

    if (winTeam) {
      for (const m of winTeam) {
        m.stats ??= { wins: 0, losses: 0, streak: 0 };
        m.stats.wins++; m.stats.streak++;
        await setNick(m, m.stats);
      }
      for (const m of loseTeam) {
        m.stats ??= { wins: 0, losses: 0, streak: 0 };
        m.stats.losses++; m.stats.streak = 0;
        await setNick(m, m.stats);
      }
    }

    for (const p of [...draft.team1, ...draft.team2]) {
      const vcId = draft.originalVCs[p.id];
      if (vcId) await p.voice.setChannel(vcId).catch(() => {});
    }

    for (const vc of draft.tempVCs) await vc.delete().catch(() => {});
    await draft.draftText.delete().catch(() => {});
    await draft.draftRole.delete().catch(() => {});
    drafts.delete(interaction.channel.id);

    return interaction.reply({ content: "✅ Draft finished.", ephemeral: true });
  }
});

// ---------- LOGIN ----------
client.login(process.env.TOKEN);

