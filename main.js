import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import https from 'https';
import fs from 'fs';
import { DateTime } from 'luxon';

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent
  ] 
});

const ALLOWED_CHANNEL_ID = ''; // channel to announce ban updates
const UNBAN_CHANNEL_ID = ''; // channel to announce unban updates
const API_BASE = 'https://www.geoguessr.com/api';
const NCFA_COOKIE = process.env.GEOGUESSR_COOKIE;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Cookie': `_ncfa=${NCFA_COOKIE}`
};

const PLAYER_TRACKING_FILE = 'player_tracking.json';
const CHECK_INTERVAL = 2 * 60 * 60 * 1000; // 2 heures

let checkInterval;

function makeAPIRequest(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP Error: ${res.statusCode}`));
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    
    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function loadPlayerData() {
  try {
    if (fs.existsSync(PLAYER_TRACKING_FILE)) {
      const data = fs.readFileSync(PLAYER_TRACKING_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.log('Error loading player data:', error.message);
  }
  return { 
    players: {},
    lastCheck: null,
    totalChecks: 0
  };
}

function savePlayerData(data) {
  try {
    fs.writeFileSync(PLAYER_TRACKING_FILE, JSON.stringify(data, null, 2));
    console.log('Player tracking data saved');
  } catch (error) {
    console.error('Error saving player data:', error.message);
  }
}

async function fetchCurrentLeaderboard() {
  console.log('Fetching current leaderboard...');
  const allPlayers = [];
  
  for (let offset = 0; offset < 2000; offset += 100) {
    const url = `${API_BASE}/v4/ranked-system/ratings?offset=${offset}&limit=100`;
    try {
      const players = await makeAPIRequest(url);
      if (players.length === 0) break;
      
      allPlayers.push(...players);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      console.error(`Error fetching leaderboard at offset ${offset}:`, error.message);
      break;
    }
  }
  
  console.log(`Fetched ${allPlayers.length} players from leaderboard`);
  return allPlayers;
}

async function getUserActivity(userId) {
  try {
    const url = `${API_BASE}/v3/users/${userId}`;
    const response = await makeAPIRequest(url);
    
    const isBanned = response.isBanned === true;
    const isSuspended = response.suspendedUntil !== null && new Date(response.suspendedUntil) > new Date();
    
    return {
      accessible: true,
      banned: isBanned,
      suspended: isSuspended,
      suspendedUntil: response.suspendedUntil,
      profile: response.user || response
    };
  } catch (error) {
    if (error.message.includes('404') || error.message.includes('403')) {
      return { accessible: false, banned: true };
    }
    throw error;
  }
}

async function sendStatusMessage(message, isError = false) {
  try {
    const channel = await client.channels.fetch(ALLOWED_CHANNEL_ID);
    const embed = new EmbedBuilder()
      .setTitle(isError ? '❌ Check Failed' : '✅ Check Completed')
      .setColor(isError ? 0xFF0000 : 0x00FF00)
      .setDescription(message)
      .setTimestamp();
    
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error('Error sending status message:', error);
  }
}

async function checkForBannedPlayers() {
  console.log(`\n--- Starting automatic check (${new Date().toISOString()}) ---`);
  
  try {
    const data = loadPlayerData();
    const currentPlayers = await fetchCurrentLeaderboard();
    const currentTime = Date.now();
    
    if (!currentPlayers || currentPlayers.length === 0) {
      console.log('Failed to fetch leaderboard, skipping check');
      await sendStatusMessage('Failed to fetch leaderboard data', true);
      return;
    }
    
    const currentPlayerIds = new Set();
    
    for (const player of currentPlayers) {
      currentPlayerIds.add(player.userId);
      
      if (!data.players[player.userId]) {
        data.players[player.userId] = {
          nick: player.nick,
          firstSeen: currentTime,
          ratings: [{ rating: player.rating, position: player.position, timestamp: currentTime }],
          lastSeen: currentTime,
          status: 'active'
        };
        console.log(`New player tracked: ${player.nick} (#${player.position})`);
      } else {
        const playerData = data.players[player.userId];
        playerData.nick = player.nick;
        playerData.lastSeen = currentTime;
        
        if (playerData.status === 'banned' || playerData.status === 'suspended') {
          console.log(`UNBANNED/UNSUSPENDED: ${player.nick} is back on leaderboard`);
          await sendUnbanNotification(player, playerData);
          playerData.status = 'active';
          playerData.unbannedAt = currentTime;
        } else {
          playerData.status = 'active';
        }
        
        playerData.ratings.push({
          rating: player.rating,
          position: player.position,
          timestamp: currentTime
        });
        
        if (playerData.ratings.length > 30) {
          playerData.ratings = playerData.ratings.slice(-30);
        }
      }
    }
    
    const missingPlayers = [];
    const oneDayAgo = currentTime - (24 * 60 * 60 * 1000);
    
    for (const [userId, playerData] of Object.entries(data.players)) {
      if (!currentPlayerIds.has(userId) && 
          playerData.lastSeen > oneDayAgo && 
          playerData.status === 'active') {
        
        const hoursSinceSeen = Math.floor((currentTime - playerData.lastSeen) / (60 * 60 * 1000));
        
        if (hoursSinceSeen < 48) {
          missingPlayers.push({
            userId,
            ...playerData,
            hoursSinceSeen
          });
        }
      }
    }
    
    console.log(`Found ${missingPlayers.length} recently missing players`);
    
    let actionCount = 0;
    if (missingPlayers.length > 0) {
      const bannedPlayers = await verifyBannedPlayers(missingPlayers);
      actionCount = bannedPlayers.length;
      
      if (bannedPlayers.length > 0) {
        await sendBanNotification(bannedPlayers);
        
        for (const player of bannedPlayers) {
          if (player.confirmedBanned) {
            data.players[player.userId].status = 'banned';
            data.players[player.userId].bannedAt = currentTime;
          } else if (player.suspended) {
            data.players[player.userId].status = 'suspended';
            data.players[player.userId].suspendedAt = currentTime;
            data.players[player.userId].suspendedUntil = player.suspendedUntil;
          }
        }
      }
    }
    
    data.lastCheck = currentTime;
    data.totalChecks = (data.totalChecks || 0) + 1;
    savePlayerData(data);
    
    const statusMessage = actionCount > 0 
      ? `Check completed successfully. Found ${actionCount} new ban(s)/suspension(s).`
      : `Check completed successfully. No new bans or suspensions detected.`;
    
    await sendStatusMessage(statusMessage);
    console.log(`Check completed. Total checks: ${data.totalChecks}`);
    
  } catch (error) {
    console.error('Error during check:', error);
    await sendStatusMessage(`Check failed: ${error.message}`, true);
  }
}

async function verifyBannedPlayers(missingPlayers) {
  console.log(`Verifying ban status for ${missingPlayers.length} missing players`);
  const bannedPlayers = [];
  
  const BATCH_SIZE = 10;
  for (let i = 0; i < missingPlayers.length; i += BATCH_SIZE) {
    const batch = missingPlayers.slice(i, i + BATCH_SIZE);
    
    const promises = batch.map(async (player) => {
      try {
        const activityData = await getUserActivity(player.userId);
        
        if (activityData.banned || activityData.suspended) {
          const banType = activityData.banned ? 'BANNED' : 'SUSPENDED';
          const suspensionInfo = activityData.suspended ? 
            ` until ${new Date(activityData.suspendedUntil).toLocaleString()}` : '';
          
          console.log(`${banType}: ${player.nick} (last seen ${player.hoursSinceSeen}h ago)${suspensionInfo}`);
          
          return {
            ...player,
            confirmedBanned: activityData.banned,
            suspended: activityData.suspended,
            suspendedUntil: activityData.suspendedUntil,
            lastRating: player.ratings[player.ratings.length - 1]
          };
        } else {
          console.log(`Still active: ${player.nick} (likely inactivity drop)`);
          return null;
        }
      } catch (error) {
        console.log(`Error checking ${player.nick}: ${error.message}`);
        return null;
      }
    });
    
    const results = await Promise.all(promises);
    bannedPlayers.push(...results.filter(result => result !== null));
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  console.log(`Verification completed: ${bannedPlayers.length} confirmed bans/suspensions`);
  return bannedPlayers;
}

async function sendUnbanNotification(player, playerData) {
  try {
    const channel = await client.channels.fetch(UNBAN_CHANNEL_ID);
    const profileUrl = `https://www.geoguessr.com/user/${player.userId}`;
    
    const actionDuration = playerData.bannedAt || playerData.suspendedAt ? 
      Math.floor((Date.now() - (playerData.bannedAt || playerData.suspendedAt)) / (24 * 60 * 60 * 1000)) : 'Unknown';
    
    const actionType = playerData.status === 'banned' ? 'Ban' : 'Suspension';
    
    const embed = new EmbedBuilder()
      .setTitle('🟢 Player Unbanned/Unsuspended')
      .setColor(0x00FF00)
      .setDescription(`**${player.nick}** has been unbanned/unsuspended and is back on the leaderboard`)
      .addFields([
        { name: 'Current Position', value: `#${player.position}`, inline: true },
        { name: 'Current ELO', value: `${player.rating} ELO`, inline: true },
        { name: `${actionType} Duration`, value: `${actionDuration} days`, inline: true },
        { name: 'GeoGuessr Profile', value: `[View Profile](${profileUrl})`, inline: false }
      ])
      .setTimestamp();
    
    await channel.send({ embeds: [embed] });
    console.log(`Unban/unsuspend notification sent for ${player.nick}`);
  } catch (error) {
    console.error('Error sending unban notification:', error);
  }
}

async function sendBanNotification(bannedPlayers) {
  try {
    const channel = await client.channels.fetch(ALLOWED_CHANNEL_ID);
    
    if (bannedPlayers.length === 1) {
      const player = bannedPlayers[0];
      const profileUrl = `https://www.geoguessr.com/user/${player.userId}`;
      
      const title = player.confirmedBanned ? 'Player Banned' : '⏸Player Suspended';
      const description = player.confirmedBanned ? 
        `**${player.nick}** has been banned !!!` :
        `**${player.nick}** has been suspended until ${new Date(player.suspendedUntil).toLocaleString()}`;
      
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(player.confirmedBanned ? 0xFF0000 : 0xFFA500)
        .setDescription(description)
        .addFields([
          { name: 'Last Position', value: `#${player.lastRating.position}`, inline: true },
          { name: 'ELO at Ban/Suspension', value: `${player.lastRating.rating} ELO`, inline: true },
          { name: 'Last Seen', value: `${player.hoursSinceSeen} hours ago`, inline: true },
          { name: 'GeoGuessr Profile', value: `[View Profile](${profileUrl})`, inline: false }
        ])
        .setTimestamp();
      
      await channel.send({ embeds: [embed] });
    } else {
      const banned = bannedPlayers.filter(p => p.confirmedBanned);
      const suspended = bannedPlayers.filter(p => p.suspended && !p.confirmedBanned);
      
      let title = '';
      if (banned.length > 0 && suspended.length > 0) {
        title = `🚫 ${banned.length} Banned, ⏸️ ${suspended.length} Suspended`;
      } else if (banned.length > 0) {
        title = `🚫 ${banned.length} Players Banned`;
      } else {
        title = `⏸️ ${suspended.length} Players Suspended`;
      }
      
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0xFF0000)
        .setTimestamp();
      
      const allPlayers = [...banned, ...suspended].sort((a, b) => a.lastRating.position - b.lastRating.position);
      
      const playerList = allPlayers.map(p => {
        const profileUrl = `https://www.geoguessr.com/user/${p.userId}`;
        const status = p.confirmedBanned ? '🚫' : '⏸️';
        return `${status} **#${p.lastRating.position}** [${p.nick}](${profileUrl}) - ${p.lastRating.rating} ELO`;
      }).join('\n');
      
      if (playerList.length <= 4096) {
        embed.setDescription(playerList);
      } else {
        const truncatedList = playerList.substring(0, 4093) + '...';
        embed.setDescription(truncatedList);
        embed.addFields([
          { name: 'Note', value: 'List truncated - too many players to display', inline: false }
        ]);
      }
      
      embed.setFooter({ text: `${bannedPlayers.length} total actions detected` });
      await channel.send({ embeds: [embed] });
    }
    
    console.log(`Ban/suspension notification sent for ${bannedPlayers.length} players`);
  } catch (error) {
    console.error('Error sending ban notification:', error);
  }
}

function startAutomaticChecking() {
  console.log('Starting automatic checking every 2 hours...');
  
  setTimeout(checkForBannedPlayers, 60000);
  
  checkInterval = setInterval(checkForBannedPlayers, CHECK_INTERVAL);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log(`Monitoring channel: ${ALLOWED_CHANNEL_ID}`);
  console.log(`Unban notifications channel: ${UNBAN_CHANNEL_ID}`);
  console.log(`Checking for bans every 2 hours`);
  
  startAutomaticChecking();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== ALLOWED_CHANNEL_ID) return;
  
  if (message.content === '!checkbans') {
    console.log(`Manual check requested by ${message.author.tag}`);
    await message.channel.sendTyping();
    
    try {
      await checkForBannedPlayers();
      await message.reply('Manual ban check completed. Check console for details.');
    } catch (error) {
      console.error('Error in manual check:', error);
      await message.reply('Error during manual check.');
    }
  }
  
  if (message.content === '!stats') {
    try {
      const data = loadPlayerData();
      const totalPlayers = Object.keys(data.players).length;
      const activePlayers = Object.values(data.players).filter(p => p.status === 'active').length;
      const bannedPlayers = Object.values(data.players).filter(p => p.status === 'banned').length;
      const suspendedPlayers = Object.values(data.players).filter(p => p.status === 'suspended').length;
      const lastCheck2 = '2025-05-31T08:24:55.484Z';
      const parisTime = lastCheck2
        ? DateTime.fromISO(lastCheck2).setZone('Europe/Paris').toFormat("dd/MM/yyyy HH:mm:ss")
        : 'Never';

      const embed = new EmbedBuilder()
        .setTitle('Stats :')
        .setColor(0x00FF00)
        .addFields([
          { name: 'Total Players Tracked', value: totalPlayers.toString(), inline: true },
          { name: 'Active Players', value: activePlayers.toString(), inline: true },
          { name: 'Banned Players', value: bannedPlayers.toString(), inline: true },
          { name: 'Suspended Players', value: suspendedPlayers.toString(), inline: true },
          { name: 'Total Checks', value: (data.totalChecks || 0).toString(), inline: true },
          {
            name: 'Last Check',
            value: `${parisTime}\n(Timezone: CEST - Paris time)`,
            inline: true
          },
          { name: 'Check Frequency', value: 'Every 2 hours', inline: false }
        ])
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error getting stats:', error);
      await message.reply('Error getting statistics.');
    }
  }
});

// SECURITY CHECK: Ensure required environment variables are set
if (!NCFA_COOKIE || NCFA_COOKIE === 'YOUR_NCFA_COOKIE_HERE') {
  console.error('GEOGUESSR_COOKIE environment variable required');
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN environment variable is required');
  console.error('Please set DISCORD_TOKEN in your environment variables');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
