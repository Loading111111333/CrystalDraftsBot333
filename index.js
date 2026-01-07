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

  // Host only
  if (
    !member.roles.cache.some(r => r.name === HOST_ROLE_NAME) &&
    member.id !== guild.ownerId
  ) {
    return interaction.reply({ content: "❌ Host only.", ephemeral: true });
  }

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
      new ButtonBuilder().setCustomId("end").setLabel("❌ End Game").setStyle(ButtonStyle.Danger)
    );

    await text.send({
      content:
        `<@&${role.id}>\n\n` +
        `**Team 1:**\n${team1.map(m => getBaseNick(m)).join("\n")}\n\n` +
        `**Team 2:**\n${team2.map(m => getBaseNick(m)).join("\n")}`,
      components: [buttons]
    });

    drafts.set(vc.id, {
      vc,
      role,
      text,
      team1,
      team2,
      originalVC: vc,
      tempVCs: [],
      draftId
    });

    return interaction.reply({ content: "✅ Draft created.", ephemeral: true });
  }

  // ---------- DRAFT ACTIONS ----------
  const draft = [...drafts.values()].find(d => d.text.id === interaction.channel.id);
  if (!draft) return interaction.reply({ content: "❌ No active draft here.", ephemeral: true });

  // Shuffle
  if (interaction.customId === "shuffle") {
    const all = [...draft.team1, ...draft.team2].sort(() => Math.random() - 0.5);
    const half = Math.ceil(all.length / 2);
    draft.team1 = all.slice(0, half);
    draft.team2 = all.slice(half);

    await interaction.deferUpdate();
    await draft.text.bulkDelete(5).catch(() => {});
    return draft.text.send({
      content:
        `**Team 1:**\n${draft.team1.map(m => getBaseNick(m)).join("\n")}\n\n` +
        `**Team 2:**\n${draft.team2.map(m => getBaseNick(m)).join("\n")}`,
      components: interaction.message.components
    });
  }

  // Start Game
  if (interaction.customId === "start") {
    const cat = draft.text.parent;

    const t1VC = await guild.channels.create({
      name: `Team 1 VC Draft ${draft.draftId}`,
      type: ChannelType.GuildVoice,
      parent: cat?.id,
      userLimit: draft.team1.length
    });

    const t2VC = await guild.channels.create({
      name: `Team 2 VC Draft ${draft.draftId}`,
      type: ChannelType.GuildVoice,
      parent: cat?.id,
      userLimit: draft.team2.length
    });

    draft.tempVCs = [t1VC, t2VC];

    for (const p of draft.team1) await p.voice.setChannel(t1VC).catch(() => {});
    for (const p of draft.team2) await p.voice.setChannel(t2VC).catch(() => {});

    return interaction.reply({ content: "▶️ Game started.", ephemeral: true });
  }

  // End / Win
  if (["end", "t1", "t2"].includes(interaction.customId)) {
    const winTeam =
      interaction.customId === "t1" ? draft.team1 :
      interaction.customId === "t2" ? draft.team2 : null;

    const loseTeam =
      interaction.customId === "t1" ? draft.team2 :
      interaction.customId === "t2" ? draft.team1 : null;

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

    // Return everyone to original VC
    for (const p of [...draft.team1, ...draft.team2]) {
      await p.voice.setChannel(draft.originalVC).catch(() => {});
    }

    // Delete draft VCs
    for (const vc of draft.tempVCs) await vc.delete().catch(() => {});
    // Delete draft channel and role
    await draft.text.delete().catch(() => {});
    await draft.role.delete().catch(() => {});
    drafts.delete(draft.originalVC.id);

    return interaction.reply({ content: "✅ Draft finished.", ephemeral: true });
  }
});

// ---------- LOGIN ----------
client.login(process.env.TOKEN);

