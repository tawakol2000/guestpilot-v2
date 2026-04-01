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

export function connectSocket(token: string): void {
  socket.auth = { token }
  if (!socket.connected) {
    socket.connect()
  }
}

export function disconnectSocket(): void {
  if (socket.connected) {
    socket.disconnect()
  }
}
