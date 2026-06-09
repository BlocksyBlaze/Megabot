import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import { createEmbed, errorEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { getOAuthAuthorizeUrl, getOAuthJoinSetupStatus } from '../../services/oauthJoinService.js';
import { updateGuildConfig } from '../../services/guildConfig.js';

export default {
  data: new SlashCommandBuilder()
    .setName('set-verify')
    .setDescription('Post the verification button panel in the current channel.')
    .addRoleOption(option =>
      option
        .setName('give_role')
        .setDescription('Role to give when verified successfully (leave empty/NA for none)')
        .setRequired(false)
    )
    .addRoleOption(option =>
      option
        .setName('remove_role')
        .setDescription('Role to remove when verified successfully (leave empty/NA for none)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  category: 'OAuth',
  abuseProtection: {
    enabled: true,
    maxAttempts: 2,
    windowMs: 60_000
  },

  async execute(interaction, _config, client) {
    try {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return await InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('You need the Manage Server permission to use this command.')],
          flags: MessageFlags.Ephemeral
        });
      }

      const setupStatus = getOAuthJoinSetupStatus(client);
      if (!setupStatus.configured) {
        return await InteractionHelper.safeReply(interaction, {
          embeds: [
            errorEmbed(
              `Verify is not configured. Missing: ${setupStatus.missing.join(', ')}`
            )
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const botMember = interaction.guild.members.me;
      if (!botMember) {
        return await InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('Failed to retrieve bot member information.')],
          flags: MessageFlags.Ephemeral
        });
      }

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return await InteractionHelper.safeReply(interaction, {
          embeds: [errorEmbed('I need the **Manage Roles** permission to assign or remove roles.')],
          flags: MessageFlags.Ephemeral
        });
      }

      const giveRole = interaction.options.getRole('give_role');
      const removeRole = interaction.options.getRole('remove_role');
      const botRole = botMember.roles.highest;

      if (giveRole) {
        if (giveRole.id === interaction.guildId || giveRole.managed) {
          return await InteractionHelper.safeReply(interaction, {
            embeds: [errorEmbed('Please choose a normal assignable role to give (not @everyone or managed roles).')],
            flags: MessageFlags.Ephemeral
          });
        }
        if (giveRole.position >= botRole.position) {
          return await InteractionHelper.safeReply(interaction, {
            embeds: [errorEmbed(`The role to give (**${giveRole.name}**) must be below my highest role in the role hierarchy.`)],
            flags: MessageFlags.Ephemeral
          });
        }
      }

      if (removeRole) {
        if (removeRole.id === interaction.guildId || removeRole.managed) {
          return await InteractionHelper.safeReply(interaction, {
            embeds: [errorEmbed('Please choose a normal assignable role to remove (not @everyone or managed roles).')],
            flags: MessageFlags.Ephemeral
          });
        }
        if (removeRole.position >= botRole.position) {
          return await InteractionHelper.safeReply(interaction, {
            embeds: [errorEmbed(`The role to remove (**${removeRole.name}**) must be below my highest role in the role hierarchy.`)],
            flags: MessageFlags.Ephemeral
          });
        }
      }

      // Save role configurations in the guild config
      await updateGuildConfig(client, interaction.guildId, {
        oauthVerifyRoleToGive: giveRole?.id || null,
        oauthVerifyRoleToRemove: removeRole?.id || null
      });

      const baseAuthorizeUrl = getOAuthAuthorizeUrl(client);
      let authorizeUrl = baseAuthorizeUrl;
      try {
        const parsedUrl = new URL(baseAuthorizeUrl);
        parsedUrl.searchParams.set('state', interaction.guildId);
        authorizeUrl = parsedUrl.toString();
      } catch (err) {
        logger.warn('Failed to parse base authorize URL as a valid URL, appending state manually:', err);
        authorizeUrl = baseAuthorizeUrl.includes('?')
          ? `${baseAuthorizeUrl}&state=${interaction.guildId}`
          : `${baseAuthorizeUrl}?state=${interaction.guildId}`;
      }

      const allowButton = new ButtonBuilder()
        .setLabel('✅ Verify')
        .setStyle(ButtonStyle.Link)
        .setURL(authorizeUrl);

      const row = new ActionRowBuilder().addComponents(allowButton);
      const embed = createEmbed({
        description: '# Welcome to the server 👋\nTo gain access, please verify by clicking the button below.',
        color: 'primary'
      });

      return await InteractionHelper.safeReply(interaction, {
        embeds: [embed],
        components: [row]
      });
    } catch (error) {
      logger.error('Joinset command error:', error);
      return await InteractionHelper.safeReply(interaction, {
        embeds: [errorEmbed('Could not create the authorization panel.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
