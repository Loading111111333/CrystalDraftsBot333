const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder
} = require("discord.js");

// ================= SETTINGS =================
const HOST_ROLE_NAME = "Trusted Draft Host";
const DRAFT_ALERTS_CHANNEL = "drafts-alerts";
const DRAFT_HOST_CHANNEL = "drafts-host";

// Team Colors
const TEAM1_COLOR = 0x3498db; // Blue
const TEAM2_COLOR = 0xe74c3c; // Red
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

// Active drafts per VC
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

  const isHost =
    member.roles.cache.some(r => r.name === HOST_ROLE_NAME) ||
    member.id === guild.ownerId;

  // ---------- RANDOM TEAMS ----------
  if (interaction.customId === "random_teams") {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: "❌ Join a VC first.", ephemeral: true });
    if (drafts.has(vc.id))
      return interaction.reply({ content: "❌ Draft already active here.", ephemeral: true });

    const players = [...vc.members.values()];
    if (players.length < 2)
      return interaction.reply({ content: "❌ Not enough players.", ephemeral: true });

    players.sort(() => Math.random() - 0.5);
    const half = Math.ceil(players.length / 2);
    const team1 = players.slice(0, half);
    const team2 = players.slice(half);

    const draftId = Math.floor(Math.random() * 9999);

    const role = await guild.roles.create({
      name: `draft-${draftId}`,
      reason: "Draft access"
    });

    for (const p of players) await p.roles.add(role);

    const category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.includes("Community")
    );

    const text = await guild.channels.create({
      name: `draft-${draftId}`,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: role.id, allow: [PermissionsBitField.Flags.ViewChannel] }
      ]
    });

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("start").setLabel("▶️ Start Game").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("shuffle").setLabel("🔀 Shuffle").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("t1").setLabel("🏆 Team 1 Wins").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("t2").setLabel("🏆 Team 2 Wins").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("end").setLabel("❌ End Game").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("request_players").setLabel("📢 Request Players").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("request_host").setLabel("🧑‍✈️ Request Host").setStyle(ButtonStyle.Primary)
    );

    await text.send({
      content:
        `<@&${role.id}>\n\n` +
        `**Team 1:**\n${team1.map(m => m.displayName).join("\n")}\n\n` +
        `**Team 2:**\n${team2.map(m => m.displayName).join("\n")}`,
      components: [buttons]
    });

    drafts.set(vc.id, {
      vc,
      role,
      text,
      team1,
      team2,
      originalVC: vc,
      tempVCs: []
    });

    return interaction.reply({ content: "✅ Draft created.", ephemeral: true });
  }

  const draft = [...drafts.values()].find(d => d.text.id === interaction.channel.id);

  // ---------- REQUEST PLAYERS ----------
  if (interaction.customId === "request_players") {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: "❌ Join a VC first.", ephemeral: true });

    const alertsChannel = guild.channels.cache.find(
      c => c.name === DRAFT_ALERTS_CHANNEL && c.type === ChannelType.GuildText
    );

    const invite = await vc.createInvite({ maxAge: 0, maxUses: 0 });

    const embed = new EmbedBuilder()
      .setTitle("📢 Draft Player Request")
      .setDescription(`${member} requested players for a draft`)
      .addFields({ name: "🎙️ Voice Channel", value: invite.url })
      .setColor(0x2ecc71)
      .setTimestamp();

    await alertsChannel.send({ embeds: [embed] });
    return interaction.reply({ content: "✅ Player request sent.", ephemeral: true });
  }

  // ---------- REQUEST HOST ----------
  if (interaction.customId === "request_host") {
    const vc = member.voice.channel;
    if (!vc) return interaction.reply({ content: "❌ Join a VC first.", ephemeral: true });

    const hostChannel = guild.channels.cache.find(
      c => c.name === DRAFT_HOST_CHANNEL && c.type === ChannelType.GuildText
    );

    const hostRole = guild.roles.cache.find(r => r.name === HOST_ROLE_NAME);
    const invite = await vc.createInvite({ maxAge: 0, maxUses: 0 });

    const embed = new EmbedBuilder()
      .setTitle("🧑‍✈️ Draft Host Request")
      .setDescription(`${member} requested a host for this draft`)
      .addFields({ name: "🎙️ Voice Channel", value: invite.url })
      .setColor(0xf1c40f)
      .setTimestamp();

    await hostChannel.send({
      content: hostRole ? `<@&${hostRole.id}>` : "",
      embeds: [embed]
    });

    return interaction.reply({ content: "✅ Host request sent.", ephemeral: true });
  }

  if (!draft) return interaction.reply({ content: "❌ No active draft here.", ephemeral: true });
  if (!isHost && ["start", "shuffle", "t1", "t2", "end"].includes(interaction.customId))
    return interaction.reply({ content: "❌ Host only.", ephemeral: true });

  // ---------- SHUFFLE ----------
  if (interaction.customId === "shuffle") {
    const all = [...draft.team1, ...draft.team2].sort(() => Math.random() - 0.5);
    const half = Math.ceil(all.length / 2);
    draft.team1 = all.slice(0, half);
    draft.team2 = all.slice(half);

    await interaction.deferUpdate();
    await draft.text.bulkDelete(5).catch(() => {});
    return draft.text.send({
      content:
        `**Team 1:**\n${draft.team1.map(m => m.displayName).join("\n")}\n\n` +
        `**Team 2:**\n${draft.team2.map(m => m.displayName).join("\n")}`,
      components: interaction.message.components
    });
  }

  // ---------- START GAME ----------
  if (interaction.customId === "start") {
    const cat = draft.text.parent;

    const t1VC = await guild.channels.create({
      name: `Draft VC 1 hosted by ${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: cat?.id,
      userLimit: draft.team1.length
    });

    const t2VC = await guild.channels.create({
      name: `Draft VC 2 hosted by ${member.displayName}`,
      type: ChannelType.GuildVoice,
      parent: cat?.id,
      userLimit: draft.team2.length
    });

    draft.tempVCs = [t1VC, t2VC];

    for (const p of draft.team1) await p.voice.setChannel(t1VC).catch(() => {});
    for (const p of draft.team2) await p.voice.setChannel(t2VC).catch(() => {});

    return interaction.reply({ content: "▶️ Game started.", ephemeral: true });
  }

  // ---------- END / WIN ----------
  if (["end", "t1", "t2"].includes(interaction.customId)) {
    const winTeam =
      interaction.customId === "t1" ? draft.team1 :
      interaction.customId === "t2" ? draft.team2 : null;

    const loseTeam =
      interaction.customId === "t1" ? draft.team2 :
      interaction.customId === "t2" ? draft.team1 : null;

    if (winTeam) {
      const winEmbed = new EmbedBuilder()
        .setTitle("🏆 Draft Result")
        .setDescription(
          `**${interaction.customId === "t1" ? "Team 1" : "Team 2"} Wins!**\n\n` +
          winTeam.map(m => m.displayName).join("\n")
        )
        .setColor(interaction.customId === "t1" ? TEAM1_COLOR : TEAM2_COLOR)
        .setTimestamp();

      await draft.text.send({ embeds: [winEmbed] });

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
      await p.voice.setChannel(draft.originalVC).catch(() => {});
    }

    for (const vc of draft.tempVCs) await vc.delete().catch(() => {});
    await draft.text.delete().catch(() => {});
    await draft.role.delete().catch(() => {});
    drafts.delete(draft.originalVC.id);

    return interaction.reply({ content: "✅ Draft finished.", ephemeral: true });
  }
});

// ---------- LOGIN ----------
client.login(process.env.TOKEN);

// ---------- KEEP ALIVE ----------
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is alive"));
app.listen(5000, () => console.log("Express server running"));

