import { Link, createFileRoute, useParams } from '@tanstack/react-router'
import Player from '@/components/Player'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type ClientSocket, type ServerState, computeTargetTime, connectSocket } from '@/lib/ws'

export const Route = createFileRoute('/room/$id')({
  component: RoomPage,
})

function RoomPage() {
  const { id } = useParams({ from: '/room/$id' })
  const [state, setState] = useState<ServerState | null>(null)
  const [users, setUsers] = useState<Array<{ id: string; name: string; role: 'host' | 'viewer'; ready?: boolean }>>([])
  const socketRef = useRef<ClientSocket | null>(null)
  const skewRef = useRef(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [myId, setMyId] = useState<string>('')
  const isHost = useMemo(() => users.some((u) => u.id === myId && u.role === 'host'), [users, myId])

  const wsUrl = useMemo(() => (import.meta.env.VITE_WS_URL as string) || 'ws://localhost:4000', [])
  const wsBasePath = useMemo(() => (import.meta.env.VITE_WS_BASE_PATH as string) || '', [])

  useEffect(() => {
    const socket = connectSocket({ baseUrl: wsUrl, basePath: wsBasePath, query: { roomId: id } })
    socketRef.current = socket

    socket.on('connect', () => setMyId(socket.id || ''))
    socket.on('state', (s) => setState({ ...s }))
    socket.on('resync', (s) => setState({ ...s }))
    socket.on('presence', (p) => setUsers(p.users))

    // clock skew estimate
    const ping = () => {
      const t0 = Date.now()
      socket.emit('ping', { t0 })
    }
    socket.on('pong', ({ t0, t1 }) => {
      const t2 = Date.now()
      const rtt = t2 - t0
      const serverTimeAtRecv = t1 + rtt / 2
      skewRef.current = serverTimeAtRecv - t2
    })

    socket.emit('join', { roomId: id })
    const pingIv = setInterval(ping, 2000)
    ping()

    return () => {
      clearInterval(pingIv)
      socket.disconnect()
    }
  }, [id, wsUrl, wsBasePath])

  // Drift correction loop (non-host only)
  useEffect(() => {
    if (!state || isHost) return
    const iv = setInterval(() => {
      const video = videoRef.current
      if (!video) return
      const api = (video as any)._playerApi as
        | { play: () => void; pause: () => void; seek: (t: number) => void; setRate: (r: number) => void; getCurrentTime: () => number }
        | undefined
      if (!api) return
      const now = Date.now() + skewRef.current
      const target = computeTargetTime(state, now)
      const current = api.getCurrentTime()
      const drift = current - target

      const abs = Math.abs(drift)
      if (abs > 0.4) {
        api.seek(target)
      } else if (abs > 0.1) {
        // nudge rate briefly
        api.setRate(drift > 0 ? 0.95 : 1.05)
        setTimeout(() => api.setRate(1), 800)
      } else if (state.isPlaying && (video as any).paused) {
        api.play()
      } else if (!state.isPlaying && !(video as any).paused) {
        api.pause()
      }
    }, 500)
    return () => clearInterval(iv)
  }, [state, isHost])

  // Host-only: emit controls based on local player actions
  useEffect(() => {
    const video = videoRef.current
    const socket = socketRef.current
    if (!video || !socket) return
    if (!isHost) return

    const handlePlay = () => socket.emit('play')
    const handlePause = () => socket.emit('pause', { atMediaTime: video.currentTime || 0 })
    const handleSeeked = () => socket.emit('seek', { toMediaTime: video.currentTime || 0 })
    const handleRate = () => socket.emit('rate', { playbackRate: video.playbackRate || 1 })

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('ratechange', handleRate)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('ratechange', handleRate)
    }
  }, [isHost])

  return (
    <div className="p-4 md:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room {id}</h1>
        <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Back Home
        </Link>
      </div>

      {/* Attach a ref to access the internal API via the video element handle */}
      <div
        ref={(el) => {
          videoRef.current = (el?.querySelector('video') as HTMLVideoElement) || null
        }}
      >
        <Player />
      </div>

      <div className="text-sm text-zinc-500">
        {state ? (
          <>
            <div>
              Status: {state.isPlaying ? 'Playing' : 'Paused'} @ rate {state.playbackRate}
            </div>
            <div className="mt-1">Users: {users.map((u) => `${u.name}${u.role === 'host' ? ' (host)' : ''}`).join(', ')}</div>
          </>
        ) : (
          'Connecting…'
        )}
      </div>
    </div>
  )
}

