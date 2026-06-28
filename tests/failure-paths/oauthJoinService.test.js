import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findOAuthAuthorizations,
  formatOAuthCallbackHtml,
  getOAuthAuthorizeUrl,
  getOAuthJoinSetupStatus,
  listOAuthAuthorizations
} from '../../src/services/oauthJoinService.js';

function withoutOAuthEnv(callback) {
  const keys = [
    'CLIENT_ID',
    'OAUTH_CLIENT_SECRET',
    'DISCORD_CLIENT_SECRET',
    'CLIENT_SECRET',
    'OAUTH_REDIRECT_URI',
    'OAUTH_AUTHORIZE_URL'
  ];
  const previous = new Map(keys.map(key => [key, process.env[key]]));

  for (const key of keys) {
    delete process.env[key];
  }

  try {
    callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('OAuth join setup reports missing client secret', () => {
  withoutOAuthEnv(() => {
    const status = getOAuthJoinSetupStatus({
      config: {
        bot: {
          oauthJoin: {
            clientId: '123456789012345678',
            clientSecret: null,
            redirectUri: 'https://example.test/callback',
            authorizeUrl: 'https://example.test/authorize'
          }
        }
      }
    });

    assert.equal(status.configured, false);
    assert.deepEqual(status.missing, ['OAUTH_CLIENT_SECRET or CLIENT_SECRET']);
  });
});

test('OAuth join returns configured authorization URL', () => {
  const authorizeUrl = getOAuthAuthorizeUrl({
    config: {
      bot: {
        oauthJoin: {
          authorizeUrl: 'https://example.test/oauth'
        }
      }
    }
  });

  assert.equal(authorizeUrl, 'https://example.test/oauth');
});

test('OAuth callback HTML escapes reflected text', () => {
  const html = formatOAuthCallbackHtml({
    ok: false,
    title: '<OAuth Failed>',
    message: 'bad & <script>alert(1)</script>'
  });

  assert.match(html, /&lt;OAuth Failed&gt;/);
  assert.match(html, /bad &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test('OAuth authorization listing filters malformed records', async () => {
  const store = new Map([
    [
      'cache:oauth:guildjoin:user:111',
      {
        userId: '111',
        username: 'valid-user',
        accessToken: 'stored-access-token'
      }
    ],
    ['cache:oauth:guildjoin:user:222', { userId: '222' }],
    ['cache:oauth:guildjoin:user:333', null]
  ]);

  const records = await listOAuthAuthorizations({
    db: {
      list: async prefix => Array.from(store.keys()).filter(key => key.startsWith(prefix)),
      get: async key => store.get(key) ?? null
    }
  });

  assert.deepEqual(records, [
    {
      userId: '111',
      username: 'valid-user',
      accessToken: 'stored-access-token'
    }
  ]);
});

test('OAuth authorization search finds stored users by ID, mention, username, and display name', async () => {
  const firstUserId = '111111111111111111';
  const secondUserId = '222222222222222222';
  const store = new Map([
    [
      `cache:oauth:guildjoin:user:${firstUserId}`,
      {
        userId: firstUserId,
        username: 'example_user',
        globalName: 'Example Display',
        accessToken: 'stored-access-token'
      }
    ],
    [
      `cache:oauth:guildjoin:user:${secondUserId}`,
      {
        userId: secondUserId,
        username: 'another_user',
        globalName: 'Another Display',
        accessToken: 'stored-access-token'
      }
    ]
  ]);
  const client = {
    db: {
      list: async prefix => Array.from(store.keys()).filter(key => key.startsWith(prefix)),
      get: async key => store.get(key) ?? null
    }
  };

  assert.deepEqual((await findOAuthAuthorizations(client, firstUserId)).map(record => record.userId), [firstUserId]);
  assert.deepEqual((await findOAuthAuthorizations(client, `<@${firstUserId}>`)).map(record => record.userId), [firstUserId]);
  assert.deepEqual((await findOAuthAuthorizations(client, 'Example_User')).map(record => record.userId), [firstUserId]);
  assert.deepEqual((await findOAuthAuthorizations(client, 'example display')).map(record => record.userId), [firstUserId]);
});

test('OAuth authorization search returns multiple username matches for ambiguous lookups', async () => {
  const store = new Map([
    [
      'cache:oauth:guildjoin:user:111111111111111111',
      {
        userId: '111111111111111111',
        username: 'alex',
        accessToken: 'stored-access-token'
      }
    ],
    [
      'cache:oauth:guildjoin:user:222222222222222222',
      {
        userId: '222222222222222222',
        username: 'alexander',
        accessToken: 'stored-access-token'
      }
    ]
  ]);
  const client = {
    db: {
      list: async prefix => Array.from(store.keys()).filter(key => key.startsWith(prefix)),
      get: async key => store.get(key) ?? null
    }
  };

  assert.deepEqual(
    (await findOAuthAuthorizations(client, 'ale')).map(record => record.userId),
    ['111111111111111111', '222222222222222222']
  );
});
