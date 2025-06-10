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

const BAN_ROLE_ID = ''; // ping the role to notify people if someone got banned
const UNBAN_ROLE_ID = ''; // ping the role to notify people if someone got unbanned

const ALLOWED_CHANNEL_ID = ''; // channel to announce when someone got banned
const UNBAN_CHANNEL_ID = ''; // channel to announce when someone got unbanned

const API_BASE = 'https://www.geoguessr.com/api';
const NCFA_COOKIE = process.env.GEOGUESSR_COOKIE;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Cookie': `_ncfa=${NCFA_COOKIE}`
};

const PLAYER_TRACKING_FILE = 'player_tracking.json';
const BANNED_SUSPENDED_CSV = 'banned_suspended_players.csv';
const UNBANNED_UNSUSPENDED_CSV = 'unbanned_unsuspended_players.csv';
const CHECK_INTERVAL = 1 * 60 * 60 * 1000; // heure * minutes * secondes * ms

let checkInterval;
let rateLimitCounter = 0;
let lastRateLimitReset = Date.now();

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logRateLimit() {
  rateLimitCounter++;
  const now = Date.now();
  
  if (now - lastRateLimitReset > 3600000) {
    console.log(`Rate limit hits in last hour: ${rateLimitCounter}`);
    rateLimitCounter = 0;
    lastRateLimitReset = now;
  }
}

function initializeCSVFiles() {
  const bannedSuspendedHeaders = 'Date,Username,UserID,Profile_URL,countryCode,ELO,Position,Action_Type,Suspended_Until\n';
  const unbannedUnsuspendedHeaders = 'Date,Username,UserID,Profile_URL,countryCode,ELO,Position,Previous_Action_Type,Duration_Days\n';
  
  if (!fs.existsSync(BANNED_SUSPENDED_CSV)) {
    fs.writeFileSync(BANNED_SUSPENDED_CSV, bannedSuspendedHeaders, 'utf8');
  }
  
  if (!fs.existsSync(UNBANNED_UNSUSPENDED_CSV)) {
    fs.writeFileSync(UNBANNED_UNSUSPENDED_CSV, unbannedUnsuspendedHeaders, 'utf8');
  }
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function addToBannedSuspendedCSV(player) {
  try {
    const date = new Date().toISOString().split('T')[0];
    const profileUrl = `https://www.geoguessr.com/user/${player.userId}`;
    const actionType = player.confirmedBanned ? 'BANNED' : 'SUSPENDED';
    const suspendedUntil = player.suspended && player.suspendedUntil ? 
      new Date(player.suspendedUntil).toISOString().split('T')[0] : '';
    
    const csvLine = [
      escapeCSV(date),
      escapeCSV(player.nick),
      escapeCSV(player.userId),
      escapeCSV(profileUrl),
      escapeCSV(player.countryCode),
      escapeCSV(player.lastRating.rating),
      escapeCSV(player.lastRating.position),
      escapeCSV(actionType),
      escapeCSV(suspendedUntil)
    ].join(',') + '\n';
    
    fs.appendFileSync(BANNED_SUSPENDED_CSV, csvLine, 'utf8');
    console.log(`Added to banned/suspended CSV: ${player.nick} (${actionType})`);
  } catch (error) {
    console.error('Error adding to banned/suspended CSV:', error);
  }
}

function addToUnbannedUnsuspendedCSV(player, playerData) {
  try {
    const date = new Date().toISOString().split('T')[0];
    const profileUrl = `https://www.geoguessr.com/user/${player.userId}`;
    
    const previousActionType = playerData.status === 'banned' ? 'BANNED' : 'SUSPENDED';
    const actionDuration = playerData.bannedAt || playerData.suspendedAt ? 
      Math.floor((Date.now() - (playerData.bannedAt || playerData.suspendedAt)) / (24 * 60 * 60 * 1000)) : 0;
    
    const csvLine = [
      escapeCSV(date),
      escapeCSV(player.nick),
      escapeCSV(player.userId),
      escapeCSV(profileUrl),
      escapeCSV(player.countryCode),
      escapeCSV(player.rating),
      escapeCSV(player.position),
      escapeCSV(previousActionType),
      escapeCSV(actionDuration)
    ].join(',') + '\n';
    
    fs.appendFileSync(UNBANNED_UNSUSPENDED_CSV, csvLine, 'utf8');
    console.log(`Added to unbanned/unsuspended CSV: ${player.nick} (${previousActionType} - ${actionDuration} days)`);
  } catch (error) {
    console.error('Error adding to unbanned/unsuspended CSV:', error);
  }
}

function addToDeletedAccountsCSV(player) {
  try {
    const date = new Date().toISOString().split('T')[0];
    const profileUrl = `https://www.geoguessr.com/user/${player.userId}`;
    
    const csvLine = [
      escapeCSV(date),
      escapeCSV(player.nick),
      escapeCSV(player.userId),
      escapeCSV(profileUrl),
      escapeCSV(player.countryCode),
      escapeCSV(player.lastRating.rating),
      escapeCSV(player.lastRating.position),
      escapeCSV('DELETED_ACCOUNT'),
      escapeCSV('')
    ].join(',') + '\n';
    
    fs.appendFileSync(BANNED_SUSPENDED_CSV, csvLine, 'utf8');
    console.log(`Added to CSV as deleted account: ${player.nick}`);
  } catch (error) {
    console.error('Error adding deleted account to CSV:', error);
  }
}

function makeAPIRequest(url, maxRetries = 3) {
  return new Promise(async (resolve, reject) => {
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await new Promise((resolveInner, rejectInner) => {
          const request = https.get(url, { headers: HEADERS }, (res) => {
            if (res.statusCode === 429) {
              logRateLimit();
              const retryAfter = parseInt(res.headers['retry-after']) || 15;
              rejectInner(new Error(`Rate limited. Retry after ${retryAfter} seconds`));
              return;
            }
            
            if (res.statusCode === 404 || res.statusCode === 403) {
              rejectInner(new Error(`HTTP ${res.statusCode}: User not accessible`));
              return;
            }
            
            if (res.statusCode !== 200) {
              rejectInner(new Error(`HTTP Error: ${res.statusCode}`));
              return;
            }
            
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                resolveInner(JSON.parse(data));
              } catch (error) {
                rejectInner(new Error('Invalid JSON response'));
              }
            });
          });
          
          request.on('error', rejectInner);
          request.setTimeout(12000, () => {
            request.destroy();
            rejectInner(new Error('Request timeout'));
          });
        });
        
        return resolve(result);
        
      } catch (error) {
        lastError = error;
        
        if (attempt < maxRetries) {
          let waitTime = 1000;
          
          if (error.message.includes('Rate limited')) {
            waitTime = error.message.includes('Retry after') ? 
              parseInt(error.message.match(/\d+/)[0]) * 1000 : 
              Math.min(15000 + (attempt * 5000), 45000);
          } else if (error.message.includes('404') || error.message.includes('403')) {
            waitTime = 2000 + (attempt * 1000);
          } else {
            waitTime = 3000 + (attempt * 2000);
          }
          
          console.log(`Attempt ${attempt + 1} failed, waiting ${waitTime/1000}s: ${error.message}`);
          await delay(waitTime);
        }
      }
    }
    
    reject(lastError);
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


function getCountryFlag(countryCode) {
    if (!countryCode || typeof countryCode !== "string" || countryCode.length !== 2) return "🏳️";
    return countryCode
        .toUpperCase()
        .split('')
        .map(char => String.fromCodePoint(0x1F1E6 + char.charCodeAt(0) - 65))
        .join('');
}



async function fetchCurrentLeaderboard() {
  console.log('Fetching top 2000 leaderboard...');
  const allPlayers = [];
  
  for (let offset = 0; offset < 2000; offset += 100) {  // offset < XXXX = top XXXX on the lb only
    const url = `${API_BASE}/v4/ranked-system/ratings?offset=${offset}&limit=100`;
    try {
      const players = await makeAPIRequest(url);
      if (players.length === 0) break;
      
      allPlayers.push(...players);
      
      if (offset + 100 < 2000) {
        await delay(75);
      }
      
    } catch (error) {
      console.error(`Error fetching leaderboard at offset ${offset}:`, error.message);
      
      if (error.message.includes('Rate limited')) {
        console.log('Rate limited on leaderboard, waiting...');
        await delay(15000);
        offset -= 100; // retry la page
        continue;
      }
      break;
    }
  }
  
  console.log(`Fetched ${allPlayers.length} players from top 2000`);
  return allPlayers;
}

async function getUserActivity(userId) {
  try {
    const url = `${API_BASE}/v3/users/${userId}`;
    const response = await makeAPIRequest(url);
    
    const isBanned = response.isBanned === true || response.banned === true;
    const suspendedUntil = response.suspendedUntil || response.suspended_until;
    const isSuspended = suspendedUntil !== null && suspendedUntil !== undefined && new Date(suspendedUntil) > new Date();
    
    if (isBanned || isSuspended) {
      console.log(`DEBUG: User ${userId} - isBanned: ${isBanned}, suspendedUntil: ${suspendedUntil}, calculated suspended: ${isSuspended}`);
    }
    
    return {
      accessible: true,
      countryCode: response.countryCode || response.country_code,
      banned: isBanned,
      suspended: isSuspended,
      suspendedUntil: suspendedUntil,
      profile: response.user || response
    };
  } catch (error) {
    if (error.message.includes('404')) {
      return { 
        accessible: false, 
        banned: false,
        deleted: true,
        reason: 'User not found (404)'
      };
    } else if (error.message.includes('403')) {
      console.log(`WARNING: 403 error for user ${userId} - could be private or banned`);
      return { 
        accessible: false, 
        banned: false,
        deleted: true,
        reason: 'Access forbidden (403)'
      };
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


async function verifyAllTop2000Players(currentPlayers, data, currentTime) {
  console.log(`\n--- Starting verification of all ${currentPlayers.length} top 2000 players ---`);
  
  const bannedPlayers = [];
  const BATCH_SIZE = 15;
  const INTER_BATCH_DELAY = 150;
  let rateLimitHits = 0;
  let processedCount = 0;
  let consecutiveErrors = 0;
  
  for (let i = 0; i < currentPlayers.length; i += BATCH_SIZE) {
    const batch = currentPlayers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i/BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(currentPlayers.length/BATCH_SIZE);
    
    console.log(`\nProcessing batch ${batchNum}/${totalBatches} (players ${i+1}-${Math.min(i+BATCH_SIZE, currentPlayers.length)}):`);
    
    const promises = batch.map(async (player, index) => {
      try {
        if (index > 0) await new Promise(resolve => setTimeout(resolve, 30 * index));
        
        const activityData = await getUserActivity(player.userId);
        processedCount++;
        consecutiveErrors = 0;
        
        
        if (activityData.deleted) {
          let playerData = data.players[player.userId];
          if (!playerData) {
            playerData = {
              nick: player.nick,
              countryCode: player.countryCode,
              firstSeen: currentTime,
              ratings: [{ rating: player.rating, position: player.position, timestamp: currentTime }],
              lastSeen: currentTime,
              status: 'active'
            };
            data.players[player.userId] = playerData;
          }
          
          let isNewDeletion = false;
          if (playerData.status !== 'deleted_account') {
            isNewDeletion = true;
            playerData.status = 'deleted_account';
            playerData.deletedAt = currentTime;
            
            console.log(`[${processedCount}/${currentPlayers.length}] 🗑️ DELETED ACCOUNT: ${player.nick} (#${player.position}, ${player.rating} ELO)`);
            
            return {
              userId: player.userId,
              nick: player.nick,
              countryCode: player.countryCode,
              deletedAccount: true,
              lastRating: { rating: player.rating, position: player.position },
              hoursSinceSeen: 0,
              isNewDeletion: isNewDeletion
            };
          } else {
            console.log(`[${processedCount}/${currentPlayers.length}] 🔄 Already marked as deleted: ${player.nick} (#${player.position})`);
            return null;
          }
        }
        
        if (activityData.banned || activityData.suspended) {
          let playerData = data.players[player.userId];
          if (!playerData) {
            playerData = {
              nick: player.nick,
              countryCode: player.countryCode,
              firstSeen: currentTime,
              ratings: [{ rating: player.rating, position: player.position, timestamp: currentTime }],
              lastSeen: currentTime,
              status: 'active'
            };
            data.players[player.userId] = playerData;
          }
          
          let isNewSanction = false;
          if (activityData.banned) {
            if (playerData.status !== 'banned') {
              isNewSanction = true;
            }
          } else if (activityData.suspended) {
            if (playerData.status !== 'suspended' || playerData.suspendedUntil !== activityData.suspendedUntil) {
              isNewSanction = true;
            }
          }
          
          if (isNewSanction) {
            const banType = activityData.banned ? 'BANNED' : 'SUSPENDED';
            const suspensionInfo = activityData.suspended ? 
              ` until ${new Date(activityData.suspendedUntil).toLocaleString()}` : '';
            
            console.log(`[${processedCount}/${currentPlayers.length}] 🚫🚫🚫 ${banType}: ${player.nick} (#${player.position}, ${player.rating} ELO)${suspensionInfo}`);
            
          } else {
            console.log(`[${processedCount}/${currentPlayers.length}] 🔄 Ongoing sanction: ${player.nick} (#${player.position}) - Status unchanged (API: ${activityData.banned ? 'banned' : 'suspended'})`);
          }
          return {
              userId: player.userId,
              nick: player.nick,
              countryCode: activityData.countryCode,
              confirmedBanned: activityData.banned,
              suspended: activityData.suspended,
              suspendedUntil: activityData.suspendedUntil,
              lastRating: { rating: player.rating, position: player.position },
              hoursSinceSeen: 0,
              isNewSanction: isNewSanction
            };
        } else {
          console.log(`[${processedCount}/${currentPlayers.length}] ✅ Active: ${player.nick} (#${player.position}, ${player.rating} ELO)`);
          return null;
        }
      } catch (error) {
        processedCount++;
        consecutiveErrors++; 
        
        console.log(`[${processedCount}/${currentPlayers.length}] ❌ Error checking ${player.nick} (#${player.position}): ${error.message}`);
        
        if (error.message.includes('Rate limited') || error.message.includes('429')) {
          rateLimitHits++;
        }
        
        if (consecutiveErrors >= 3) {
          console.log(`⚠️ ${consecutiveErrors} consecutive errors detected, forcing longer delay...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        return null;
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value !== null) {
        bannedPlayers.push(result.value);
      } else if (result.status === 'rejected') {
        console.log(`[ERROR] Promise rejected for ${batch[index]?.nick}: ${result.reason}`);
        consecutiveErrors++;
      }
    });
    
    if (batchNum % 5 === 0 || batchNum === totalBatches) {
      console.log(`--- Progress: ${processedCount}/${currentPlayers.length} players checked (${Math.round(processedCount/currentPlayers.length*100)}%) ---`);
    }
    
    if (i + BATCH_SIZE < currentPlayers.length) {
      let delay = INTER_BATCH_DELAY;
      
      if (rateLimitHits > 12) {
        delay = INTER_BATCH_DELAY * 5;
        console.log(`Very high rate limit detected (${rateLimitHits}), increasing delay to ${delay}ms`);
      } else if (rateLimitHits > 8) {
        delay = INTER_BATCH_DELAY * 3;
        console.log(`High rate limit detected (${rateLimitHits}), increasing delay to ${delay}ms`);
      } else if (rateLimitHits > 4) {
        delay = INTER_BATCH_DELAY * 2;
        console.log(`Moderate rate limit detected (${rateLimitHits}), increasing delay to ${delay}ms`);
      } else if (consecutiveErrors > 5) {
        delay = INTER_BATCH_DELAY * 2;
        console.log(`High error rate detected (${consecutiveErrors}), increasing delay to ${delay}ms`);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      if (batchNum % 5 === 0) {
        rateLimitHits = Math.floor(rateLimitHits / 2);
        consecutiveErrors = Math.floor(consecutiveErrors / 2);
      }
    }
  }
  
  console.log(`\n--- Top 2000 Verification Summary ---`);
  console.log(`Total players checked: ${processedCount}/${currentPlayers.length}`);
  console.log(`Confirmed bans/suspensions found: ${bannedPlayers.filter(p => !p.deletedAccount).length}`);
  console.log(`Deleted accounts found: ${bannedPlayers.filter(p => p.deletedAccount).length}`);
  console.log(`Active players: ${processedCount - bannedPlayers.length}`);
  console.log(`Rate limit hits during verification: ${rateLimitHits}`);
  console.log(`Final consecutive errors: ${consecutiveErrors}`);
  
  return bannedPlayers;
}

async function verifyExistingSanctionedPlayers(sanctionedPlayers, data, currentTime) {
  console.log(`Verifying status changes for ${sanctionedPlayers.length} sanctioned players`);
  
  const statusChanges = [];
  const BATCH_SIZE = 8;
  const INTER_BATCH_DELAY = 200;
  let rateLimitHits = 0;
  let processedCount = 0;
  
  for (let i = 0; i < sanctionedPlayers.length; i += BATCH_SIZE) {
    const batch = sanctionedPlayers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i/BATCH_SIZE) + 1;
    
    console.log(`Processing sanctioned batch ${batchNum}/${Math.ceil(sanctionedPlayers.length/BATCH_SIZE)} (${batch.length} players)`);
    
    const promises = batch.map(async (player, index) => {
      try {
        if (index > 0) await new Promise(resolve => setTimeout(resolve, 75 * index));
        
        const activityData = await getUserActivity(player.userId);
        processedCount++;
        
        const playerData = data.players[player.userId];
        const lastRating = player.ratings[player.ratings.length - 1];
        const positionInfo = lastRating ? `#${lastRating.position}` : 'N/A';
        
        if (activityData.deleted) {
          let isNewDeletion = false;
          if (playerData.status !== 'deleted_account') {
            isNewDeletion = true;
            playerData.status = 'deleted_account';
            playerData.deletedAt = currentTime;
            
            console.log(`[${processedCount}/${sanctionedPlayers.length}] 🗑️ DELETED ACCOUNT: ${player.nick} (${positionInfo}) - Was ${player.status}`);
            
            return {
              userId: player.userId,
              nick: player.nick,
              countryCode: player.countryCode,
              deletedAccount: true,
              lastRating: lastRating || { rating: 'N/A', position: 'N/A' },
              isNewDeletion: isNewDeletion
            };
          } else {
            console.log(`[${processedCount}/${sanctionedPlayers.length}] 🔄 Already marked as deleted: ${player.nick} (${positionInfo})`);
            return null;
          }
        }
        
        let hasRealStatusChange = false;
        let newSanctionType = null;
        
        if (activityData.banned) {
          if (playerData.status !== 'banned') {
            hasRealStatusChange = true;
            newSanctionType = 'banned';
            console.log(`[${processedCount}/${sanctionedPlayers.length}] 🚫⬆️ STATUS UPGRADE TO BANNED: ${player.nick} (${positionInfo}) - ${playerData.status} → BANNED`);
          } else {
            console.log(`[${processedCount}/${sanctionedPlayers.length}] 🚫 Still banned: ${player.nick} (${positionInfo})`);
            return null;
          }
        } else if (activityData.suspended) {
          if (playerData.status === 'banned') {
            hasRealStatusChange = true;
            newSanctionType = 'suspended';
            console.log(`[${processedCount}/${sanctionedPlayers.length}] ⏸️⬇️ STATUS DOWNGRADE TO SUSPENDED: ${player.nick} (${positionInfo}) - BANNED → SUSPENDED until ${new Date(activityData.suspendedUntil).toLocaleString()}`);
          } else if (playerData.status === 'suspended') {
            if (playerData.suspendedUntil !== activityData.suspendedUntil) {
              hasRealStatusChange = true;
              newSanctionType = 'suspended';
              console.log(`[${processedCount}/${sanctionedPlayers.length}] ⏸️🔄 SUSPENSION DATE UPDATED: ${player.nick} (${positionInfo}) - New end: ${new Date(activityData.suspendedUntil).toLocaleString()}`);
            } else {
              console.log(`[${processedCount}/${sanctionedPlayers.length}] ⏸️ Still suspended: ${player.nick} (${positionInfo}) until ${new Date(activityData.suspendedUntil).toLocaleString()}`);
              return null;
            }
          } else {
            hasRealStatusChange = true;
            newSanctionType = 'suspended';
            console.log(`[${processedCount}/${sanctionedPlayers.length}] ⏸️ NEW SUSPENSION: ${player.nick} (${positionInfo}) - ${playerData.status} → SUSPENDED`);
          }
        } else {
          if (playerData.status === 'banned' || playerData.status === 'suspended') {
            console.log(`[${processedCount}/${sanctionedPlayers.length}] ✅ UNSANCTIONED: ${player.nick} (${positionInfo}) - Was ${playerData.status}, now active`);
            
            const currentPlayers = await fetchCurrentLeaderboard();
            const isOnLeaderboard = currentPlayers && currentPlayers.some(cp => cp.userId === player.userId);
            
            const eventKeySuffix = playerData.status === 'banned' ? 'unban' : 'unsuspend';
            const unbanKey = `${player.userId}_${eventKeySuffix}`;
            
            if (!data.eventCache.currentCheckUnbans[unbanKey]) {
              data.eventCache.currentCheckUnbans[unbanKey] = true;
              
              if (playerData.status === 'banned') {
                const mockPlayer = {
                  userId: player.userId,
                  nick: player.nick,
                  position: lastRating ? lastRating.position : 'N/A',
                  rating: lastRating ? lastRating.rating : 'N/A'
                };
                await sendUnbanNotification(mockPlayer, playerData);
                console.log(`UNBANNED: ${player.nick} notification sent.`);
                playerData.unbannedAt = currentTime;
              } else {
                console.log(`UNSUSPENDED (no Discord notification): ${player.nick} is back.`);
                playerData.unsuspendedAt = currentTime;
              }
              
              const mockPlayerForCSV = {
                userId: player.userId,
                nick: player.nick,
                position: lastRating ? lastRating.position : 'N/A',
                rating: lastRating ? lastRating.rating : 'N/A',
                countryCode: player.countryCode
              };
              addToUnbannedUnsuspendedCSV(mockPlayerForCSV, playerData);
              
              playerData.status = 'active';
              delete playerData.suspendedUntil;
              delete playerData.suspendedAt;
            }
          } else {
            console.log(`[${processedCount}/${sanctionedPlayers.length}] ✅ No longer sanctioned: ${player.nick} (${positionInfo}) - Was ${playerData.status}`);
          }
          return null;
        }
        
        if (hasRealStatusChange) {
          return {
            userId: player.userId,
            nick: player.nick,
            countryCode: activityData.countryCode,
            confirmedBanned: activityData.banned,
            suspended: activityData.suspended,
            suspendedUntil: activityData.suspendedUntil,
            lastRating: lastRating || { rating: 'N/A', position: 'N/A' },
            hoursSinceSeen: Math.floor((currentTime - player.lastSeen) / (60 * 60 * 1000)),
            isNewSanction: true,
            isStatusChange: true,
            previousStatus: playerData.status
          };
        }
        
        return null;
        
      } catch (error) {
        processedCount++;
        console.log(`[${processedCount}/${sanctionedPlayers.length}] ❌ Error checking ${player.nick}: ${error.message}`);
        
        if (error.message.includes('Rate limited') || error.message.includes('429')) {
          rateLimitHits++;
        }
        
        return null;
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value !== null) {
        statusChanges.push(result.value);
      } else if (result.status === 'rejected') {
        console.log(`[ERROR] Promise rejected for ${batch[index]?.nick}: ${result.reason}`);
      }
    });
    
    if (i + BATCH_SIZE < sanctionedPlayers.length) {
      let delay = INTER_BATCH_DELAY;
      
      if (rateLimitHits > 2) {
        delay = INTER_BATCH_DELAY * 2;
        console.log(`Rate limit detected, increasing delay to ${delay}ms`);
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.log(`\n--- Existing Sanctioned Players Verification Summary ---`);
  console.log(`Total players checked: ${processedCount}/${sanctionedPlayers.length}`);
  console.log(`Real status changes detected: ${statusChanges.length}`);
  
  return statusChanges;
}

async function checkForBannedPlayers() {
  const startTime = Date.now();
  console.log(`\n--- Starting check at ${new Date().toISOString()} ---`);
  
  try {
    const data = loadPlayerData();
    const currentPlayers = await fetchCurrentLeaderboard();
    const currentTime = Date.now();
    
    if (!data.eventCache) {
      data.eventCache = {
        currentCheckBans: {},
        currentCheckUnbans: {},
        lastCleanup: currentTime
      };
    }
    
    data.eventCache.currentCheckBans = {};
    data.eventCache.currentCheckUnbans = {};
    
    const isFirstCheckAfterRestart = !data.lastCheck || (currentTime - data.lastCheck) > (3 * 60 * 60 * 1000);
    
    if (!currentPlayers || currentPlayers.length === 0) {
      console.log('Failed to fetch leaderboard, skipping check');
      await sendStatusMessage('Failed to fetch leaderboard data', true);
      return;
    }
    
    const currentPlayerIds = new Set();
    
    const missingPlayers = [];
    const sixHourAgo = currentTime - (6 * 60 * 60 * 1000);

    for (const [userId, playerData] of Object.entries(data.players)) {
      if (playerData.lastSeen > sixHourAgo && 
          playerData.status === 'active') {
        
        const isCurrentlyOnLeaderboard = currentPlayers.some(p => p.userId === userId);
        
        if (!isCurrentlyOnLeaderboard) {
          const hoursSinceSeen = Math.floor((currentTime - playerData.lastSeen) / (60 * 60 * 1000));
          
          if (hoursSinceSeen >= 1 && hoursSinceSeen < 24) {
            missingPlayers.push({
              userId,
              ...playerData,
              hoursSinceSeen
            });
          }
        }
      }
    }
    
    console.log(`Found ${missingPlayers.length} recently missing players to verify first`);
    
    let priorityBannedPlayers = [];
    if (missingPlayers.length > 0) {
      priorityBannedPlayers = await verifyBannedPlayers(missingPlayers, data, currentTime);
      
      if (priorityBannedPlayers.length > 0) {
        const newBans = priorityBannedPlayers.filter(p => p.isNewSanction && !p.deletedAccount);
        const newDeletions = priorityBannedPlayers.filter(p => p.deletedAccount && p.isNewDeletion);
        
        if (newBans.length > 0) {
          await sendBanNotification(newBans);
          
          for (const player of newBans) {
            const banKey = `${player.userId}_ban_${player.confirmedBanned ? 'banned' : 'suspended'}`;
            
            if (!data.eventCache.currentCheckBans[banKey]) {
              data.eventCache.currentCheckBans[banKey] = true;
              addToBannedSuspendedCSV(player);
              
              const pDataToUpdate = data.players[player.userId];
              if (pDataToUpdate) {
                if (player.confirmedBanned) {
                  if (pDataToUpdate.status !== 'banned') pDataToUpdate.bannedAt = currentTime;
                  pDataToUpdate.status = 'banned';
                  delete pDataToUpdate.suspendedUntil; 
                  delete pDataToUpdate.suspendedAt;
                } else if (player.suspended) {
                  if (pDataToUpdate.status !== 'suspended' || pDataToUpdate.suspendedUntil !== player.suspendedUntil) pDataToUpdate.suspendedAt = currentTime;
                  pDataToUpdate.status = 'suspended';
                  pDataToUpdate.suspendedUntil = player.suspendedUntil;
                }
              }
            }
          }
        }
        
        if (newDeletions.length > 0) {
          await sendDeletedAccountNotification(newDeletions);
          for (const player of newDeletions) {
            addToDeletedAccountsCSV(player);
          }
        }
        
        savePlayerData(data);
        
        const priorityDuration = Math.round((Date.now() - startTime) / 1000);
        console.log(`Priority check completed in ${priorityDuration}s - found ${newBans.length} new bans/suspensions from missing players`);
      }
    }
    
    console.log(`\nFetching API status for all ${currentPlayers.length} top 2000 players...`);
    const top2000ApiSanctionInfo = await verifyAllTop2000Players(currentPlayers, data, currentTime);

    for (const player of currentPlayers) {
      currentPlayerIds.add(player.userId);
      
      if (!data.players[player.userId]) {
        data.players[player.userId] = {
          nick: player.nick,
          countryCode: player.countryCode,
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

        const apiSanction = top2000ApiSanctionInfo.find(s => s && s.userId === player.userId);
        const alreadyProcessedByPriority = priorityBannedPlayers.some(p => p && p.userId === player.userId);

        if (apiSanction && !alreadyProcessedByPriority) {
            if (apiSanction.isNewSanction) {
                console.log(`[STATUS UPDATE] New sanction for ${player.nick}. Bot status changing from ${playerData.status}.`);
                if (apiSanction.confirmedBanned) {
                    playerData.status = 'banned';
                    playerData.bannedAt = playerData.bannedAt || currentTime;
                    delete playerData.suspendedUntil;
                    delete playerData.suspendedAt;
                } else {
                    playerData.status = 'suspended';
                    playerData.suspendedAt = playerData.suspendedAt || currentTime;
                    playerData.suspendedUntil = apiSanction.suspendedUntil;
                }
            } else {
                if (playerData.status === 'active') {
                    console.warn(`[DATA CORRECTION] ${player.nick} is sanctioned by API (${apiSanction.confirmedBanned ? 'banned' : 'suspended'}) but bot thought 'active'. Correcting status.`);
                    if (apiSanction.confirmedBanned) {
                        playerData.status = 'banned';
                        playerData.bannedAt = playerData.bannedAt || currentTime;
                    } else {
                        playerData.status = 'suspended';
                        playerData.suspendedAt = playerData.suspendedAt || currentTime;
                        playerData.suspendedUntil = apiSanction.suspendedUntil;
                    }
                }
            }
        } else if (!alreadyProcessedByPriority) { 
            if ((playerData.status === 'banned' || playerData.status === 'suspended' || playerData.status === 'suspension_expired') && 
                playerData.status !== 'deleted_account' &&
                !isFirstCheckAfterRestart) {
                
                const previousStatus = playerData.status;
                const eventKeySuffix = previousStatus === 'banned' ? 'unban' : 'unsuspend';
                const unbanKey = `${player.userId}_${eventKeySuffix}`;

                if (!data.eventCache.currentCheckUnbans[unbanKey]) {
                    console.log(`Player ${player.nick} is active on API & leaderboard. Previous bot status: ${previousStatus}.`);
                    data.eventCache.currentCheckUnbans[unbanKey] = true;

                    if (previousStatus === 'banned') {
                        await sendUnbanNotification(player, playerData);
                        console.log(`UNBANNED: ${player.nick} notification sent.`);
                        playerData.unbannedAt = currentTime;
                    } else {
                        console.log(`UNSUSPENDED (no Discord notification): ${player.nick} is back.`);
                        playerData.unsuspendedAt = currentTime;
                    }
                    addToUnbannedUnsuspendedCSV(player, playerData);

                    playerData.status = 'active';
                }
            } else if (playerData.status !== 'active' && playerData.status !== 'deleted_account') {
                if (isFirstCheckAfterRestart || playerData.status === 'suspension_expired') {
                    console.log(`[SILENT UPDATE] ${player.nick} from ${playerData.status} to active. API reports active.`);
                }
                playerData.status = 'active';
            }
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
    
    if (isFirstCheckAfterRestart) {
        console.log('🔄 First check after restart - skipping unban notifications to avoid false positives');
        await sendStatusMessage('Bot restarted - status updated silently to avoid false unban notifications');
    }
    
    for (const [userId, playerData] of Object.entries(data.players)) {
        if (playerData.status === 'suspended' && 
            playerData.suspendedUntil && 
            currentTime >= new Date(playerData.suspendedUntil).getTime()) {
            
            console.log(`SUSPENSION EXPIRED: ${playerData.nick} suspension has naturally expired`);
            playerData.status = 'suspension_expired';
            delete playerData.suspendedUntil;
            delete playerData.suspendedAt;
        }
    }
    
    console.log('\nChecking existing suspended/banned players for status changes...');
    const existingSanctionedPlayers = [];

    for (const [userId, playerData] of Object.entries(data.players)) {
      if ((playerData.status === 'suspended' || playerData.status === 'banned') && 
          playerData.status !== 'deleted_account' &&
          playerData.lastSeen > currentTime - (7 * 24 * 60 * 60 * 1000)) {
        
        existingSanctionedPlayers.push({
          userId,
          nick: playerData.nick,
          countryCode: playerData.countryCode,
          status: playerData.status,
          suspendedUntil: playerData.suspendedUntil,
          lastSeen: playerData.lastSeen,
          ratings: playerData.ratings
        });
      }
    }

    console.log(`Found ${existingSanctionedPlayers.length} existing sanctioned players to verify`);
    const existingSanctionedApiInfo = existingSanctionedPlayers.length > 0 ?
      await verifyExistingSanctionedPlayers(existingSanctionedPlayers, data, currentTime) : [];
    
    const allSanctionsFromApi = [...top2000ApiSanctionInfo, ...existingSanctionedApiInfo].filter(s => s !== null);
    const allDeletedAccounts = allSanctionsFromApi.filter(s => s && s.deletedAccount && s.isNewDeletion);
    const allNewSanctionEvents = allSanctionsFromApi.filter(s => s && s.isNewSanction && !s.deletedAccount);
    
    if (allNewSanctionEvents.length > 0) {
      console.log(`\nProcessing ${allNewSanctionEvents.length} new/updated bans/suspensions for notification...`);
      
      await sendBanNotification(allNewSanctionEvents);
      
      for (const player of allNewSanctionEvents) {
        const banKey = `${player.userId}_ban_${player.confirmedBanned ? 'banned' : 'suspended'}`;
        
        if (!data.eventCache.currentCheckBans[banKey]) {
          data.eventCache.currentCheckBans[banKey] = true;
          
          addToBannedSuspendedCSV(player);
          
          const pDataToUpdate = data.players[player.userId];
          if (pDataToUpdate) {
              if (player.confirmedBanned) {
                  if (pDataToUpdate.status !== 'banned') pDataToUpdate.bannedAt = currentTime;
                  pDataToUpdate.status = 'banned';
                  delete pDataToUpdate.suspendedUntil; 
                  delete pDataToUpdate.suspendedAt;
              } else if (player.suspended) {
                  if (pDataToUpdate.status !== 'suspended' || pDataToUpdate.suspendedUntil !== player.suspendedUntil) pDataToUpdate.suspendedAt = currentTime;
                  pDataToUpdate.status = 'suspended';
                  pDataToUpdate.suspendedUntil = player.suspendedUntil;
              }
          }
        }
      }
    }
    
    if (allDeletedAccounts.length > 0) {
      console.log(`\nProcessing ${allDeletedAccounts.length} deleted accounts...`);
      
      await sendDeletedAccountNotification(allDeletedAccounts);
      
      for (const player of allDeletedAccounts) {
        addToDeletedAccountsCSV(player);
      }
    }

    data.lastCheck = currentTime;
    data.totalChecks = (data.totalChecks || 0) + 1;
    savePlayerData(data);
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    const totalNewBans = (priorityBannedPlayers.filter(p => p.isNewSanction && !p.deletedAccount).length) + allNewSanctionEvents.length;
    
    const statusMessage = totalNewBans > 0 
      ? `Check completed in ${duration}s. Found ${totalNewBans} new/updated ban(s)/suspension(s).`
      : `Check completed in ${duration}s. No new or updated bans/suspensions detected.`;
    
    await sendStatusMessage(statusMessage);
    console.log(`Check completed in ${duration} seconds. Total checks: ${data.totalChecks}`);
    console.log(`At: ${new Date().toLocaleTimeString()}`);
    
  } catch (error) {
    console.error('Error during check:', error);
    await sendStatusMessage(`Check failed: ${error.message}`, true);
  }
}

async function verifyBannedPlayers(missingPlayers, data, currentTime) {
  console.log(`Verifying ban status for ${missingPlayers.length} missing players`);
  
  const top2000MissingPlayers = missingPlayers;
  
  console.log(`${top2000MissingPlayers.length} of ${missingPlayers.length} missing players were in top 2000`);
  
  if (top2000MissingPlayers.length === 0) {
    return [];
  }
  
  const bannedPlayers = [];
  const BATCH_SIZE = 12;
  const INTER_BATCH_DELAY = 120;
  let rateLimitHits = 0;
  let processedCount = 0;
  
  console.log(`\n--- Starting verification of ${top2000MissingPlayers.length} players ---`);
  
  for (let i = 0; i < top2000MissingPlayers.length; i += BATCH_SIZE) {
    const batch = top2000MissingPlayers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i/BATCH_SIZE) + 1;    
    
    console.log(`\nProcessing batch ${batchNum}/${Math.ceil(top2000MissingPlayers.length/BATCH_SIZE)} (${batch.length} players):`);
    
    const promises = batch.map(async (player, index) => {
      try {
        if (index > 0) await new Promise(resolve => setTimeout(resolve, 35 * index));
        
        const activityData = await getUserActivity(player.userId);
        processedCount++;
        
        const lastRating = player.ratings[player.ratings.length - 1];
        const positionInfo = lastRating ? `#${lastRating.position}` : 'N/A';
        const eloInfo = lastRating ? `${lastRating.rating} ELO` : 'N/A';
        
        if (activityData.deleted) {
          const pData = data.players[player.userId];
          
          let isNewDeletion = false;
          if (pData.status !== 'deleted_account') {
            isNewDeletion = true;
            pData.status = 'deleted_account';
            pData.deletedAt = currentTime;
            
            console.log(`[${processedCount}/${top2000MissingPlayers.length}] 🗑️ DELETED ACCOUNT: ${player.nick} (${positionInfo}, ${eloInfo}) - Last seen ${player.hoursSinceSeen}h ago`);
            
            return {
              ...player,
              countryCode: player.countryCode,
              deletedAccount: true,
              lastRating: lastRating,
              isNewDeletion: isNewDeletion
            };
          } else {
            console.log(`[${processedCount}/${top2000MissingPlayers.length}] 🔄 Already marked as deleted: ${player.nick} (${positionInfo})`);
            return null;
          }
        }
        
        if (activityData.banned || activityData.suspended) {
          const pData = data.players[player.userId];
          
          let isNewSanction = false;
          if (activityData.banned) {
            if (pData.status !== 'banned') {
              isNewSanction = true;
            }
          } else if (activityData.suspended) {
            if (pData.status !== 'suspended' || pData.suspendedUntil !== activityData.suspendedUntil) {
              isNewSanction = true;
            }
          }

          if (isNewSanction) {
            const banType = activityData.banned ? 'BANNED' : 'SUSPENDED';
            const suspensionInfo = activityData.suspended ? 
              ` until ${new Date(activityData.suspendedUntil).toLocaleString()}` : '';
            
            console.log(`[${processedCount}/${top2000MissingPlayers.length}] 🚫 ${banType}: ${player.nick} (${positionInfo}, ${eloInfo}) - Last seen ${player.hoursSinceSeen}h ago${suspensionInfo}`);
            
          } else {
            console.log(`[${processedCount}/${top2000MissingPlayers.length}] 🔄 Ongoing sanction (missing player): ${player.nick} (${positionInfo}) - Status unchanged (API: ${activityData.banned ? 'banned' : 'suspended'})`);
          }
          
          return {
            ...player,
            countryCode: activityData.countryCode,
            confirmedBanned: activityData.banned,
            suspended: activityData.suspended,
            suspendedUntil: activityData.suspendedUntil,
            lastRating: lastRating,
            isNewSanction: isNewSanction
          };
        } else {
          console.log(`[${processedCount}/${top2000MissingPlayers.length}] ✅ Active (inactive drop): ${player.nick} (${positionInfo}, ${eloInfo}) - Last seen ${player.hoursSinceSeen}h ago`);
          return null;
        }
      } catch (error) {
        processedCount++;
        const lastRating = player.ratings[player.ratings.length - 1];
        const positionInfo = lastRating ? `#${lastRating.position}` : 'N/A';
        
        console.log(`[${processedCount}/${top2000MissingPlayers.length}] ❌ Error checking ${player.nick} (${positionInfo}): ${error.message}`);
        
        if (error.message.includes('Rate limited') || error.message.includes('429')) {
          rateLimitHits++;
        }
        
        return null;
      }
    });
    
    const results = await Promise.allSettled(promises);
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value !== null) {
        bannedPlayers.push(result.value);
      } else if (result.status === 'rejected') {
        console.log(`[ERROR] Promise rejected for ${batch[index]?.nick}: ${result.reason}`);
      }
    });
    
    if (i + BATCH_SIZE < top2000MissingPlayers.length) {
      let delay = INTER_BATCH_DELAY;
      
      if (rateLimitHits > 5) {
        delay = INTER_BATCH_DELAY * 3;
        console.log(`Rate limit detected, increasing delay to ${delay}ms`);
      } else if (rateLimitHits > 2) {
        delay = INTER_BATCH_DELAY * 2;
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      if (batchNum % 3 === 0) {
        rateLimitHits = Math.floor(rateLimitHits / 2);
      }
    }
  }
  
  console.log(`\n--- Missing Players Verification Summary ---`);
  console.log(`Total players checked: ${processedCount}/${top2000MissingPlayers.length}`);
  console.log(`Confirmed bans/suspensions: ${bannedPlayers.filter(p => !p.deletedAccount).length}`);
  console.log(`Deleted accounts: ${bannedPlayers.filter(p => p.deletedAccount).length}`);
  console.log(`Still active (inactivity drops): ${processedCount - bannedPlayers.length}`);
  console.log(`Rate limit hits during verification: ${rateLimitHits}`);
  
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
    
    await channel.send({ 
      content: `<@&${UNBAN_ROLE_ID}>`,
      embeds: [embed] 
    });
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

      const flag = player.countryCode ? `:flag_${player.countryCode.toLowerCase()}:` : '';
      
      const title = player.confirmedBanned ? '🚫 Player Banned' : '⏸️ Player Suspended';
      const description = player.confirmedBanned ? 
        `${flag} **${player.nick}** has been banned !!!` :
        `${flag} **${player.nick}** has been suspended until ${new Date(player.suspendedUntil).toLocaleString()}`;
      
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
      
      await channel.send({ 
        content: `<@&${BAN_ROLE_ID}>`,
        embeds: [embed] 
      });
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
        const flag = getCountryFlag(p.countryCode);
        return `${status} **#${p.lastRating.position}** ${flag} [${p.nick}](${profileUrl}) - ${p.lastRating.rating} ELO`;
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
      
      await channel.send({ 
        content: `<@&${BAN_ROLE_ID}>`,
        embeds: [embed] 
      });
    }
    
    console.log(`Ban/suspension notification sent for ${bannedPlayers.length} players`);
  } catch (error) {
    console.error('Error sending ban notification:', error);
  }
}

async function sendDeletedAccountNotification(deletedPlayers) {
  try {
    const channel = await client.channels.fetch(ALLOWED_CHANNEL_ID);
    
    if (deletedPlayers.length === 1) {
      const player = deletedPlayers[0];
      const profileUrl = `https://www.geoguessr.com/user/${player.userId}`;
      const flag = getCountryFlag(player.countryCode);
      
      const embed = new EmbedBuilder()
        .setTitle('🗑️ Account Deleted')
        .setColor(0x808080)
        .setDescription(`${flag} **${player.nick}** has deleted their account`)
        .addFields([
          { name: 'Last Position', value: `#${player.lastRating.position}`, inline: true },
          { name: 'Last ELO', value: `${player.lastRating.rating} ELO`, inline: true },
          { name: 'Last Seen', value: `${player.hoursSinceSeen || 0} hours ago`, inline: true },
          { name: 'Profile URL', value: `[Deleted Profile](${profileUrl})`, inline: false }
        ])
        .setTimestamp();
      
      await channel.send({ embeds: [embed] });
    } else {
      const embed = new EmbedBuilder()
        .setTitle(`🗑️ ${deletedPlayers.length} Accounts Deleted`)
        .setColor(0x808080)
        .setTimestamp();
      
      const playerList = deletedPlayers.map(p => {
        const profileUrl = `https://www.geoguessr.com/user/${p.userId}`;
        const flag = getCountryFlag(p.countryCode);
        return `🗑️ **#${p.lastRating.position}** ${flag} [${p.nick}](${profileUrl}) - ${p.lastRating.rating} ELO`;
      }).join('\n');
      
      if (playerList.length <= 4096) {
        embed.setDescription(playerList);
      } else {
        const truncatedList = playerList.substring(0, 4093) + '...';
        embed.setDescription(truncatedList);
        embed.addFields([
          { name: 'Note', value: 'List truncated - too many accounts to display', inline: false }
        ]);
      }
      
      embed.setFooter({ text: `${deletedPlayers.length} accounts deleted` });
      
      await channel.send({ embeds: [embed] });
    }
    
    console.log(`Deleted account notification sent for ${deletedPlayers.length} players`);
  } catch (error) {
    console.error('Error sending deleted account notification:', error);
  }
}

function startAutomaticChecking() {
  console.log('Starting automatic checking every hour...');
  
  setTimeout(checkForBannedPlayers, 1000);
  
  checkInterval = setInterval(checkForBannedPlayers, CHECK_INTERVAL);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  console.log(`Monitoring top 2000 players only`);
  
  initializeCSVFiles();
  startAutomaticChecking();
});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== ALLOWED_CHANNEL_ID) return;
  
  if (message.content === '!checkbans') {
    console.log(`Manual check requested by ${message.author.tag}`);
    await message.channel.sendTyping();
    
    await message.channel.send('manual ban check started, this may take up to 5 minutes, please wait... <a:waiting:1378781339569885204>');

    
    try {
      await checkForBannedPlayers();
      await message.channel.send('Manual ban check completed.');
    } catch (error) {
      console.error('Error in manual check:', error);
      await message.reply('Error during manual check. Check console for details.');
    }
  }
  
  if (message.content === '!stats') {
    try {
      const data = loadPlayerData();
      const totalPlayers = Object.keys(data.players).length;
      const activePlayers = Object.values(data.players).filter(p => p.status === 'active').length;
      const bannedPlayers = Object.values(data.players).filter(p => p.status === 'banned').length;
      const suspendedPlayers = Object.values(data.players).filter(p => p.status === 'suspended').length;
      const lastCheck = data.lastCheck;
      const parisTime = lastCheck
        ? DateTime.fromMillis(lastCheck).setZone('Europe/Paris').toFormat("dd/MM/yyyy HH:mm:ss")
        : 'Never';

      const embed = new EmbedBuilder()
        .setTitle('📊 Bot Statistics (Top 2000)')
        .setColor(0x00FF00)
        .addFields([
          { name: 'Total Players Tracked', value: totalPlayers.toString(), inline: true },
          { name: 'Active Players', value: activePlayers.toString(), inline: true },
          { name: 'Banned Players', value: bannedPlayers.toString(), inline: true },
          { name: 'Suspended Players', value: suspendedPlayers.toString(), inline: true },
          { name: 'Total Checks', value: (data.totalChecks || 0).toString(), inline: true },
          { name: 'Rate Limit Hits/Hour', value: rateLimitCounter.toString(), inline: true },
          {
            name: 'Last Check',
            value: `${parisTime}\n(CEST - Paris time)`,
            inline: false
          },
          { name: 'Check Frequency', value: 'Every 2 hours (Top 2000 only)', inline: false }
        ])
        .setTimestamp();

      await message.reply({ embeds: [embed] });
    } catch (error) {
      console.error('Error getting stats:', error);
      await message.reply('Error getting statistics.');
    }
  }
});

if (!NCFA_COOKIE || NCFA_COOKIE === 'YOUR_NCFA_COOKIE_HERE') {
  console.error('GEOGUESSR_COOKIE environment variable required');
  process.exit(1);
}

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN environment variable is required');
  process.exit(1);
}

client.login(DISCORD_TOKEN);
