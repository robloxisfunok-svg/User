const USERNAME_PATTERN = /^[a-z0-9._]{2,32}$/;
const WEBHOOK_PATH_PATTERN = /^\/api(?:\/v\d+)?\/webhooks\/\d{10,30}\/[A-Za-z0-9._-]{20,250}\/?$/;
const ALLOWED_HOSTS = new Set([
  'discord.com',
  'canary.discord.com',
  'ptb.discord.com',
  'discordapp.com',
]);
const REQUEST_TIMEOUT_MS = 12_000;

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function validUsername(username) {
  return USERNAME_PATTERN.test(username) && !username.includes('..');
}

function validateWebhookUrl(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return { ok: false, message: 'Enter a Discord webhook URL.' };
  }

  let url;
  try {
    url = new URL(rawValue.trim());
  } catch {
    return { ok: false, message: 'Invalid webhook URL.' };
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(host)) {
    return { ok: false, message: 'Use an official HTTPS Discord webhook URL.' };
  }

  if (!WEBHOOK_PATH_PATTERN.test(url.pathname)) {
    return { ok: false, message: 'That does not look like a Discord webhook URL.' };
  }

  url.hostname = host === 'discordapp.com' ? 'discord.com' : host;
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  url.searchParams.set('wait', 'true');

  return { ok: true, url: url.toString() };
}

async function postWebhook(webhookUrl, content) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const discordResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordUsernameChecker-Vercel/2.0',
      },
      body: JSON.stringify({
        username: 'Username Checker',
        content,
        allowed_mentions: { parse: [] },
      }),
      signal: controller.signal,
    });

    if (discordResponse.status === 429) {
      return jsonResponse({ ok: false, message: 'Discord rate limited the webhook.' }, 429);
    }

    if ([401, 403, 404].includes(discordResponse.status)) {
      return jsonResponse(
        { ok: false, message: 'Webhook is invalid, deleted, or inaccessible.' },
        400,
      );
    }

    if (!discordResponse.ok) {
      return jsonResponse(
        { ok: false, message: `Webhook returned HTTP ${discordResponse.status}.` },
        502,
      );
    }

    return jsonResponse({ ok: true, message: 'Webhook sent successfully.' });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return jsonResponse(
      {
        ok: false,
        message: timedOut ? 'The webhook request timed out.' : 'Could not reach Discord.',
      },
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(request) {
  if (request.method === 'GET') {
    return jsonResponse({ ok: true, service: 'discord-webhook' });
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      { ok: false, message: 'Method not allowed.' },
      405,
      { Allow: 'GET, POST' },
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ ok: false, message: 'Send valid JSON.' }, 400);
  }

  const webhook = validateWebhookUrl(payload?.webhook_url);
  if (!webhook.ok) {
    return jsonResponse({ ok: false, message: webhook.message }, 400);
  }

  let content;
  if (payload?.action === 'test') {
    content = '✅ Discord Username Checker webhook test successful.';
  } else if (payload?.action === 'available') {
    const username = typeof payload?.username === 'string'
      ? payload.username.trim().toLowerCase().replace(/^@+/, '')
      : '';

    if (!validUsername(username)) {
      return jsonResponse({ ok: false, message: 'Invalid username.' }, 400);
    }
    content = `✅ Available Discord username: \`${username}\``;
  } else {
    return jsonResponse({ ok: false, message: 'Invalid webhook action.' }, 400);
  }

  return postWebhook(webhook.url, content);
}
