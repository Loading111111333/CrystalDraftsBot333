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

// ===== Express Keep-Alive Server =====
const app = express();
app.get("/", (_, res) => res.send("Bot is alive"));
app.listen(process.env.PORT || 5000, () => console.log("Server running"));

// ===== Bot Setup =====
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

const HOST_ROLE_NAME = "Trusted Draft Host";

// Active drafts map
const drafts = new Map();

// ---------- Helpers ----------
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

function formatMember(member) {
  member.stats ??= { wins: 0, losses: 0, streak: 0 };
  return `${getBaseNick(member)} (🏆${member.stats.wins}❌${member.stats.losses}🔥${member.stats.streak})`;
}

// ---------- Ready ----------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------- Button Interactions ----------
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  const guild = interaction.guild;
  const member = interaction.member;

  // Only host or owner can click
  if (
    !member.roles.cache.some(r => r.name === HOST_ROLE_NAME) &&
    member.id !== guild.ownerId
  ) return interaction.reply({ content: "❌ Host only.", ephemeral: true });

  // ---------- Random Teams ----------
  if (interaction.customId === "random_teams") {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: "❌ Join a VC first.", ephemeral: true });
    if (drafts.has(vc.id)) return interaction.reply({ content: "❌ Draft already active here.", ephemeral: true });

    const players = [...vc.members.values()];
    if (players.length < 2) return interaction.reply({ content: "❌ Not enough players.", ephemeral: true });

    // Shuffle teams
    players.sort(() => Math.random() - 0.5);
    const half = Math.ceil(players.length / 2);
    const team1 = players.slice(0, half);
    const team2 = players.slice(half);

    // Create draft role
    const draftId = Math.floor(Math.random() * 9999);
    const draftRole = await guild.roles.create({ name: `draft-${draftId}`, reason: "Draft access" });
    for (const p of players) await p.roles.add(draftRole);

    // Save original VC
    const originalVCs = {};
    for (const p of players) originalVCs[p.id] = p.voice.channelId;

    // Create draft text channel
    const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes("Community"));
    const draftChannel = await guild.channels.create({
      name: `draft-${draftId}`,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: draftRole.id, allow: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });

    // Buttons
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("shuffle").setLabel("🔀 Shuffle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("start_game").setLabel("▶️ Start Game").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("t1_win").setLabel("🏆 Team 1 Wins").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("t2_win").setLabel("🏆 Team 2 Wins").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("end_game").setLabel("❌ End Game").setStyle(ButtonStyle.Danger)
    );

    // Send draft info and ping
    await draftChannel.send({
      content: `<@&${draftRole.id}>\n\n**Team 1:**\n${team1.map(formatMember).join("\n")}\n\n**Team 2:**\n${team2.map(formatMember).join("\n")}`,
      components: [buttons]
    });

    drafts.set(vc.id, { vc, draftRole, draftChannel, team1, team2, originalVCs, tempVCs: [], draftId });
    return interaction.reply({ content: "✅ Draft created.", ephemeral: true });
  }

  // ---------- Draft Buttons ----------
  const draft = [...drafts.values()].find(d => d.draftChannel.id === interaction.channel.id);
  if (!draft) return interaction.reply({ content: "❌ No active draft here.", ephemeral: true });

  const { team1, team2, draftChannel, draftRole, originalVCs } = draft;

  if (interaction.customId === "shuffle") {
    const all = [...team1, ...team2].sort(() => Math.random() - 0.5);
    const half = Math.ceil(all.length / 2);
    draft.team1 = all.slice(0, half);
    draft.team2 = all.slice(half);

    await interaction.deferUpdate();
    await draftChannel.bulkDelete(5).catch(() => {});
    return draftChannel.send({
      content: `**Team 1:**\n${draft.team1.map(formatMember).join("\n")}\n\n**Team 2:**\n${draft.team2.map(formatMember).join("\n")}`,
      components: interaction.message.components
    });
  }

  // Start Game
  if (interaction.customId === "start_game") {
    const category = draftChannel.parent;

    const t1VC = await guild.channels.create({
      name: `Team 1 VC Draft ${draft.draftId}`,
      type: ChannelType.GuildVoice,
      parent: category?.id,
      userLimit: draft.team1.length
    });
    const t2VC = await guild.channels.create({
      name: `Team 2 VC Draft ${draft.draftId}`,
      type: ChannelType.GuildVoice,
      parent: category?.id,
      userLimit: draft.team2.length
    });

    draft.tempVCs = [t1VC, t2VC];

    for (const p of draft.team1) await p.voice.setChannel(t1VC).catch(() => {});
    for (const p of draft.team2) await p.voice.setChannel(t2VC).catch(() => {});

    return interaction.reply({ content: "▶️ Teams moved to VCs!", ephemeral: true });
  }

  // End / Win
  if (["end_game", "t1_win", "t2_win"].includes(interaction.customId)) {
    const winningTeam = interaction.customId === "t1_win" ? draft.team1 : interaction.customId === "t2_win" ? draft.team2 : null;
    const losingTeam = interaction.customId === "t1_win" ? draft.team2 : interaction.customId === "t2_win" ? draft.team1 : null;

    if (winningTeam) {
      for (const m of winningTeam) { m.stats ??= { wins: 0, losses: 0, streak: 0 }; m.stats.wins++; m.stats.streak++; await setNick(m, m.stats); }
      for (const m of losingTeam) { m.stats ??= { wins: 0, losses: 0, streak: 0 }; m.stats.losses++; m.stats.streak=0; await setNick(m, m.stats); }
    }

    // Move all back to original VC
    for (const p of [...draft.team1, ...draft.team2]) {
      const vcId = originalVCs[p.id];
      if (vcId) await p.voice.setChannel(vcId).catch(() => {});
    }

    // Cleanup
    for (const vc of draft.tempVCs) await vc.delete().catch(() => {});
    await draftChannel.delete().catch(() => {});
    await draftRole.delete().catch(() => {});
    drafts.delete(draft.vc.id);

    return interaction.reply({ content: "✅ Draft finished.", ephemeral: true });
  }
});

// ---------- Login ----------
client.login(process.env.TOKEN);

