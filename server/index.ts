import express from 'express'
import http from 'http'
import { Server } from 'socket.io'

type RoomState = {
  isPlaying: boolean
  baseMediaTime: number
  baseServerTime: number
  playbackRate: number
  src?: string
}

type PresenceUser = { id: string; name: string; role: 'host' | 'viewer'; ready?: boolean }

type Room = {
  state: RoomState
  users: Map<string, PresenceUser>
  hostSocketId?: string
  heartbeat?: NodeJS.Timeout
}

const rooms = new Map<string, Room>()

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId)
  if (!room) {
    room = {
      state: {
        isPlaying: false,
        baseMediaTime: 0,
        baseServerTime: Date.now(),
        playbackRate: 1,
      },
      users: new Map(),
      hostSocketId: undefined,
    }
    rooms.set(roomId, room)
  }
  return room
}

const PORT = Number(process.env.PORT || 4000)
// Public base URL for hosting under a prefix, e.g., /my-path
const BASE_PATH = (process.env.WS_BASE_PATH || '/vid-ws').trim().replace(/\/?$/, '') // no trailing slash
// Socket.IO path must include the base path for subpath hosting
const IO_PATH = `${BASE_PATH}/socket.io`
const HEALTH_PATH = `${BASE_PATH || ''}/health`.replace(/^\//, '/')

const app = express()
app.get(HEALTH_PATH, (_req, res) => {
  res.json({ ok: true })
})

const server = http.createServer(app)

const io = new Server(server, {
  path: IO_PATH,
  cors: {
    origin: (origin, callback) => {
      const allow = process.env.ALLOW_ORIGIN
      if (!allow) return callback(null, true)
      if (origin && origin === allow) return callback(null, true)
      return callback(new Error('CORS not allowed'))
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  perMessageDeflate: false,
})

io.on('connection', (socket) => {
  let joinedRoomId: string | null = null
  let user: PresenceUser | null = null

  socket.on('join', (payload: { roomId: string; name?: string; asHost?: boolean; src?: string }) => {
    const { roomId, name, asHost, src } = payload || ({} as any)
    if (!roomId) return socket.emit('error', { code: 'bad_request', message: 'roomId required' })

    const room = getOrCreateRoom(roomId)
    joinedRoomId = roomId
    socket.join(roomId)

    const role: PresenceUser['role'] = asHost || !room.hostSocketId ? 'host' : 'viewer'
    if (role === 'host') room.hostSocketId = socket.id

    user = { id: socket.id, name: name || `user-${socket.id.slice(0, 4)}`, role }
    room.users.set(socket.id, user)

    // If this is the first host and a src was provided, set it on the room state
    if (role === 'host' && src && typeof src === 'string') {
      room.state.src = src
    }
    socket.emit('state', room.state)
    io.to(roomId).emit('presence', { users: Array.from(room.users.values()) })

    if (!room.heartbeat) {
      room.heartbeat = setInterval(() => {
        // Periodic state broadcast for eventual consistency
        io.to(roomId).emit('state', room.state)
      }, 2000)
    }
  })

  socket.on('play', () => {
    if (!joinedRoomId) return
    const room = getOrCreateRoom(joinedRoomId)
    const now = Date.now()
    // Continue timeline from current computed time
    const elapsed = (now - room.state.baseServerTime) / 1000
    const current = room.state.baseMediaTime + (room.state.isPlaying ? elapsed * room.state.playbackRate : 0)
    room.state.isPlaying = true
    room.state.baseMediaTime = current
    room.state.baseServerTime = now
    io.to(joinedRoomId).emit('state', room.state)
  })

  socket.on('pause', (payload?: { atMediaTime?: number }) => {
    if (!joinedRoomId) return
    const room = getOrCreateRoom(joinedRoomId)
    const now = Date.now()
    const atMediaTime = payload?.atMediaTime
    // Freeze the timeline at current target time
    const elapsed = (now - room.state.baseServerTime) / 1000
    const computed = room.state.baseMediaTime + (room.state.isPlaying ? elapsed * room.state.playbackRate : 0)
    room.state.isPlaying = false
    room.state.baseServerTime = now
    room.state.baseMediaTime = typeof atMediaTime === 'number' ? atMediaTime : computed
    io.to(joinedRoomId).emit('state', room.state)
  })

  socket.on('seek', (payload: { toMediaTime: number }) => {
    if (!joinedRoomId) return
    const room = getOrCreateRoom(joinedRoomId)
    const now = Date.now()
    room.state.baseMediaTime = Math.max(0, payload?.toMediaTime ?? 0)
    room.state.baseServerTime = now
    io.volatile.to(joinedRoomId).emit('state', room.state)
  })

  socket.on('rate', (payload: { playbackRate: number }) => {
    if (!joinedRoomId) return
    const room = getOrCreateRoom(joinedRoomId)
    const now = Date.now()
    // Keep target time continuous across rate change
    const elapsed = (now - room.state.baseServerTime) / 1000
    const current = room.state.baseMediaTime + (room.state.isPlaying ? elapsed * room.state.playbackRate : 0)
    room.state.baseMediaTime = current
    room.state.baseServerTime = now
    room.state.playbackRate = Math.max(0.25, Math.min(4, payload?.playbackRate ?? 1))
    io.volatile.to(joinedRoomId).emit('state', room.state)
  })

  socket.on('ready', (payload: { ready: boolean }) => {
    if (!joinedRoomId || !user) return
    const room = getOrCreateRoom(joinedRoomId)
    user.ready = !!payload?.ready
    room.users.set(socket.id, user)
    io.to(joinedRoomId).emit('presence', { users: Array.from(room.users.values()) })
  })

  socket.on('ping', (payload: { t0: number }) => {
    socket.emit('pong', { t0: payload?.t0, t1: Date.now() })
  })

  socket.on('disconnect', () => {
    if (!joinedRoomId) return
    const room = getOrCreateRoom(joinedRoomId)
    room.users.delete(socket.id)
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = undefined
      // Optionally transfer host to first viewer
      const first = room.users.values().next().value as PresenceUser | undefined
      if (first) {
        room.hostSocketId = first.id
        first.role = 'host'
        room.users.set(first.id, first)
      }
    }
    io.to(joinedRoomId).emit('presence', { users: Array.from(room.users.values()) })
    if (room.users.size === 0) {
      if (room.heartbeat) {
        clearInterval(room.heartbeat)
      }
      rooms.delete(joinedRoomId)
    }
  })
})

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`WS server listening on :${PORT}, basePath=${BASE_PATH || '/'} ioPath=${IO_PATH}`)
})


