import { io, Socket } from 'socket.io-client'

export type ServerState = {
  isPlaying: boolean
  baseMediaTime: number
  baseServerTime: number
  playbackRate: number
  src?: string
  subtitles?: Array<{ src: string; label: string; lang?: string; default?: boolean }>
}

export type Presence = {
  users: Array<{ id: string; name: string; role: 'host' | 'viewer'; ready?: boolean }>
}

export type ChatMessage = {
  id: string
  userId: string
  name: string
  ts: number
  text: string
}

export type ClientSocket = Socket<
  {
    state: (s: ServerState) => void
    resync: (s: ServerState) => void
    presence: (p: Presence) => void
    pong: (p: { t0: number; t1: number }) => void
    error: (e: { code: string; message: string }) => void
    chat: (m: ChatMessage) => void
    'rtc:peers': (p: { peers: string[] }) => void
    'rtc:peer-joined': (p: { peerId: string }) => void
    'rtc:peer-left': (p: { peerId: string }) => void
    'rtc:offer': (p: { from: string; description: RTCSessionDescriptionInit }) => void
    'rtc:answer': (p: { from: string; description: RTCSessionDescriptionInit }) => void
    'rtc:ice': (p: { from: string; candidate: RTCIceCandidateInit }) => void
  },
  {
    join: (p: { roomId: string; name?: string; asHost?: boolean; src?: string }) => void
    play: () => void
    pause: (p?: { atMediaTime?: number }) => void
    seek: (p: { toMediaTime: number }) => void
    rate: (p: { playbackRate: number }) => void
    ready: (p: { ready: boolean }) => void
    ping: (p: { t0: number }) => void
    subtitles: (p: { subtitles: Array<{ src: string; label: string; lang?: string; default?: boolean }> }) => void
    'chat:send': (p: { text: string }) => void
    'rtc:join': () => void
    'rtc:leave': () => void
    'rtc:offer': (p: { to: string; description: RTCSessionDescriptionInit }) => void
    'rtc:answer': (p: { to: string; description: RTCSessionDescriptionInit }) => void
    'rtc:ice': (p: { to: string; candidate: RTCIceCandidateInit }) => void
  }
>

export function connectSocket({
  baseUrl,
  basePath = '',
  query,
}: {
  baseUrl: string
  basePath?: string
  query?: Record<string, string>
}): ClientSocket {
  const normalizedBasePath = basePath.trim().replace(/\/$/, '')
  const path = `${normalizedBasePath}/socket.io`
  const url = baseUrl.replace(/\/$/, '')
  const socket = io(url, {
    path,
    transports: ['websocket'],
    forceNew: true,
    withCredentials: true,
    query,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    timeout: 8000,
  }) as ClientSocket
  return socket
}

export function computeTargetTime(state: ServerState, nowMs: number): number {
  const elapsed = (nowMs - state.baseServerTime) / 1000
  const add = state.isPlaying ? elapsed * state.playbackRate : 0
  return state.baseMediaTime + add
}


