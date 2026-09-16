// ─── Discord Activity helpers (dual-mode: Discord iframe vs standalone web) ──
// Standalone web (Render/Pages/localhost) keeps the existing 4-letter room
// codes untouched. Inside Discord, the SDK provides identity + instanceId so
// everyone in the same channel auto-joins one room (no codes to share).

export function discordClientId() {
  return import.meta.env?.VITE_DISCORD_CLIENT_ID ?? '';
}

export function isFramed() {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin iframe throws → we are framed
  }
}

export function shouldUseDiscord() {
  return Boolean(discordClientId()) && isFramed();
}

// Backend host the Discord URL-mapping proxy should forward to, e.g.
// VITE_BACKEND_HOST=rrbg.onrender.com (no protocol, no path).
export function backendHost() {
  return import.meta.env?.VITE_BACKEND_HOST ?? window.location.host;
}

// Token exchange goes through the Discord proxy when framed:
// Developer Portal mapping should be `/api -> <backend-host>`.
// Tries `/.proxy/api/token` first, then plain `/api/token` — Discord's
// proxy has routed both forms in different client versions, and our server
// answers `/api/token` either way.
export function apiTokenUrl() {
  if (shouldUseDiscord()) return '/.proxy/api/token';
  return '/api/token';
}

function apiTokenFallbacks() {
  if (!shouldUseDiscord()) return ['/api/token'];
  return ['/.proxy/api/token', '/api/token'];
}

// Rooms WS: standalone uses roomWsUrl(); Discord uses the mapped proxy path.
// Uses whichever prefix form the token exchange proved working.
export function discordWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  if (shouldUseDiscord()) return `${proto}://${window.location.host}${workingProxyPrefix}/ws`;
  return null;
}

// Set by postTokenWithFallback: '/.proxy' or '' depending on which form the
// Discord proxy actually routes to our server.
let workingProxyPrefix = '/.proxy';

// Full Discord handshake: ready → authorize → server token exchange →
// authenticate. Returns { sdk, auth, context } where context has
// instanceId/channelId/guildId + the Discord user.
export async function handshakeDiscord() {
  const clientId = discordClientId();
  if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID is not set');
  const { DiscordSDK } = await import('@discord/embedded-app-sdk');
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  // Route our backend calls through the proxy mapping (/.proxy -> backend).
  try {
    const { patchUrlMappings } = await import('@discord/embedded-app-sdk');
    patchUrlMappings([{ prefix: '/.proxy', target: backendHost() }]);
  } catch {
    // older SDK without patch helper — direct /.proxy URLs still work
  }

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  const res = await postTokenWithFallback(code);
  const { access_token } = await res.json();
  const auth = await sdk.commands.authenticate({ access_token });
  const context = {
    instanceId: String(auth?.instance_id ?? sdk.instanceId ?? 'solo'),
    channelId: sdk.channelId ?? null,
    guildId: sdk.guildId ?? null,
    user: auth?.user ?? null,
  };
  return { sdk, auth, context };
}

// POST the OAuth code to each candidate token URL in turn. A proxy miss
// returns HTML (or an error status) instead of JSON — skip it and try the
// next form before giving up with a diagnostic error.
async function postTokenWithFallback(code) {
  const tried = [];
  for (const url of apiTokenFallbacks()) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    } catch (e) {
      tried.push(`${url} (network: ${e?.message ?? e})`);
      continue;
    }
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      if (!res.ok || data?.error || !data?.access_token) {
        tried.push(`${url} (${res.status}: ${String(data?.error ?? text).slice(0, 80)})`);
        continue;
      }
      workingProxyPrefix = url.startsWith('/.proxy') ? '/.proxy' : '';
      // Re-wrap so callers can keep using res.json().
      return new Response(JSON.stringify(data), { status: 200 });
    } catch {
      tried.push(`${url} (${res.status}: non-JSON: ${text.slice(0, 80)})`);
    }
  }
  throw new Error(`token exchange failed — proxy /api mapping not reaching server [${tried.join(' | ')}]`);
}
