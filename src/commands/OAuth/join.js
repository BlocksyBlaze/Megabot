import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createEmbed, errorEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { getOAuthJoinSetupStatus, joinAuthorizedMembers } from '../../services/oauthJoinService.js';

function getConfiguredOwnerIds(client) {
  return (client?.config?.bot?.commands?.owners || [])
    .map(ownerId => String(ownerId).trim())
    .filter(Boolean);
}

async function getApplicationOwnerIds(client) {
  if (client._oauthJoinApplicationOwnerIds) {
    return client._oauthJoinApplicationOwnerIds;
  }

  const ownerIds = new Set();
  const application = await client.application.fetch().catch(() => null);
  const owner = application?.owner;

  if (owner?.id) {
    ownerIds.add(owner.id);
  }

  if (owner?.members) {
    for (const [memberId] of owner.members) {
      ownerIds.add(memberId);
    }
  }

  client._oauthJoinApplicationOwnerIds = ownerIds;
  return ownerIds;
}

async function isJoinOperator(interaction, client) {
  const configuredOwnerIds = getConfiguredOwnerIds(client);
  if (configuredOwnerIds.length > 0) {
    return configuredOwnerIds.includes(interaction.user.id);
  }

  const applicationOwnerIds = await getApplicationOwnerIds(client);
  return applicationOwnerIds.has(interaction.user.id);
}

function formatUserList(users, limit = 5) {
  if (!Array.isArray(users) || users.length === 0) {
    return 'None';
  }

  const visible = users
    .slice(0, limit)
    .map(user => `${user.username || user.userId} (${user.userId})`);
  const remaining = users.length - visible.length;

  return remaining > 0 ? `${visible.join('\n')}\n+${remaining} more` : visible.join('\n');
}

export default {
  data: new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Search for server by ID')
    .addStringOption(option =>
      option
        .setName('server_id')
        .setDescription('Server ID to search for')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('amount_of_members')
        .setDescription('Number of members to look up')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
    .setDMPermission(false),
  category: 'OAuth',
  abuseProtection: {
    enabled: true,
    maxAttempts: 1,
    windowMs: 60_000
  },

  async execute(interaction, _guildConfig, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral
    });
    if (!deferSuccess) {
      return;
    }

    try {
      if (!(await isJoinOperator(interaction, client))) {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            errorEmbed(
              'Only the bot owner can use this command. Set OWNER_IDS to your Discord user ID if needed.'
            )
          ]
        });
      }

      const setupStatus = getOAuthJoinSetupStatus(client);
      if (!setupStatus.configured) {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            errorEmbed(
              `OAuth join is not configured. Missing: ${setupStatus.missing.join(', ')}`
            )
          ]
        });
      }

      const serverId = interaction.options.getString('server_id', true).trim();
      const amount = interaction.options.getInteger('amount_of_members', true);

      if (!/^\d{17,20}$/.test(serverId)) {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [errorEmbed('Please provide a valid Discord server ID.')]
        });
      }

      const targetGuild = await client.guilds.fetch(serverId).catch(() => null);
      if (!targetGuild) {
        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [errorEmbed('I am not in that server, or I cannot access it.')]
        });
      }

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          createEmbed({
            title: 'Joining Members',
            description: `Adding up to **${amount}** authorized member(s) to **${targetGuild.name}**...`,
            color: 'info'
          })
        ]
      });

      const results = await joinAuthorizedMembers(client, targetGuild.id, amount);
      const failedSummary = results.failed
        .slice(0, 5)
        .map(item => `${item.username || item.userId} (${item.userId}): ${item.reason}`)
        .join('\n') || 'None';

      const embed = createEmbed({
        title: 'Join Complete',
        description: `Finished join request for **${targetGuild.name}**.`,
        color: results.joined.length > 0 ? 'success' : 'warning',
        fields: [
          { name: 'Requested', value: String(results.requested), inline: true },
          { name: 'Authorized Available', value: String(results.authorizedAvailable), inline: true },
          { name: 'API Attempts', value: String(results.attempted), inline: true },
          { name: 'Joined', value: String(results.joined.length), inline: true },
          { name: 'Already In Server', value: String(results.alreadyMember.length), inline: true },
          { name: 'Failed', value: String(results.failed.length), inline: true },
          { name: 'Joined Users', value: formatUserList(results.joined), inline: false },
          { name: 'Failed Users', value: failedSummary.substring(0, 1024), inline: false }
        ]
      });

      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed]
      });
    } catch (error) {
      logger.error('Join command error:', {
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        message: error.message,
        status: error.status,
        code: error.code
      });

      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [errorEmbed(`Could not complete join request: ${error.message || 'Unknown error'}`)]
      });
    }
  }
};
