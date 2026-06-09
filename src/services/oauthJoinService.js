import axios from 'axios';
import { logger } from '../utils/logger.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const AUTHORIZATION_KEY_PREFIX = 'cache:oauth:guildjoin:user:';
const DEFAULT_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize?client_id=1092614431453757520&redirect_uri=https%3A%2F%2Fmegabot-production-9ad7.up.railway.app%2Fcallback&response_type=code&scope=identify%20guilds.join';
const DEFAULT_REDIRECT_URI = 'https://megabot-production-9ad7.up.railway.app/callback';
const DEFAULT_CLIENT_ID = '1092614431453757520';
const REQUIRED_SCOPES = new Set(['identify', 'guilds.join']);

function toPositiveInteger(value, fallback) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    return fallback;
  }
  return normalized;
}

function authorizationKey(userId) {
  return `${AUTHORIZATION_KEY_PREFIX}${userId}`;
}

function getOAuthJoinConfig(client) {
  const oauthJoin = client?.config?.bot?.oauthJoin || {};

  return {
    clientId: oauthJoin.clientId || client?.config?.bot?.clientId || process.env.CLIENT_ID || DEFAULT_CLIENT_ID,
    clientSecret:
      oauthJoin.clientSecret ||
      process.env.OAUTH_CLIENT_SECRET ||
      process.env.DISCORD_CLIENT_SECRET ||
      process.env.CLIENT_SECRET ||
      null,
    redirectUri: oauthJoin.redirectUri || process.env.OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI,
    authorizeUrl: oauthJoin.authorizeUrl || process.env.OAUTH_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL,
    maxJoinAmount: toPositiveInteger(oauthJoin.maxJoinAmount || process.env.OAUTH_JOIN_MAX_MEMBERS, 100),
    requestDelayMs: toPositiveInteger(oauthJoin.requestDelayMs || process.env.OAUTH_JOIN_REQUEST_DELAY_MS, 250),
    tokenRefreshSkewMs: toPositiveInteger(
      oauthJoin.tokenRefreshSkewMs || process.env.OAUTH_TOKEN_REFRESH_SKEW_MS,
      60_000
    )
  };
}

export function getOAuthAuthorizeUrl(client) {
  return getOAuthJoinConfig(client).authorizeUrl;
}

export function getOAuthJoinSetupStatus(client) {
  const config = getOAuthJoinConfig(client);
  const missing = [];

  if (!config.clientId) missing.push('CLIENT_ID');
  if (!config.clientSecret) missing.push('OAUTH_CLIENT_SECRET or CLIENT_SECRET');
  if (!config.redirectUri) missing.push('OAUTH_REDIRECT_URI');

  return {
    configured: missing.length === 0,
    missing,
    config
  };
}

function parseScopes(scopeText = '') {
  return new Set(String(scopeText).split(/\s+/).filter(Boolean));
}

function hasRequiredScopes(scopeText) {
  const scopes = parseScopes(scopeText);
  return Array.from(REQUIRED_SCOPES).every(scope => scopes.has(scope));
}

function buildTokenBody(client, fields) {
  const { config } = getOAuthJoinSetupStatus(client);
  return new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...fields
  });
}

function getDiscordErrorMessage(response, fallback = 'Discord API request failed') {
  const data = response?.data;
  if (data?.message) {
    return data.code ? `${data.message} (${data.code})` : data.message;
  }

  if (typeof data === 'string' && data.length > 0) {
    return data;
  }

  return fallback;
}

function toServiceError(message, status = 500, code = 'OAUTH_JOIN_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function requestOAuthToken(client, fields) {
  const setupStatus = getOAuthJoinSetupStatus(client);
  if (!setupStatus.configured) {
    throw toServiceError(
      `OAuth join is not configured. Missing: ${setupStatus.missing.join(', ')}`,
      500,
      'OAUTH_JOIN_NOT_CONFIGURED'
    );
  }

  const response = await axios.post(
    DISCORD_TOKEN_URL,
    buildTokenBody(client, fields),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
      validateStatus: () => true
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw toServiceError(
      getDiscordErrorMessage(response, 'Failed to exchange OAuth token with Discord.'),
      response.status,
      'OAUTH_TOKEN_REQUEST_FAILED'
    );
  }

  return response.data;
}

async function fetchOAuthUser(accessToken) {
  const response = await axios.get(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15_000,
    validateStatus: () => true
  });

  if (response.status < 200 || response.status >= 300) {
    throw toServiceError(
      getDiscordErrorMessage(response, 'Failed to fetch authorized Discord user.'),
      response.status,
      'OAUTH_USER_FETCH_FAILED'
    );
  }

  return response.data;
}

function buildAuthorizationRecord(user, tokenData, existing = {}) {
  const now = Date.now();
  const expiresInSeconds = toPositiveInteger(tokenData.expires_in, 604_800);
  const expiresAt = new Date(now + expiresInSeconds * 1000).toISOString();

  return {
    userId: String(user.id || existing.userId),
    username: user.username || existing.username || null,
    globalName: user.global_name || existing.globalName || null,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || existing.refreshToken || null,
    tokenType: tokenData.token_type || existing.tokenType || 'Bearer',
    scope: tokenData.scope || existing.scope || 'identify guilds.join',
    expiresAt,
    authorizedAt: existing.authorizedAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString()
  };
}

async function saveAuthorizationRecord(client, record) {
  if (!client?.db || typeof client.db.set !== 'function') {
    throw toServiceError('Database is not available for OAuth authorization storage.', 500, 'DATABASE_UNAVAILABLE');
  }

  await client.db.set(authorizationKey(record.userId), record);
  return record;
}

export async function getOAuthAuthorization(client, userId) {
  if (!client?.db || typeof client.db.get !== 'function') {
    return null;
  }

  const record = await client.db.get(authorizationKey(userId), null);
  if (!record || typeof record !== 'object' || !record.userId || !record.accessToken) {
    return null;
  }

  return record;
}

export async function deleteOAuthAuthorization(client, userId) {
  if (!client?.db || typeof client.db.delete !== 'function') {
    return false;
  }

  await client.db.delete(authorizationKey(userId));
  return true;
}

export async function listOAuthAuthorizations(client) {
  if (!client?.db || typeof client.db.list !== 'function') {
    return [];
  }

  const keys = await client.db.list(AUTHORIZATION_KEY_PREFIX);
  const records = [];

  for (const key of keys) {
    const record = await client.db.get(key, null);
    if (record && typeof record === 'object' && record.userId && record.accessToken) {
      records.push(record);
    }
  }

  return records;
}

export async function handleOAuthCallback(client, query = {}) {
  const errorCode = query.error ? String(query.error) : null;
  if (errorCode) {
    return {
      ok: false,
      status: 400,
      title: 'Verification Cancelled',
      message: String(query.error_description || errorCode)
    };
  }

  const code = query.code ? String(query.code) : null;
  if (!code) {
    return {
      ok: false,
      status: 400,
      title: 'Missing Verification Code',
      message: 'Discord did not send an OAuth Verification code.'
    };
  }

  const setupStatus = getOAuthJoinSetupStatus(client);
  if (!setupStatus.configured) {
    return {
      ok: false,
      status: 500,
      title: 'Verify Not Configured',
      message: `Missing environment value: ${setupStatus.missing.join(', ')}`
    };
  }

  try {
    const tokenData = await requestOAuthToken(client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: setupStatus.config.redirectUri
    });

    if (!hasRequiredScopes(tokenData.scope)) {
      return {
        ok: false,
        status: 403,
        title: 'Missing Permission',
        message: 'Verification must include identify and guilds.join scopes.'
      };
    }

    const user = await fetchOAuthUser(tokenData.access_token);
    const record = buildAuthorizationRecord(user, tokenData);
    await saveAuthorizationRecord(client, record);

    logger.info('Stored OAuth guild join authorization', {
      event: 'oauth.guild_join.authorized',
      userId: record.userId,
      username: record.username
    });

    return {
      ok: true,
      status: 200,
      title: 'Verification Complete',
      message: 'You are now verified.',
      user: {
        id: record.userId,
        username: record.username,
        globalName: record.globalName
      }
    };
  } catch (error) {
    logger.error('OAuth callback failed:', {
      event: 'oauth.guild_join.callback_failed',
      status: error.status,
      code: error.code,
      message: error.message
    });

    return {
      ok: false,
      status: error.status || 500,
      title: 'Verification Failed',
      message: error.message || 'Discord verification failed.'
    };
  }
}

async function refreshOAuthAuthorization(client, authorization) {
  if (!authorization?.refreshToken) {
    throw toServiceError('Stored authorization cannot be refreshed.', 401, 'OAUTH_REFRESH_TOKEN_MISSING');
  }

  try {
    const tokenData = await requestOAuthToken(client, {
      grant_type: 'refresh_token',
      refresh_token: authorization.refreshToken
    });

    const updated = buildAuthorizationRecord(
      {
        id: authorization.userId,
        username: authorization.username,
        global_name: authorization.globalName
      },
      tokenData,
      authorization
    );

    return await saveAuthorizationRecord(client, updated);
  } catch (error) {
    if (error.status === 400 || error.status === 401) {
      await deleteOAuthAuthorization(client, authorization.userId).catch(() => {});
    }
    throw error;
  }
}

async function ensureFreshAuthorization(client, authorization) {
  const { config } = getOAuthJoinSetupStatus(client);
  const expiresAtMs = Date.parse(authorization.expiresAt || 0);

  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > config.tokenRefreshSkewMs) {
    return authorization;
  }

  return await refreshOAuthAuthorization(client, authorization);
}

async function addAuthorizedMemberToGuild(client, guildId, authorization, retryOnUnauthorized = true) {
  const freshAuthorization = await ensureFreshAuthorization(client, authorization);

  const response = await axios.put(
    `${DISCORD_API_BASE}/guilds/${guildId}/members/${freshAuthorization.userId}`,
    { access_token: freshAuthorization.accessToken },
    {
      headers: {
        Authorization: `Bot ${client.config.bot.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15_000,
      validateStatus: () => true
    }
  );

  if (response.status === 201) {
    return { joined: true, alreadyMember: false, status: response.status };
  }

  if (response.status === 204) {
    return { joined: false, alreadyMember: true, status: response.status };
  }

  if (response.status === 401 && retryOnUnauthorized) {
    const refreshedAuthorization = await refreshOAuthAuthorization(client, freshAuthorization);
    return addAuthorizedMemberToGuild(client, guildId, refreshedAuthorization, false);
  }

  throw toServiceError(
    getDiscordErrorMessage(response, 'Failed to add authorized member to guild.'),
    response.status,
    'GUILD_MEMBER_JOIN_FAILED'
  );
}

function summarizeFailure(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error.status) {
    return `${error.message || 'Discord API request failed'} [${error.status}]`;
  }

  return error.message || 'Unknown error';
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function joinAuthorizedMembers(client, guildId, amount) {
  const { config } = getOAuthJoinSetupStatus(client);
  const requestedAmount = Math.min(toPositiveInteger(amount, 1), config.maxJoinAmount);
  const authorizations = await listOAuthAuthorizations(client);
  const guild = await client.guilds.fetch(guildId);

  const results = {
    requested: requestedAmount,
    authorizedAvailable: authorizations.length,
    attempted: 0,
    joined: [],
    alreadyMember: [],
    failed: []
  };

  for (const authorization of authorizations) {
    if (results.joined.length >= requestedAmount) {
      break;
    }

    const member = await guild.members.fetch(authorization.userId).catch(() => null);
    if (member) {
      results.alreadyMember.push({
        userId: authorization.userId,
        username: authorization.username || authorization.userId
      });
      continue;
    }

    try {
      results.attempted += 1;
      const joinResult = await addAuthorizedMemberToGuild(client, guild.id, authorization);

      if (joinResult.joined) {
        results.joined.push({
          userId: authorization.userId,
          username: authorization.username || authorization.userId
        });
      } else if (joinResult.alreadyMember) {
        results.alreadyMember.push({
          userId: authorization.userId,
          username: authorization.username || authorization.userId
        });
      }
    } catch (error) {
      logger.warn('Failed to add authorized member to guild', {
        event: 'oauth.guild_join.member_failed',
        guildId: guild.id,
        userId: authorization.userId,
        status: error.status,
        code: error.code,
        message: error.message
      });

      results.failed.push({
        userId: authorization.userId,
        username: authorization.username || authorization.userId,
        reason: summarizeFailure(error)
      });
    }

    if (results.joined.length < requestedAmount && config.requestDelayMs > 0) {
      await wait(config.requestDelayMs);
    }
  }

  return results;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatOAuthCallbackHtml(result) {
  const title = escapeHtml(result?.title || 'OAuth Result');
  const message = escapeHtml(result?.message || '');
  const color = result?.ok ? '#2f855a' : '#c53030';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { max-width: 560px; padding: 32px; text-align: center; }
    h1 { color: ${color}; margin-bottom: 12px; }
    p { line-height: 1.5; color: #d1d5db; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}
