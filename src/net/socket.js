// Rooms WebSocket endpoint.
// - VITE_ROOM_WS overrides everything (e.g. point Pages at a public server).
// - Discord Activity (framed + VITE_DISCORD_CLIENT_ID): use the mapped proxy
//   path `/.proxy/ws` (Developer Portal: URL mapping covering /ws).
// - Dev: same host as the page, port 8787 (works for localhost AND LAN --host).
// - Prod: same host (/ws) — needs `npm start` (or any host serving app + WS).
export function roomWsUrl(opts = {}) {
  const override = import.meta.env?.VITE_ROOM_WS;
  if (override && !opts.discord) return override;
  if (opts.discord) {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/.proxy/ws`;
  }
  if (import.meta.env?.DEV) return `ws://${window.location.hostname}:8787/ws`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}
