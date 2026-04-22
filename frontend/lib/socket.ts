'use client'

import { io, Socket } from 'socket.io-client'

const SOCKET_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001'

export const socket: Socket = io(SOCKET_URL, {
  transports: ['websocket'],
  autoConnect: false,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.5,
  auth: { token: '' },
})

/**
 * Bugfix (2026-04-23): track the LAST token we connected with so we can
 * detect a token swap (logout + login as a different user in the same
 * tab) and force a disconnect+reconnect rather than mutating
 * `socket.auth` while leaving the underlying Manager bound to the old
 * auth on its next reconnect attempt. Without this, after a logout
 * that didn't fully disconnect, the new login could leak broadcasts
 * intended for the old user.
 */
let _lastConnectedToken: string | null = null

export function connectSocket(token: string): void {
  // Token unchanged + already connected → no-op.
  if (socket.connected && _lastConnectedToken === token) {
    return
  }
  // Token changed mid-session → fully disconnect and reconnect with
  // the new auth. Mutating `socket.auth` alone isn't enough — the
  // Manager's internal reconnect path can re-use the previous auth
  // object captured at the last connect call.
  if (socket.connected && _lastConnectedToken !== token) {
    socket.disconnect()
  }
  socket.auth = { token }
  _lastConnectedToken = token
  socket.connect()
}

export function disconnectSocket(): void {
  _lastConnectedToken = null
  if (socket.connected) {
    socket.disconnect()
  }
}
