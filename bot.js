// Read Config file
const {
	token,

	color,
	database_type,
	database_uri,
	database_username,
	database_password,
	grace_period,
	permissions_regexp,
	prefix,

	clear_cmd,
	color_cmd,
	command_prefix_cmd,
	display_cmd,
	grace_period_cmd,
	help_cmd,
	join_cmd,
	next_cmd,
	kick_cmd,
	queue_cmd,
	start_cmd
} = require('./config.json');

// Setup client
require('events').EventEmitter.defaultMaxListeners = 40; // Maximum number of events that can be handled at once.
const { Client } = require('discord.js');
const client = new Client({ ws: { intents: ['GUILDS', 'GUILD_VOICE_STATES', 'GUILD_MESSAGES'] } });

// Default DB Settings
const defaultDBData = [grace_period, prefix, color, "", "", "", "", "", "", ""];
const ServerSettings = {
	[grace_period_cmd]: { index: 0, str: "grace period" },
	[command_prefix_cmd]: { index: 1, str: "command prefix" },
	[color_cmd]: { index: 2, str: "color" },
};
Object.freeze(ServerSettings);

// Keyv long term DB storage
const Keyv = require('keyv');
const channelDict = new Keyv(`${database_type}://${database_username}:${database_password}@${database_uri}`);	// guild.id | grace_period, [voice Channel.id, ...]
channelDict.on('error', err => console.error('Keyv connection error:', err));

// Short term storage
const guildMemberDict = [];		// guild.id | GuildChannel.id | [guildMember.id, ...]
const displayEmbedDict = [];	// guild.id | GuildChannel.id | display GuildChannel.id | [message.id, ...]

// Storage Mutexes
const Mutex = require('async-mutex');
const channelLocks = new Map();	// Map<guild.id, MutexInterface>;
const guildMemberLocks = new Map();		// Map<guild.id, MutexInterface>;
const displayEmbedLocks = new Map();	// Map<guild.id, MutexInterface>;

const sleep = m => new Promise(r => setTimeout(r, m));

async function setupLocks(guildId) {
	channelLocks.set(guildId, new Mutex.Mutex());
	guildMemberLocks.set(guildId, new Mutex.Mutex());
	displayEmbedLocks.set(guildId, new Mutex.Mutex());
}

client.login(token);
client.on('error', error => {
	console.error('The WebSocket encountered an error:', error);
});
// Cleanup deleted guilds and channels at startup. Then read in members inside tracked queues.
client.once('ready', async () => {
	for (const guildIdChannelPair of await channelDict.entries()) {
		const guild = client.guilds.cache.get(guildIdChannelPair[0]);
		// Cleanup deleted Guilds
		if (!guild) {
			await channelDict.delete(guildIdChannelPair[0]);
		}
		else {
			// Create locks
			await setupLocks(guild.id);
			// LOCK
			const guildMemberRelease = await guildMemberLocks.get(guild.id).acquire();
			const channelRelease = await channelLocks.get(guild.id).acquire();
			try {
				const dbData = guildIdChannelPair[1];
				const otherData = dbData.slice(0, 10);
				const channels = await fetchStoredChannels(dbData, guild);
				// Set unset values to default
				for (let i = 0; i < otherData.length; i++) {
					otherData[i] = otherData[i] || defaultDBData[i];
				}
				// Initialize member queue
				guildMemberDict[guild.id] = guildMemberDict[guild.id] || [];
				for (const channel of channels) {
					if (channel) {
						// Add people already in a voice channel queue
						guildMemberDict[guild.id][channel.id] = (channel.type === 'voice') ?
							channel.members.filter(member => !member.user.bot).map(member => member.id) : [];
					}
					else {
						// Cleanup deleted Channels
						channels.splice(channels.indexOf(channel), 1);
					}
				}
				await channelDict.set(guild.id, otherData.concat(channels.map(ch => ch.id)));
			}
			finally {
				// UNLOCK
				guildMemberRelease();
				channelRelease();
			}
		}
	}
	client.user.setPresence({ activity: { name: `${prefix}${help_cmd} for help` }, status: 'online' });
	console.log('Ready!');
});
client.on('shardResume', async () => {
	for (const guildId of Object.keys(guildMemberDict)) {
		await guildMemberLocks.get(guildId).runExclusive(async () => {
			const availableVoiceChannels = Object.keys(guildMemberDict[guildId]).map(id => client.channels.cache.get(id));
			for (const channel of availableVoiceChannels) {
				// Remove users who left during disconnect
				if (guildMemberDict[guildId][channel]) {
					for (let i = 0; i < guildMemberDict[guildId][channel].length; i++) {
						const memberId = guildMemberDict[guildId][channel][i];
						if (!channel.members.includes(memberId)) {
							guildMemberDict[guildId][channel].splice(i, 1); i--;
						}
					}
					// Add users who joined during disconnect
					for (let i = 0; i < channel.members.length; i++) {
						const memberId = channel.members[i].id;
						if (!member.user.bot && !guildMemberDict[guildId][channel].includes(memberId)) {
							guildMemberDict[guildId][channel].push(memberId);
						}
					}
                }
			}
		});
	}
	client.user.setPresence({ activity: { name: `${prefix}${help_cmd} for help` }, status: 'online' });
	console.log('Reconnected!');
});

async function fetchStoredChannels(dbData, guild) {
	let channels = [];
	for (let i = 10; i < dbData.length; i++) {
		const channel = guild.channels.cache.get(dbData[i]);
		if (channel) {
			channels.push(channel);
		}
		else {
			dbData.splice(i, 1);
        }
	}
	await channelDict.set(guild.id, dbData);
	return (channels === []) ? null : channels;
}

// Monitor for users joining voice channels
client.on('voiceStateUpdate', async (oldVoiceState, newVoiceState) => {
	const oldVoiceChannel = oldVoiceState.channel;
	const newVoiceChannel = newVoiceState.channel;

	if (oldVoiceChannel !== newVoiceChannel) {
		const member = newVoiceState.member;
		const guild = newVoiceState.guild;

		if (guildMemberLocks.get(guild.id)) {
			await guildMemberLocks.get(guild.id).runExclusive(async () => {

				// Initialize empty queue if necessary
				guildMemberDict[guild.id] = guildMemberDict[guild.id] || [];
			
				const availableVoiceChannels = Object.keys(guildMemberDict[guild.id]).map(id => client.channels.cache.get(id));
				
				if (availableVoiceChannels.includes(newVoiceChannel) || availableVoiceChannels.includes(oldVoiceChannel)) {
					// Bot
					if (member.user.bot) {
						if (newVoiceChannel && !availableVoiceChannels.includes(newVoiceChannel)) { // Prevent pulling people into another queue
							if (guildMemberDict[guild.id][oldVoiceChannel.id].length > 0) {
								// If the use queue is not empty, pull in the next in user queue
								guild.members.cache.get(guildMemberDict[guild.id][oldVoiceChannel.id][0]).voice.setChannel(newVoiceChannel);
							}
							// Return bot to queue channel
							newVoiceState.setChannel(oldVoiceChannel);
						}
					}
					// Person
					else {
						if (availableVoiceChannels.includes(newVoiceChannel) && !guildMemberDict[guild.id][newVoiceChannel.id].includes(member.id)) {
							// User joined channel, add to queue
							guildMemberDict[guild.id][newVoiceChannel.id].push(member.id); 
							updateDisplayQueue(guild, [oldVoiceChannel, newVoiceChannel]);
						}
						if (availableVoiceChannels.includes(oldVoiceChannel)) {
							// User left channel, start removal process
							checkAfterLeaving(member, guild, oldVoiceChannel);
						}
					}
				}
			});
		}
	}
});

/**
 * Send message
 *
 * @param {Message} message Object that sends message.
 * @param {any} messageToSend String to send.
 */
async function send(message, messageToSend) {
	if (message.channel.permissionsFor(message.guild.me).has('SEND_MESSAGES') && message.channel.permissionsFor(message.guild.me).has('EMBED_LINKS')) {
		return message.channel.send(messageToSend);
	} else {
		return message.author.send(`I don't have permission to write messages and embeds in \`${message.channel.name}\``);
    }
}

/**
 * Watch a user after they leave queue. Remove them once the grace period is reached
 *
 * @param {GuildMember} member Member to watch
 * @param {Guild} guild Guild containing queue
 * @param {VoiceChannel} oldVoiceChannel Queue channel being left 
 */
async function checkAfterLeaving(member, guild, oldVoiceChannel) {
	// console.log(`[${guild.name}] | [${member.displayName}] set to leave [${oldVoiceChannel.name}] queue in ${grace_period} seconds`);
	const gracePeriod = (await channelDict.get(guild.id))[0];
	let timer = 0;
	// Check every 2 seconds
	while (timer < gracePeriod) {
		await sleep(2000);
		if (member.voice.channel === oldVoiceChannel) return;
		timer += 2;
	}

	await guildMemberLocks.get(guild.id).runExclusive(async () => {
		if (guildMemberDict[guild.id][oldVoiceChannel.id]) {
			guildMemberDict[guild.id][oldVoiceChannel.id].splice(guildMemberDict[guild.id][oldVoiceChannel.id].indexOf(member.id), 1); // User left channel, remove from queue
		}
	});
	// console.log(`[${guild.name}] | [${member.displayName}] left [${oldVoiceChannel.name}] queue`);
	updateDisplayQueue(guild, [oldVoiceChannel]);
}

/**
 * Get a channel from available channels
 * 
 * @param {any} availableChannels
 * @param {Object} parsed
 * @param {boolean} includeMention Include mention in error message
 * @param {string} type Type of channels to fetch ('voice' or 'text')
 * @param {Message} message
 */
async function findChannel(availableChannels, parsed, message, includeMention, type, errorOnNoneFound) {
	let channel = message.mentions.channels.values().next().value ||
		availableChannels.find(channel => channel.name === parsed.parameter) ||
		availableChannels.find(channel => channel.name.localeCompare(parsed.parameter, undefined, { sensitivity: 'accent' }) === 0);

	if (channel) return channel;

	if (errorOnNoneFound) {
		let response;
		if (availableChannels.length === 0) {
			response = 'No ' + (type ? `**${type}** ` : '') + 'queue channels set.'
				+ '\nSet a ' + (type ? `${type} ` : '') + `queue first using \`${prefix}${queue_cmd} {channel name}\``;
		}
		else {
			response = 'Invalid ' + (type ? `**${type}** ` : '') + `channel name! Try \`${parsed.prefix}${parsed.command} `;
			if (availableChannels.length === 1) {
				// Single channel, recommend the single channel
				response += availableChannels[0].name + (includeMention ? ' @{user}' : '') + '`.'
			}
			else {
				// Multiple channels, list them
				response += '{channel name}' + (includeMention ? ' @{user}' : '') + '`.'
					+ '\nAvailable ' + (type ? `**${type}** ` : '') + `channel names: ${availableChannels.map(channel => ' `' + channel.name + '`')}`
			}
        }
		send(message, response);
    }
}

/**
 * Get a channel using user argument
 *
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 * @param {boolean} includeMention Include mention in error message
 * @param {string} type Type of channels to fetch ('voice' or 'text')
 * @return {GuildChannel} Matched channel.
 */
async function fetchChannel(dbData, parsed, message, includeMention, type) {
	const channels = await fetchStoredChannels(dbData, message.guild);
	const prefix = parsed.prefix;
	const parameter = parsed.parameter;
	const guild = message.guild;

	if (guildMemberDict[guild.id] && channels.length > 0) {
		// Extract channel name from message
		let availableChannels = type ?
			channels.filter(channel => channel.type === type) :
			channels;

		if (availableChannels.length === 1 && parameter === "") {
			return availableChannels[0];
		}
		else {
			return await findChannel(availableChannels, parsed, message, includeMention, type, true)
				.catch(e => console.log('Error in fetchChannel: ' + e));
		}
	}
	else {
		send(message, `No queue channels set.`
			+ `\nSet a queue first using \`${prefix}${queue_cmd} {channel name}\``
		);
	}
}

/**
 * Add bot to a voice channel for swapping
 *
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function start(dbData, parsed, message) {
	const channel = await fetchChannel(dbData, parsed, message, false, 'voice')
		.catch(e => console.log('Error in start: ' + e));
	if (channel) {
		if (!channel.permissionsFor(message.guild.me).has('CONNECT')) {
			send(message, 'I need the permissions to join your voice channel!');
		}
		else if (channel.type === 'voice') {
			await channel.join()
				.catch(e => console.log('Error in start: ' + e))
				.then(connection => connection.voice.setSelfMute(true));
		}
		else {
			send(message, "I can only join voice channels.");
		}
    }
}

/**
 * Return a grace period in string form
 *
 * @param {number} guildId Guild id.
 * @return {string} Grace period string.
 */
const gracePeriodCache = new Map();
async function getGracePeriodString(gracePeriod) {
	if (!gracePeriodCache.has(gracePeriod)) {
		let result;
		if (gracePeriod === '0') {
			result = '';
		}
		else {
			const grace_minutes = Math.round(gracePeriod / 60);
			const grace_seconds = gracePeriod % 60;
			const time_string = (grace_minutes > 0 ? grace_minutes + ' minute' : '') + (grace_minutes > 1 ? 's' : '')
				+ (grace_minutes > 0 && grace_seconds > 0 ? ' and ' : '')
				+ (grace_seconds > 0 ? grace_seconds + ' second' : '') + (grace_seconds > 1 ? 's' : '');
			result = ` If you leave, you have ${time_string} to rejoin before being removed from the queue.`
		}
		gracePeriodCache.set(gracePeriod, result);
	}
	return gracePeriodCache.get(gracePeriod);
}

/**
 * Create an Embed to represent everyone in a singl queue. Will create multiple embeds for large queues
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {VoiceChannel} channel Discord message object.
 * @return {Embed[]} Array of display embeds
 */
async function generateEmbed(dbData, channel) {
	const prefix = dbData[1];
	const storedColor = dbData[2];
	let embedList;
	await guildMemberLocks.get(channel.guild.id).runExclusive(async () => {
		const memberIdQueue = guildMemberDict[channel.guild.id][channel.id];
		embedList = [{
			"embed": {
				"title": `${channel.name} queue`,
				"color": storedColor,
				"description":
					channel.type === 'voice' ?
						// Voice
						`Join the **${channel.name}** voice channel to join this queue.` + await getGracePeriodString(dbData[0]) :
						// Text
						`Type \`${prefix}${join_cmd} ${channel.name}\` to join or leave this queue.`,
				"fields": [{
					"name": `Current queue length: **${memberIdQueue ? memberIdQueue.length : 0}**`,
					"value": "\u200b"
				}]
			}
		}];
		// Handle empty queue
		if (!memberIdQueue || memberIdQueue.length === 0) {
			embedList[0]['embed']['fields'][0]['value'] = 'No members in queue.';
		}
		// Handle non-empty
		else {
			const maxEmbedSize = 25;
			let position = 0;					// 0 , 24, 49, 74
			let sliceStop = maxEmbedSize - 1;	// 24, 49, 74, 99 
			for (var i = 0; i <= memberIdQueue.length / maxEmbedSize; i++) {
				if (i > 0) { // Creating additional embed after the first embed
					embedList.push({
						"embed": {
							"color": storedColor,
							"fields": []
						}
					});
				}

				// Populate with names and numbers
				const fields = [];
				memberIdQueue.slice(position, sliceStop).map(memberId => {
					const member = channel.guild.members.cache.get(memberId);
					if (member) {
						fields.push({
							"name": ++position,
							"value": member.displayName
						});
					}
					// Clean up people who have left the server
					else {
						memberIdQueue.splice(memberIdQueue.indexOf(memberId), 1);
					}
				});
				embedList[i]['embed']['fields'].push(fields);

				sliceStop += maxEmbedSize;
			}
		}
	});
	return embedList;
}

/**
 * Create an embed message to display a channel's queue
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function displayQueue(dbData, parsed, message) {
	const guild = message.guild;
	const textChannel = message.channel;
	const channel = await fetchChannel(dbData, parsed, message, false)
		.catch(e => console.log('Error in displayQueue: ' + e));

	if (channel) {
		let embedList = await generateEmbed(dbData, channel);
		await displayEmbedLocks.get(guild.id).runExclusive(async () => {

			// Initialize display message queue
			displayEmbedDict[guild.id] = displayEmbedDict[guild.id] || [];
			displayEmbedDict[guild.id][channel.id] = displayEmbedDict[guild.id][channel.id] || [];

			// Remove old embed lists
			if (displayEmbedDict[guild.id] && displayEmbedDict[guild.id][channel.id]) {
				for (const [embedChannelId, embedIds] of Object.entries(displayEmbedDict[guild.id][channel.id])) {
					for (const embedId of embedIds) {
						const embed = guild.channels.cache.get(embedChannelId).messages.cache.get(embedId);
						if (embed) await embed.delete().catch();
					}
				}
			}

			// Create new display list
			displayEmbedDict[guild.id][channel.id][textChannel.id] = [];
			// Send message and store it
			embedList.forEach(queueEmbed =>
				send(message, queueEmbed).then(msg =>
					displayEmbedDict[guild.id][channel.id][textChannel.id].push(msg.id)
				)
			);
		});
	}
}

/**
 * Update a server's display messages
 *
 * @param {Guild} guild Guild containing display messages
 * @param {VoiceChannel[]} queues Channels to update
 */
async function updateDisplayQueue(guild, queues) {
	const currentChannelIds = guild.channels.cache.map(channel => channel.id);
	const dbData = await channelDict.get(guild.id);

	await displayEmbedLocks.get(guild.id).runExclusive(async () => {
		if (displayEmbedDict[guild.id]) {
			// For each updated queue
			for (const queue of queues) {
				if (queue && displayEmbedDict[guild.id][queue.id]) {
					// Create an embed list
					const embedList = await generateEmbed(dbData, queue);
					// For each embed list of the queue
					for (const textChannelId of Object.keys(displayEmbedDict[guild.id][queue.id])) {
						// Handled deleted queue channels
						if (currentChannelIds.includes(textChannelId)) {
							// Retrieved the stored embed list
							const storedEmbeds = Object.values(displayEmbedDict[guild.id][queue.id][textChannelId])
								.map(msgId => guild.channels.cache.get(textChannelId).messages.cache.get(msgId));

							let createNewEmbed = false;
							// If the new embed list and stored embed list are the same length, replace the old embeds via edit
							if (storedEmbeds.length === embedList.length) {
								for (var i = 0; i < embedList.length; i++) {
									if (storedEmbeds[i]) {
										await storedEmbeds[i].edit(embedList[i]).catch(
											() => createNewEmbed = true);
									}
									else {
										createNewEmbed = true;
                                    }
								}
							}
							// If the new embed list and stored embed list are diffent lengths, delete the old embeds and create all new messages
							if (storedEmbeds.length !== embedList.length || createNewEmbed) {
								let textChannel = guild.channels.cache.get(textChannelId);
								// Remove the old embed list
								for (const storedEmbed of Object.values(storedEmbeds)) {
									if (storedEmbed) await storedEmbed.delete().catch();
								}
								displayEmbedDict[guild.id][queue.id][textChannelId] = [];
								// Create a new embed list
								embedList.forEach(queueEmbed =>
									textChannel.send(queueEmbed).then(
										msg => displayEmbedDict[guild.id][queue.id][textChannelId].push(msg.id)
									)
								);
							}
						}
						else {
							// Remove stored displays of deleted queue channels
							delete displayEmbedDict[guild.id][queue.id];
						}
					}
				}
			}
		}
	});
}

/**
 * Toggle a channel's queue status. Display existing queues if no argument is provided.
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function setQueueChannel(dbData, parsed, message) {
	// Setup common variables
	const prefix = parsed.prefix;
	const parameter = parsed.parameter;
	const guild = message.guild;
	const channels = guild.channels.cache.filter(c => c.type !== 'category');
	// Get stored voice channel list from database
	const otherData = dbData.slice(0, 10);
	const storedChannels = await fetchStoredChannels(dbData, message.guild);

	// No argument. Display current queues
	if (parameter === "") {
		if (storedChannels.length > 0) {
			send(message, `Current queues: ${storedChannels.map(ch => ` \`${ch.name}\``)}`);
		}
		else {
			send(message, `No queue channels set.`
				+ `\nSet a new queue channel using \`${prefix}${queue_cmd} {channel name}\``
			//	+ `\nChannels: ${channels.map(channel => ` \`${channel.name}\``)}`
			);
		}
	}
	// Channel argument provided. Toggle it
	else {
		const channel = await findChannel(channels, parsed, message, false, null, true)
			.catch(e => console.log('Error in setQueueChannel: ' + e));
		if (channel) {
			guildMemberLocks.get(guild.id).runExclusive(async () => {
				// Initialize member queue
				guildMemberDict[guild.id] = guildMemberDict[guild.id] || [];
				// Toggle Queue
				if (storedChannels.includes(channel)) { // If it's in the list, remove it
					storedChannels.splice(storedChannels.indexOf(channel), 1);
					delete guildMemberDict[guild.id][channel.id];

					// Remove old embed lists
					await displayEmbedLocks.get(guild.id).runExclusive(async () => {
						if (displayEmbedDict[guild.id] && displayEmbedDict[guild.id][channel.id]) {
							for (const [embedChannelId, embedIds] of Object.entries(displayEmbedDict[guild.id][channel.id])) {
								const embedChannel = guild.channels.cache.get(embedChannelId);
								if (embedChannel) {
									for (const embedId of embedIds) {
										const embed = embedChannel.messages.cache.get(embedId);
										if (embed) await embed.delete().catch();
									}
								}
							}
						}
					});
					send(message, `Deleted queue for \`${channel.name}\`.`);
				}
				else { // If it's not in the list, add it
					storedChannels.push(channel);
					if (channel.type === 'voice') {
						guildMemberDict[guild.id][channel.id] = channel.members.filter(m => !m.user.bot).map(m => m.id);
					}
					send(message, `Created queue for \`${channel.name}\`.`);
				}
				// Store channel to database
				await channelDict.set(guild.id, otherData.concat(storedChannels.map(ch => ch.id)));
			});
		}
	}
}

/**
 * Add a member into a text queue
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function joinTextChannel(dbData, parsed, message, hasPermission) {
	const guild = message.guild;
	let membersToAdd;
	if (hasPermission) {
		parsed.parameter = parsed.parameter.replace(/<@!?\d+>/gi, '').trim(); // remove user mentions
	}
	membersToAdd = message.mentions.members.size > 0 ? message.mentions.members.values() : [message.member];

	const channel = await fetchChannel(dbData, parsed, message, message.mentions.members.size > 0, 'text')
		.catch(e => console.log('Error in joinTextChannel: ' + e));

	if (channel) {
		await guildMemberLocks.get(guild.id).runExclusive(async () => {
			// Initialize member queue
			guildMemberDict[guild.id][channel.id] = guildMemberDict[guild.id][channel.id] || [];
			for (const member of membersToAdd) {
				if (guildMemberDict[guild.id][channel.id].includes(member.id)) {
					// Remove from queue
					guildMemberDict[guild.id][channel.id].splice(guildMemberDict[guild.id][channel.id].indexOf(member.id), 1);
					send(message, `Removed \`${member.displayName}\` from the \`${channel.name}\` queue.`)
				}
				else {
					// Add to queue
					guildMemberDict[guild.id][channel.id].push(member.id);
					send(message, `Added \`${member.displayName}\` to the \`${channel.name}\` queue.`)
				}
            }
		});
		updateDisplayQueue(guild, [channel]);
	}
}

/**
 * Pop a member from a text channel queue
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function popTextQueue(dbData, parsed, message) {
	const guild = message.guild;
	const channel = await fetchChannel(dbData, parsed, message, false, 'text')
		.catch(e => console.log('Error in popTextQueue: ' + e));
	if (channel) {
		if (channel.type === 'text' && guildMemberDict[guild.id][channel.id] &&
				guildMemberDict[guild.id][channel.id].length > 0) {
			let nextMemberId;
			await guildMemberLocks.get(guild.id).runExclusive(async () => {
				nextMemberId = guildMemberDict[guild.id][channel.id].shift();
			});
			send(message, `Pulling next user (<@!${nextMemberId}>) from \`${channel.name}\`.`);
			updateDisplayQueue(guild, [channel]);
		}
		else if (channel.type !== 'text') {
			send(message, `\`${parsed.prefix}${next_cmd}\` can only be used on text channel queues.`);
		}
		else if (guildMemberDict[guild.id][channel.id] &&
			guildMemberDict[guild.id][channel.id].length === 0) {
			send(message, `\`${channel.name}\` is empty.`);
		}
	}
}

/**
 * Kick a member from a queue
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function kickMember(dbData, parsed, message) {
	const guild = message.guild;
	parsed.parameter = parsed.parameter.replace(/<@!?\d+>/gi, '').trim(); // remove user mentions
	const channel = await fetchChannel(dbData, parsed, message, true)
		.catch(e => console.log('Error in kickMember: ' + e));
	const mentionedMembers = message.mentions.members.values();

	if (channel) {
		if (mentionedMembers && guildMemberDict[guild.id][channel.id].length > 0) {
			const kickedMemberIds = [];
			const unfoundMemberIds = [];
			await guildMemberLocks.get(guild.id).runExclusive(async () => {
				for (member of mentionedMembers) {
					if (guildMemberDict[guild.id][channel.id].includes(member.id)) {
						guildMemberDict[guild.id][channel.id].splice(guildMemberDict[guild.id][channel.id].indexOf(member.id), 1);
						kickedMemberIds.push(member.id);
					} else {
						unfoundMemberIds.push(member.id);
					}
				}
			});
			// Output result of kick
			send(message, 
				((kickedMemberIds.length > 0) ? 'Kicked' + kickedMemberIds.map(m => ` <@!${m}>`) + ` from \`${channel.name}\` queue.` : '')
				+ ((unfoundMemberIds.length > 0) ? '\nDid not find' + unfoundMemberIds.map(m => ` <@!${m}>`) + ` in \`${channel.name}\` queue.` : ''));
			updateDisplayQueue(guild, [channel]);

		} else if (guildMemberDict[guild.id][channel.id].length === 0) {
			send(message, `\`${channel.name}\` is empty.`);
		}
		else if (!mentionedMembers) {
			send(message, `Specify at least one user to kick. For example:`
				+ `\n\`${parsed.prefix}${kick_cmd} General @Arrow\``);
		}
	}
}

/**
 * Pop a member from a text channel queue
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function clearQueue(dbData, parsed, message) {
	const guild = message.guild;
	const channel = await fetchChannel(dbData, parsed, message, false)
		.catch(e => console.log('Error in clearQueue: ' + e));
	if (channel) {
		await guildMemberLocks.get(guild.id).runExclusive(async () => {
			guildMemberDict[guild.id][channel.id] = [];
		});
		send(message, `\`${channel.name}> queue cleared.`);
	}
}

/**
 * Send message sender a help embed
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 */
async function help(dbData, parsed, message) {
	const storedPrefix = parsed.prefix;
	const storedColor = dbData[2];

	const embeds = [
        {
            "embed": {
                "title": "Non-Restricted Commands",
                "color": storedColor,
                "author": {
                    "name": "Queue Bot",
                    "url": "https://top.gg/bot/679018301543677959",
                    "icon_url": "https://raw.githubusercontent.com/ArrowM/Queue-Bot/master/docs/icon.png"
                },
                "fields": [
                    {
                        "name": "Access",
                        "value": "Available to everyone."
                    },
                    {
                        "name": "Join a Text Channel Queue",
                        "value": `\`${storedPrefix}${join_cmd} {channel name}\` joins or leaves a text channel queue.`
					}
                ]
            }
		},
        {
            "embed": {
                "title": "Restricted Commands",
				"color": storedColor,
				"image": {
					"url": "https://raw.githubusercontent.com/ArrowM/Queue-Bot/master/docs/example.gif"
				},
				"fields": [
                    {
						"name": "Access",
						"value": "Available to owners or users with `mod` or `mods` in their server roles."
                    },
                    {
						"name": "Modify & View Queues",
						"value": `\`${storedPrefix}${queue_cmd} {channel name}\` creates a new queue or deletes an existing queue.`
							+ `\n\`${storedPrefix}${queue_cmd}\` shows the existing queues.`
                    },
                    {
                        "name": "Display Queue Members",
                        "value": `\`${storedPrefix}${display_cmd} {channel name}\` displays the members in a queue. These messages stay updated.`
                    },
                    {
                        "name": "Pull Users from Voice Queue",
                        "value": `\`${storedPrefix}${start_cmd} {channel name}\` adds the bot to a queue voice channel.`
                            + ` The bot can be pulled into a non-queue channel to automatically swap with person at the front of the queue.`
                            + ` Right-click the bot to disconnect it from the voice channel when done. See the example gif below.`
                    },
                    {
                        "name": "Pull Users from Text Queue",
                        "value": `\`${storedPrefix}${next_cmd} {channel name}\` removes the next person in the text queue and displays their name.`
                    },
                    {
                        "name": "Add Others to a Text Channel Queue",
                        "value": `\`${storedPrefix}${join_cmd} {channel name} @{user 1} @{user 2} ...\` adds other people from text channel queue.`
                    },
                    {
                        "name": "Kick Users from Queue",
                        "value": `\`${storedPrefix}${kick_cmd} {channel name} @{user 1} @{user 2} ...\` kicks one or more people from a queue.`
                    },
                    {
                        "name": "Clear Queue",
                        "value": `\`${storedPrefix}${clear_cmd} {channel name}\` clears a queue.`
                    },
                    {
                        "name": "Change the Grace Period",
                        "value": `\`${storedPrefix}${grace_period_cmd} {time in seconds}\` changes how long a person can leave a queue before being removed.`
                    },
                    {
                        "name": "Change the Command Prefix",
                        "value": `\`${storedPrefix}${command_prefix_cmd} {new prefix}\` changes the prefix for commands.`
                    },
                    {
                        "name": "Change the Color",
                        "value": `\`${storedPrefix}${color_cmd} {new color}\` changes the color of bot messages.`
                    }
                ]
            }
        }
	];

	const channel = await findChannel(message.guild.channels.cache, parsed, message, false, 'text', false);
	if (parsed.parameter && channel) {
		if (channel.permissionsFor(message.guild.me).has('SEND_MESSAGES') && channel.permissionsFor(message.guild.me).has('EMBED_LINKS')) {
			// Channel found and bot has permission, print.
			embeds.forEach(em => channel.send(em)
				.catch(e => console.log(e)));
		} else {
			// Channel found, but no permission. Send permission and help messages to user.
			message.author.send(`I don't have permission to write messages and embeds in \`${channel.name}\``);
			embeds.forEach(em => message.author.send(em)
				.catch(e => console.log(e)));
		}
	} else {
		// No channel provided. send help to user.
		embeds.map(em => {
			message.author.send(em)
				.catch(e => console.log(e))
		});

		send(message, "I have sent help to your PMs.");
	}
}

/**
 * Change a server setting
 *
 * @param {Object[]} dbData Array of server settings stored in DB.
 * @param {Object} parsed Parsed message - prefix, command, argument.
 * @param {Message} message Discord message object.
 * @param {boolean} updateDisplayMsgs Whether to update existing display messages.
 * @param {function} valueRestrictions Test to determine whether the user input is valid.
 * @param {string} extraErrorLine Extra hint to display if the user gives invalid input.
 * @param {MessageEmbed} embed Embed to display with extra error line.
 */
async function setServerSettings(dbData, parsed, message, updateDisplayMsgs, valueRestrictions, extraErrorLine, embed) {
	// Setup common variables
	const setting = ServerSettings[parsed.command];
	const guild = message.guild;
	const otherData = dbData.slice(0, 10);
	const channels = await fetchStoredChannels(dbData, guild);
	
	if (parsed.parameter && valueRestrictions(parsed.parameter)) {
		otherData[setting.index] = parsed.parameter;
		// Store channel to database
		await channelDict.set(guild.id, otherData.concat(channels.map(ch => ch.id)));
		if (updateDisplayMsgs) updateDisplayQueue(guild, channels);
		send(message, `Set ${setting.str} to \`${parsed.parameter}\`.`);
	}
	else {
		send(message, {
			"embed": embed,
			"content":
				`The ${setting.str} is currently set to \`${dbData[setting.index]}\`.\n`
				+ `Set a new ${setting.str} using \`${parsed.prefix}${parsed.command} {${setting.str}}\`.\n`
				+ extraErrorLine
		});
	}
}

/**
 * Determine whether user has permission to interact with bot
 *
 * @param {Message} message Discord message object.
 */
async function checkPermission(message) {
	const regex = RegExp(permissions_regexp, 'i');
	return message.member.roles.cache.some(role => regex.test(role.name)) || message.member.id === message.guild.ownerID;
}

client.on('message', async message => {
	if (message.author.bot) return;
	// Lock
	if (!channelLocks.get(message.guild.id)) await setupLocks(message.guild.id);
	await channelLocks.get(message.guild.id).runExclusive(async () => {

		// Get server settings
		let dbData = await channelDict.get(message.guild.id);
		if (!dbData) {
			// Set defaults for new servers
			dbData = defaultDBData;
			await channelDict.set(message.guild.id, dbData);
		}
		const parsed = {
			"prefix": dbData[1]
		};
		if (message.content.startsWith(parsed.prefix)) {
			// Parse the message
			// Note: Prefix can contain spaces. Command can not contains spaces. Parameter can contain spaces.
			parsed.command = message.content.substring(parsed.prefix.length).split(" ")[0];
			parsed.parameter = message.content.substring(parsed.prefix.length + parsed.command.length + 1);
			const hasPermission = await checkPermission(message);
			// Restricted commands
			if (hasPermission) {
				switch (parsed.command) {
					// Start
					case start_cmd:
						start(dbData, parsed, message);
						break;
					// Display
					case display_cmd:
						displayQueue(dbData, parsed, message);
						break;
					// Set Queue
					case queue_cmd:
						await setQueueChannel(dbData, parsed, message);
						break;
					// Pop next user
					case next_cmd:
						popTextQueue(dbData, parsed, message);
						break;
					// Pop next user
					case kick_cmd:
						kickMember(dbData, parsed, message);
						break;
					// Clear queue
					case clear_cmd:
						clearQueue(dbData, parsed, message);
						break;

					// Grace period
					case grace_period_cmd:
						await setServerSettings(dbData, parsed, message,
							true,
							function (time) { return time >= 0 && time <= 300 },
							'Grace period must be between `0` and `300` seconds.',
							null
						);
						break;
					// Command Prefix
					case command_prefix_cmd:
						await setServerSettings(dbData, parsed, message,
							false,
							function () { return true },
							'',
							null
						);
						break;
					// Color
					case color_cmd:
						await setServerSettings(dbData, parsed, message,
							true,
							function (color) { return /^#[0-9A-F]{6}$/i.test(color) },
							'Use HEX color:',
							{ "title": "Hex color picker", "url": "https://htmlcolorcodes.com/color-picker/", "color": dbData[2] }
						);
						break;
				}
			}
			else if ([start_cmd, display_cmd, queue_cmd, next_cmd, kick_cmd, clear_cmd, grace_period_cmd, command_prefix_cmd, color_cmd].includes(parsed.command)) {
				message.author.send(`You don't have permission to use bot commands in \`${message.guild.name}\`. You must be assigned a \`mod\` or \`admin\` role on the server to use bot commands.`);
            }
			// Commands open to everyone
			switch (parsed.command) {
				// Help
				case help_cmd:
					help(dbData, parsed, message);
					break;
				// Join Text Queue
				case join_cmd:
					await joinTextChannel(dbData, parsed, message, hasPermission);
					break;
			}
		}
		// Default help command
		else if (message.content === prefix + help_cmd) {
			help(dbData, parsed, message);
		}
	});
});