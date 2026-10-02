'use strict';
/**
 * Cookie - a music-only Discord bot.
 * discord.js v14 + @discordjs/voice, streaming audio through yt-dlp + FFmpeg.
 *
 * Requirements on the machine: Node 22.12+, FFmpeg and yt-dlp (both on PATH).
 */
require('dotenv').config();

const { spawn, execFile } = require('node:child_process');
const {
  Client,
  Events,
  GatewayIntentBits,
  ActivityType,
  EmbedBuilder,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');

// ---------------------------------------------------------------- config ---
const BOT_NAME = 'Cookie';
const COLOR = 0xc68642; // cookie brown
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || null; // optional: instant command updates
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const IDLE_LEAVE_MS = 5 * 60 * 1000; // leave 5 min after the queue ends
const ALONE_LEAVE_MS = 30 * 1000; // leave 30 s after everyone else left
const MAX_QUEUE = 200;

// -------------------------------------------------------------- commands ---
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song from a name or link')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name or URL').setRequired(true)
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the volume')
    .addIntegerOption((o) =>
      o.setName('level').setDescription('1 to 100').setMinValue(1).setMaxValue(100).setRequired(true)
    ),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle looping of the current song'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect Cookie from voice'),
];

// --------------------------------------------------------------- helpers ---
const embed = (description) =>
  new EmbedBuilder().setColor(COLOR).setDescription(description).setFooter({ text: `${BOT_NAME} 🍪` });

const fmt = (sec) => {
  if (!sec && sec !== 0) return 'live';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

const trackLink = (t) => `[${t.title.replace(/[[\]]/g, '')}](${t.url})`;

function nowPlayingEmbed(track, title = 'Now playing') {
  const e = embed(trackLink(track))
    .setTitle(title)
    .addFields(
      { name: 'Duration', value: fmt(track.duration), inline: true },
      { name: 'Requested by', value: track.requestedBy, inline: true }
    );
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
}

function friendlyError(err) {
  if (err && err.code === 'ENOENT') {
    return 'yt-dlp was not found. Install it and make sure it is on your PATH (or set YTDLP_PATH in .env).';
  }
  if (err && err.killed) return 'That took too long to load. Please try again.';
  return "Couldn't find or load that track. Try a different name or link.";
}

/** Look up a song with yt-dlp (URL or search text). */
function resolveTrack(query, requestedBy) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ['--dump-single-json', '--no-playlist', '--no-warnings', '--skip-download', target],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          let info = JSON.parse(stdout);
          if (info.entries) info = info.entries[0];
          if (!info) return reject(new Error('No results'));
          resolve({
            title: info.title || 'Unknown title',
            url: info.webpage_url || info.original_url || target,
            duration: info.duration || null,
            thumbnail: info.thumbnail || null,
            requestedBy,
          });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

// ------------------------------------------------------- per-server state ---
/** guildId -> state */
const states = new Map();

function killProc(state) {
  if (state.proc && !state.proc.killed) {
    try {
      state.proc.kill();
    } catch {
      /* already gone */
    }
  }
  state.proc = null;
}

function announce(state, embeds) {
  state.textChannel?.send({ embeds }).catch(() => {}); // needs Send Messages + Embed Links; optional
}

function destroyState(state) {
  if (state.destroyed) return;
  state.destroyed = true;
  clearTimeout(state.idleTimer);
  clearTimeout(state.aloneTimer);
  state.queue = [];
  state.current = null;
  state.player.stop(true);
  killProc(state);
  if (state.connection.state.status !== VoiceConnectionStatus.Destroyed) state.connection.destroy();
  states.delete(state.guildId);
}

function playNext(state, shouldAnnounce) {
  if (state.destroyed) return;
  clearTimeout(state.idleTimer);

  const repeat = state.loop && state.current && !state.skipOnce;
  const track = repeat ? state.current : state.queue.shift();
  state.skipOnce = false;

  if (!track) {
    state.current = null;
    state.idleTimer = setTimeout(() => destroyState(state), IDLE_LEAVE_MS);
    return;
  }
  state.current = track;

  const proc = spawn(
    YTDLP,
    ['-f', 'bestaudio/best', '-o', '-', '-q', '--no-warnings', '--no-playlist', track.url],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  proc.stderr.on('data', (d) => console.error(`[yt-dlp] ${String(d).trim()}`));
  proc.stdout.on('error', () => {});
  proc.on('error', (err) => {
    console.error('[yt-dlp] failed to start:', err.message);
    if (state.proc !== proc) return;
    announce(state, [embed(friendlyError(err))]);
    state.skipOnce = true;
    state.player.stop(true); // -> Idle -> next track
  });

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume.setVolume(state.volume);

  state.proc = proc;
  state.resource = resource;
  state.player.play(resource);

  if (shouldAnnounce && !repeat) announce(state, [nowPlayingEmbed(track)]);
}

function createState(guild, voiceChannel, textChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);

  const state = {
    guildId: guild.id,
    connection,
    player,
    textChannel,
    queue: [],
    current: null,
    resource: null,
    proc: null,
    loop: false,
    skipOnce: false,
    volume: 0.5,
    idleTimer: null,
    aloneTimer: null,
    destroyed: false,
  };

  player.on(AudioPlayerStatus.Idle, () => {
    killProc(state);
    playNext(state, true);
  });

  player.on('error', (err) => {
    console.error('Audio player error:', err.message);
    announce(state, [embed("Something went wrong while playing that track, so I'm moving on.")]);
    state.skipOnce = true; // don't loop a broken track forever
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Moved channels / reconnecting? Give it a moment.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyState(state); // really disconnected (kicked, etc.)
    }
  });

  states.set(guild.id, state);
  return state;
}

// -------------------------------------------------------------- handlers ---
const say = (i, text, ephemeral = false) =>
  i.reply({ embeds: [embed(text)], flags: ephemeral ? MessageFlags.Ephemeral : undefined });

const handlers = {
  async play(i) {
    const voiceChannel = i.member.voice?.channel;
    if (!voiceChannel) return say(i, 'Join a voice channel first.', true);

    let state = states.get(i.guildId);
    if (state && state.connection.joinConfig.channelId !== voiceChannel.id) {
      return say(i, `I'm already playing in <#${state.connection.joinConfig.channelId}>. Join that channel to add songs.`, true);
    }
    if (state && state.queue.length >= MAX_QUEUE) return say(i, 'The queue is full.', true);

    await i.deferReply();
    let track;
    try {
      track = await resolveTrack(i.options.getString('query', true).trim(), i.member.displayName);
    } catch (err) {
      console.error('Resolve failed:', err.message);
      return i.editReply({ embeds: [embed(friendlyError(err))] });
    }

    state = states.get(i.guildId);
    if (!state) {
      state = createState(i.guild, voiceChannel, i.channel);
      try {
        await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        destroyState(state);
        return i.editReply({
          embeds: [embed("I couldn't join that voice channel. Check that I have Connect and Speak permissions there.")],
        });
      }
    }
    state.textChannel = i.channel;

    if (state.current) {
      state.queue.push(track);
      return i.editReply({ embeds: [nowPlayingEmbed(track, `Added to queue (#${state.queue.length})`)] });
    }
    state.queue.push(track);
    playNext(state, false);
    return i.editReply({ embeds: [nowPlayingEmbed(track)] });
  },

  async skip(i) {
    const state = states.get(i.guildId);
    if (!state?.current) return say(i, 'Nothing is playing.', true);
    const skipped = state.current;
    state.skipOnce = true; // skip even when looping
    state.player.stop(true);
    return say(i, `Skipped **${skipped.title}**`);
  },

  async pause(i) {
    const state = states.get(i.guildId);
    if (state?.player.state.status !== AudioPlayerStatus.Playing) return say(i, 'Nothing is playing.', true);
    state.player.pause();
    return say(i, 'Paused ⏸️');
  },

  async resume(i) {
    const state = states.get(i.guildId);
    if (state?.player.state.status !== AudioPlayerStatus.Paused) return say(i, "Nothing is paused.", true);
    state.player.unpause();
    return say(i, 'Resumed ▶️');
  },

  async stop(i) {
    const state = states.get(i.guildId);
    if (!state?.current && !state?.queue.length) return say(i, 'Nothing is playing.', true);
    state.queue = [];
    state.loop = false;
    state.skipOnce = true;
    state.player.stop(true);
    return say(i, 'Stopped and cleared the queue ⏹️');
  },

  async queue(i) {
    const state = states.get(i.guildId);
    if (!state?.current && !state?.queue.length) return say(i, 'The queue is empty.', true);
    const lines = [];
    if (state.current) lines.push(`**Now playing:** ${trackLink(state.current)} \`${fmt(state.current.duration)}\``);
    state.queue.slice(0, 10).forEach((t, n) => lines.push(`**${n + 1}.** ${trackLink(t)} \`${fmt(t.duration)}\``));
    if (state.queue.length > 10) lines.push(`...and ${state.queue.length - 10} more`);
    const e = embed(lines.join('\n')).setTitle(`Queue${state.loop ? ' 🔁' : ''}`);
    return i.reply({ embeds: [e] });
  },

  async nowplaying(i) {
    const state = states.get(i.guildId);
    if (!state?.current) return say(i, 'Nothing is playing.', true);
    const t = state.current;
    const elapsed = Math.floor((state.resource?.playbackDuration || 0) / 1000);
    const e = nowPlayingEmbed(t);
    if (t.duration) {
      const pos = Math.min(15, Math.floor((elapsed / t.duration) * 16));
      const bar = '▬'.repeat(pos) + '🔘' + '▬'.repeat(15 - pos);
      e.addFields({ name: 'Progress', value: `${bar}\n${fmt(elapsed)} / ${fmt(t.duration)}` });
    }
    return i.reply({ embeds: [e] });
  },

  async volume(i) {
    const state = states.get(i.guildId);
    if (!state) return say(i, "I'm not in a voice channel.", true);
    const level = i.options.getInteger('level', true);
    state.volume = level / 100;
    state.resource?.volume?.setVolume(state.volume);
    return say(i, `Volume set to **${level}%** 🔊`);
  },

  async loop(i) {
    const state = states.get(i.guildId);
    if (!state?.current) return say(i, 'Nothing is playing.', true);
    state.loop = !state.loop;
    return say(i, state.loop ? 'Looping the current song 🔁' : 'Loop off');
  },

  async shuffle(i) {
    const state = states.get(i.guildId);
    if (!state || state.queue.length < 2) return say(i, 'Not enough songs in the queue to shuffle.', true);
    for (let n = state.queue.length - 1; n > 0; n--) {
      const k = Math.floor(Math.random() * (n + 1));
      [state.queue[n], state.queue[k]] = [state.queue[k], state.queue[n]];
    }
    return say(i, 'Queue shuffled 🔀');
  },

  async leave(i) {
    const state = states.get(i.guildId);
    if (!state) return say(i, "I'm not in a voice channel.", true);
    destroyState(state);
    return say(i, 'See you later 👋');
  },
};

// ---------------------------------------------------------------- client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`${BOT_NAME} is online as ${c.user.tag}`);
  c.user.setPresence({
    activities: [{ name: `/play | ${BOT_NAME} 🍪`, type: ActivityType.Listening }],
    status: 'online',
  });

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(c.user.id, GUILD_ID)
      : Routes.applicationCommands(c.user.id);
    await rest.put(route, { body: commands.map((cmd) => cmd.toJSON()) });
    console.log(`Registered ${commands.length} slash commands${GUILD_ID ? ' (server only)' : ' (global)'}.`);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild() || !interaction.guild) return;
  const handler = handlers[interaction.commandName];
  if (!handler) return;
  try {
    await handler(interaction);
  } catch (err) {
    console.error(`Error in /${interaction.commandName}:`, err);
    const payload = { embeds: [embed('Something went wrong. Please try again.')] };
    try {
      if (interaction.deferred) await interaction.editReply(payload);
      else if (interaction.replied) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch {
      /* interaction expired */
    }
  }
});

// Leave if Cookie is left alone in the voice channel.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const state = states.get(oldState.guild.id);
  if (!state) return;
  const channel = oldState.guild.channels.cache.get(state.connection.joinConfig.channelId);
  if (!channel) return;
  clearTimeout(state.aloneTimer);
  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) state.aloneTimer = setTimeout(() => destroyState(state), ALONE_LEAVE_MS);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('SIGINT', () => {
  for (const s of states.values()) destroyState(s);
  process.exit(0);
});

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Add it to your .env file.');
  process.exit(1);
}
client.login(TOKEN);
