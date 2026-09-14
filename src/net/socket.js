// Rooms WebSocket endpoint. Dev: rooms server on :8787. Prod: same host (/ws).
export function roomWsUrl() {
  if (import.meta.env?.DEV) return 'ws://localhost:8787/ws';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}
