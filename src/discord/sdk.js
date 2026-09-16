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
// VITE_BACKEND_HOST=rrbg-rooms.onrender.com (no protocol, no path).
export function backendHost() {
  return import.meta.env?.VITE_BACKEND_HOST ?? window.location.host;
}

// Token exchange goes through the Discord proxy when framed:
// Developer Portal mapping should be `/api -> <backend-host>`.
export function apiTokenUrl() {
  if (shouldUseDiscord()) return '/.proxy/api/token';
  return '/api/token';
}

// Rooms WS: standalone uses roomWsUrl(); Discord uses the mapped proxy path.
// Portal mapping should include a WS-capable entry covering `/ws`.
export function discordWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  if (shouldUseDiscord()) return `${proto}://${window.location.host}/.proxy/ws`;
  return null;
}

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

  const res = await fetch(apiTokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
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
