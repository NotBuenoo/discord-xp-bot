# Discord XP Bot

A self-hosted Discord bot that rewards active voice chat participation with XP, built with [discord.js](https://discord.js.org/) v14. Also this bot is going to be paired with the Arcane Bot (arcane.bot)

## Features

- **Per-minute XP rolls** — members earn XP on a rolling per-minute basis while active in a voice channel
- **2-person voice channel minimum** — XP only accrues when at least 2 people are present in the same voice channel, discouraging AFK grinding alone
- **Multi-server support** — each server can independently configure its own XP channel via `!setchannel`
- **Weekly leaderboard summaries** — automatically posts a recap of top earners at the end of each week

## Requirements

- Node.js (LTS recommended)
- A Discord bot application and token from the [Discord Developer Portal](https://discord.com/developers/applications)
- A linux machine/server.

## Setup

1. Clone the repository:
   ```
   git clone https://github.com/NotBuenoo/discord-xp-bot.git
   cd discord-xp-bot
   ```
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file in the project root (never commit this file):
   ```
   DISCORD_TOKEN=your-bot-token-here
   ```
4. Start the bot:
   ```
   node index.js
   ```

## Running as a systemd service

For persistent, self-hosted deployment, an example service file:

```ini
[Unit]
Description=Discord XP Bot
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/discord-xp-bot/index.js
WorkingDirectory=/path/to/discord-xp-bot
Restart=on-failure
User=youruser
EnvironmentFile=/path/to/discord-xp-bot/.env

[Install]
WantedBy=multi-user.target
```

Enable and start it with:
```
sudo systemctl enable --now discord-xp-bot
```

## Commands

| Command | Description |
|---|---|
| `!setchannel` | Sets the channel this server should use for XP/leaderboard announcements |
| `!blacklist add @username/UserId` | Blacklists a user, excluding them from earning XP |
| `!blacklist remove @username/UserId` | Removes a user from the blacklist |
| `!blacklist list` | Lists all currently blacklisted users |
| `!elapsed (optionally @username)` | Shows time elapsed accruing XP, for yourself or the mentioned user |
| `!uptime` | Shows how long the bot has been running |

## How XP works

- The bot checks voice channels on a per-minute interval.
- A member earns XP for that minute only if their voice channel has **2 or more** members present.
- XP accumulates per user, per server, over time.
- At the end of each week, the bot posts a leaderboard summary of the top XP earners to the configured channel.

## License

MIT
