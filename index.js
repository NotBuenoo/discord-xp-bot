const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
} = require("discord.js");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // lets the bot see voice channel join/leave
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: lets the bot read "!" commands
  ],
  partials: [Partials.GuildMember],
});

const PREFIX = "!";
const MIN_USERS_FOR_XP = 2;

// Weekly summary fires every Sunday at 8:00 AM, in this timezone.
// Change this if you're not in Ho Chi Minh City / Indochina Time.
const WEEKLY_SUMMARY_CRON = "0 8 * * 0";
const WEEKLY_SUMMARY_TIMEZONE = "Asia/Ho_Chi_Minh";

// userId -> { sum, minutesElapsed, intervalId, channelId, joinedAt }
const sessions = new Map();

// channelId -> Set<userId> currently in that voice channel
const channelMembers = new Map();

// guildId -> { [userId]: { username, total } } — accumulates across the week
const weeklyTotals = new Map();

// --- Per-server announce channel config (persisted to disk) ---
const CONFIG_PATH = path.join(__dirname, "guildConfig.json");

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function saveJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let guildConfig = loadJsonFile(CONFIG_PATH, {}); // { [guildId]: announceChannelId }

// --- Per-server blacklist (music bots, etc.) persisted to disk ---
const BLACKLIST_PATH = path.join(__dirname, "blacklist.json");
let blacklist = loadJsonFile(BLACKLIST_PATH, {}); // { [guildId]: [userId, ...] }

function isBlacklisted(member) {
  const guildList = blacklist[member.guild.id] || [];
  return guildList.includes(member.id);
}

// Anyone excluded from XP tracking entirely: real Discord bot accounts
// (covers music bots automatically, no setup needed) OR anyone manually
// added via !blacklist (covers edge cases, or a bot account that somehow
// isn't flagged as one).
function isExcludedFromTracking(member) {
  return member.user.bot || isBlacklisted(member);
}

// Legacy single-server fallback, only used if a guild hasn't run !setchannel yet.
const LEGACY_ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || null;

function getAnnounceChannel(guild) {
  const configuredId = guildConfig[guild.id];
  if (configuredId) {
    const channel = guild.channels.cache.get(configuredId);
    if (channel) return channel;
  }
  if (LEGACY_ANNOUNCE_CHANNEL_ID) {
    const legacyChannel = guild.channels.cache.get(LEGACY_ANNOUNCE_CHANNEL_ID);
    if (legacyChannel) return legacyChannel;
  }
  return guild.systemChannel || null;
}

function randomXp() {
  return Math.floor(Math.random() * 10) + 1; // 1 to 10 inclusive
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function getChannelCount(channelId) {
  return channelMembers.get(channelId)?.size || 0;
}

function startTimer(userId) {
  const session = sessions.get(userId);
  if (!session || session.intervalId) return;

  session.intervalId = setInterval(() => {
    session.sum += randomXp();
    session.minutesElapsed += 1;
  }, 60 * 1000);
}

function stopTimer(userId) {
  const session = sessions.get(userId);
  if (!session || !session.intervalId) return;

  clearInterval(session.intervalId);
  session.intervalId = null;
}

// Checks a channel's population (excluding blacklisted/bot accounts) and
// starts/pauses XP timers for everyone trackable in it.
function evaluateChannel(channelId) {
  const members = channelMembers.get(channelId);
  if (!members) return;

  const count = members.size;
  if (count >= MIN_USERS_FOR_XP) {
    members.forEach((uid) => startTimer(uid));
  } else {
    members.forEach((uid) => stopTimer(uid));
  }
}

// --- Weekly XP tracking ---
function addWeeklyXp(guildId, userId, username, amount) {
  if (!weeklyTotals.has(guildId)) {
    weeklyTotals.set(guildId, {});
  }
  const guildTotals = weeklyTotals.get(guildId);
  if (!guildTotals[userId]) {
    guildTotals[userId] = { username, total: 0 };
  }
  guildTotals[userId].username = username;
  guildTotals[userId].total += amount;
}

function joinChannel(member, channel, { announce = true } = {}) {
  if (isExcludedFromTracking(member)) return; // music bots / blacklisted users are invisible to tracking

  if (!channelMembers.has(channel.id)) {
    channelMembers.set(channel.id, new Set());
  }
  channelMembers.get(channel.id).add(member.id);

  sessions.set(member.id, {
    sum: 0,
    minutesElapsed: 0,
    intervalId: null,
    channelId: channel.id,
    joinedAt: Date.now(),
  });

  if (announce) {
    const announceChannel = getAnnounceChannel(member.guild);
    if (announceChannel) {
      announceChannel.send(`${member.user.username} Joins!`);
    }
  }

  evaluateChannel(channel.id);
}

function leaveChannel(member, channelId) {
  if (isExcludedFromTracking(member)) return; // never had a session to begin with

  const session = sessions.get(member.id);
  const announceChannel = getAnnounceChannel(member.guild);

  if (session) {
    stopTimer(member.id);
    sessions.delete(member.id);
  }

  const members = channelMembers.get(channelId);
  if (members) {
    members.delete(member.id);
    if (members.size === 0) {
      channelMembers.delete(channelId);
    }
  }

  const minuteCount = session ? session.minutesElapsed : 0;
  const sum = session ? session.sum : 0;

  addWeeklyXp(member.guild.id, member.id, member.user.username, sum);

  if (announceChannel) {
    announceChannel.send(
      `${member.user.username} left in ${minuteCount} minute${
        minuteCount === 1 ? "" : "s"
      }! They will be granted ${sum} XP!`
    );
  }

  evaluateChannel(channelId);
}

async function scanExistingVoiceMembers(c) {
  for (const guild of c.guilds.cache.values()) {
    const voiceStates = guild.voiceStates.cache;

    for (const state of voiceStates.values()) {
      if (!state.channelId) continue;

      let member = state.member;
      if (!member) {
        try {
          member = await guild.members.fetch(state.id);
        } catch (err) {
          continue;
        }
      }

      const channel = state.channel ?? guild.channels.cache.get(state.channelId);
      if (!channel) continue;

      joinChannel(member, channel, { announce: false });
    }
  }
}

// --- Weekly summary ---
function formatWeeklySummary(guildTotals) {
  const entries = Object.values(guildTotals)
    .filter((e) => e.total > 0)
    .sort((a, b) => b.total - a.total);

  if (entries.length === 0) {
    return "**📊 Weekly XP Summary**\nNo XP was earned this week!";
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = entries.map((entry, i) => {
    const rank = medals[i] ?? `${i + 1}.`;
    return `${rank} **${entry.username}** — ${entry.total} XP`;
  });

  return `**📊 Weekly XP Summary**\n${lines.join("\n")}`;
}

async function sendWeeklySummaries() {
  for (const guild of client.guilds.cache.values()) {
    const persisted = weeklyTotals.get(guild.id) || {};
    const combined = {};
    for (const [userId, entry] of Object.entries(persisted)) {
      combined[userId] = { ...entry };
    }
    for (const [userId, session] of sessions.entries()) {
      const member = guild.members.cache.get(userId);
      if (!member || session.channelId == null) continue;
      if (!guild.channels.cache.has(session.channelId)) continue;

      if (!combined[userId]) {
        combined[userId] = { username: member.user.username, total: 0 };
      }
      combined[userId].total += session.sum;
    }

    const announceChannel = getAnnounceChannel(guild);
    if (announceChannel) {
      announceChannel.send(formatWeeklySummary(combined));
    }

    weeklyTotals.set(guild.id, {});
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  await scanExistingVoiceMembers(c);
  console.log(`Picked up ${sessions.size} member(s) already in voice channels.`);

  cron.schedule(WEEKLY_SUMMARY_CRON, sendWeeklySummaries, {
    timezone: WEEKLY_SUMMARY_TIMEZONE,
  });
  console.log(
    `Weekly summary scheduled: "${WEEKLY_SUMMARY_CRON}" (${WEEKLY_SUMMARY_TIMEZONE})`
  );
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const wasInVoice = oldState.channelId !== null;
  const isInVoice = newState.channelId !== null;
  const member = newState.member ?? oldState.member;

  if (!member) return;

  if (!wasInVoice && isInVoice) {
    joinChannel(member, newState.channel);
  } else if (wasInVoice && !isInVoice) {
    leaveChannel(member, oldState.channelId);
  } else if (
    wasInVoice &&
    isInVoice &&
    oldState.channelId !== newState.channelId
  ) {
    leaveChannel(member, oldState.channelId);
    joinChannel(member, newState.channel);
  }
});

function hasSetupPermission(message) {
  const isAdmin = message.member.permissions.has(
    PermissionsBitField.Flags.Administrator
  );
  const isOwner = message.guild.ownerId === message.author.id;
  return isAdmin || isOwner;
}

// Parses a raw ID, a <@id> mention, or a <@!id> mention into a plain ID
function parseUserId(raw) {
  return raw?.replace(/[<@!>]/g, "") ?? null;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === "setchannel") {
    if (!hasSetupPermission(message)) {
      message.reply("Only the server owner or an admin can set the XP channel.");
      return;
    }

    const mentioned = message.mentions.channels?.first();
    const rawId = args[0]?.replace(/[<#>]/g, "");
    const targetId = mentioned?.id ?? rawId;

    if (!targetId) {
      message.reply("Usage: `!setchannel <channelID>` or `!setchannel #channel`");
      return;
    }

    const targetChannel = message.guild.channels.cache.get(targetId);
    if (!targetChannel || !targetChannel.isTextBased()) {
      message.reply("That doesn't look like a valid text channel in this server.");
      return;
    }

    guildConfig[message.guild.id] = targetChannel.id;
    saveJsonFile(CONFIG_PATH, guildConfig);

    message.reply(`XP announcements and weekly summaries will now be sent to ${targetChannel}.`);
    return;
  }

  if (command === "blacklist") {
    if (!hasSetupPermission(message)) {
      message.reply("Only the server owner or an admin can manage the blacklist.");
      return;
    }

    const subcommand = args[0]?.toLowerCase();
    const guildId = message.guild.id;
    if (!blacklist[guildId]) blacklist[guildId] = [];

    if (subcommand === "add") {
      const mentioned = message.mentions.users?.first();
      const targetId = mentioned?.id ?? parseUserId(args[1]);

      if (!targetId) {
        message.reply("Usage: `!blacklist add @user` or `!blacklist add <userID>`");
        return;
      }
      if (blacklist[guildId].includes(targetId)) {
        message.reply("That user/bot is already blacklisted.");
        return;
      }

      blacklist[guildId].push(targetId);
      saveJsonFile(BLACKLIST_PATH, blacklist);

      // If they're currently in a voice channel with an active session
      // (shouldn't normally happen for real bots, but covers manual adds),
      // remove them from tracking immediately.
      const session = sessions.get(targetId);
      if (session) {
        stopTimer(targetId);
        sessions.delete(targetId);
        const members = channelMembers.get(session.channelId);
        if (members) {
          members.delete(targetId);
          evaluateChannel(session.channelId);
        }
      }

      message.reply(`<@${targetId}> will no longer earn XP or count toward the 2-person threshold.`);
      return;
    }

    if (subcommand === "remove") {
      const mentioned = message.mentions.users?.first();
      const targetId = mentioned?.id ?? parseUserId(args[1]);

      if (!targetId) {
        message.reply("Usage: `!blacklist remove @user` or `!blacklist remove <userID>`");
        return;
      }

      blacklist[guildId] = blacklist[guildId].filter((id) => id !== targetId);
      saveJsonFile(BLACKLIST_PATH, blacklist);

      message.reply(`<@${targetId}> removed from the blacklist.`);
      return;
    }

    if (subcommand === "list") {
      const ids = blacklist[guildId];
      if (!ids || ids.length === 0) {
        message.reply("No one is blacklisted in this server (real bot accounts are always excluded automatically).");
        return;
      }
      message.reply(
        `**Blacklisted in this server:**\n${ids.map((id) => `<@${id}>`).join("\n")}`
      );
      return;
    }

    message.reply(
      "Usage: `!blacklist add @user`, `!blacklist remove @user`, or `!blacklist list`\n" +
        "(Note: real Discord bot accounts, like music bots, are already excluded automatically — this is for anything else you want to exclude.)"
    );
    return;
  }

  if (command === "uptime") {
    const uptimeMs = client.uptime;
    message.reply(`Bot has been running for **${formatDuration(uptimeMs)}**.`);
    return;
  }

  if (command === "elapsed") {
    const target = message.mentions.members?.first() ?? message.member;
    const session = sessions.get(target.id);

    if (!session) {
      const whoText =
        target.id === message.member.id ? "You are" : `${target.user.username} is`;
      message.reply(`${whoText} not currently in a voice channel.`);
      return;
    }

    const elapsedMs = Date.now() - session.joinedAt;
    const count = getChannelCount(session.channelId);
    const paused = count < MIN_USERS_FOR_XP;

    const whoText =
      target.id === message.member.id ? "You have" : `${target.user.username} has`;

    message.reply(
      `${whoText} been in voice for **${formatDuration(elapsedMs)}**` +
        ` (${session.minutesElapsed} XP-minute${
          session.minutesElapsed === 1 ? "" : "s"
        } counted, current sum: ${session.sum} XP)` +
        (paused ? " — *currently paused, needs 2+ people in the channel*" : "")
    );
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
