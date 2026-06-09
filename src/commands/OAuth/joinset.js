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

export default {
  data: new SlashCommandBuilder()
    .setName('joinset')
    .setDescription('Post the OAuth authorization button for member joins')
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
              `OAuth join is not configured. Missing: ${setupStatus.missing.join(', ')}`
            )
          ],
          flags: MessageFlags.Ephemeral
        });
      }

      const allowButton = new ButtonBuilder()
        .setLabel('Allow')
        .setStyle(ButtonStyle.Link)
        .setURL(getOAuthAuthorizeUrl(client));

      const row = new ActionRowBuilder().addComponents(allowButton);
      const embed = createEmbed({
        description: 'Would you like to allow bot to join servers for you?',
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
