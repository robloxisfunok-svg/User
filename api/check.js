const ENDPOINT = 'https://discord.com/api/v9/unique-username/username-attempt-unauthed';
const USERNAME_PATTERN = /^[a-z0-9._]{2,32}$/;
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

async function readJsonSafely(response) {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export default async function handler(request) {
  if (request.method === 'GET') {
    return jsonResponse({ ok: true, service: 'discord-username-check' });
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      { status: 'error', message: 'Method not allowed.' },
      405,
      { Allow: 'GET, POST' },
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ status: 'error', message: 'Send valid JSON.' }, 400);
  }

  const username = typeof payload?.username === 'string'
    ? payload.username.trim().toLowerCase().replace(/^@+/, '')
    : '';

  if (!validUsername(username)) {
    return jsonResponse(
      {
        status: 'invalid',
        username,
        message: 'Use 2-32 lowercase letters, numbers, periods, or underscores; no consecutive periods.',
      },
      400,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const discordResponse = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordUsernameChecker-Vercel/2.0',
      },
      body: JSON.stringify({ username }),
      signal: controller.signal,
    });

    const data = await readJsonSafely(discordResponse);

    if (discordResponse.status === 429) {
      const retryHeader = Number(discordResponse.headers.get('retry-after'));
      const retryBody = Number(data.retry_after);
      const retryAfter = Math.max(
        5,
        Number.isFinite(retryBody) && retryBody > 0
          ? retryBody
          : Number.isFinite(retryHeader) && retryHeader > 0
            ? retryHeader
            : 5,
      );

      return jsonResponse(
        {
          status: 'rate_limited',
          username,
          retry_after: retryAfter,
          message: 'Discord rate limited this Vercel deployment.',
        },
        429,
      );
    }

    if (discordResponse.status === 401 || discordResponse.status === 403) {
      return jsonResponse(
        {
          status: 'error',
          username,
          message: 'Discord rejected requests from this Vercel deployment.',
        },
        502,
      );
    }

    if (!discordResponse.ok) {
      return jsonResponse(
        {
          status: 'error',
          username,
          message: `Discord returned HTTP ${discordResponse.status}.`,
        },
        502,
      );
    }

    if (typeof data.taken !== 'boolean') {
      return jsonResponse(
        {
          status: 'error',
          username,
          message: "Discord's response did not contain a valid taken value.",
        },
        502,
      );
    }

    return jsonResponse({
      status: data.taken ? 'taken' : 'available',
      username,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return jsonResponse(
      {
        status: 'error',
        username,
        message: timedOut
          ? 'The Discord request timed out.'
          : 'Could not connect to Discord.',
      },
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}
