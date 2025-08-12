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
  const stateRef = useRef<ServerState | null>(null)
  const [users, setUsers] = useState<Array<{ id: string; name: string; role: 'host' | 'viewer'; ready?: boolean }>>([])
  const socketRef = useRef<ClientSocket | null>(null)
  const skewRef = useRef(0)
  const skewEmaRef = useRef(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [myId, setMyId] = useState<string>('')
  const isHost = useMemo(() => users.some((u) => u.id === myId && u.role === 'host'), [users, myId])
  const piRef = useRef({ integral: 0, lastTime: 0 })

  const wsUrl = useMemo(() => (import.meta.env.VITE_WS_URL as string) || 'wss://playground.royyanba.ch', [])
  const wsBasePath = useMemo(() => (import.meta.env.VITE_WS_BASE_PATH as string) || '/vid-ws', [])
  const initialSrc = useMemo(() => {
    try {
      return localStorage.getItem(`room:${id}:src`) || undefined
    } catch {
      return undefined
    }
  }, [id])

  useEffect(() => {
    const socket = connectSocket({ baseUrl: wsUrl, basePath: wsBasePath, query: { roomId: id } })
    socketRef.current = socket

    socket.on('connect', () => setMyId(socket.id || ''))
    const applyStateToPlayer = (s: ServerState) => {
      if (isHost) return
      const video = videoRef.current
      const api = (video as any)?._playerApi as
        | { play: () => void; pause: () => void; seek: (t: number) => void; setRate: (r: number) => void; getCurrentTime: () => number }
        | undefined
      if (!video || !api) return
      const now = Date.now() + skewRef.current
      const target = computeTargetTime(s, now)
      const current = api.getCurrentTime()
      const drift = current - target
      if (Math.abs(drift) > 1.5) {
        api.seek(target)
        piRef.current.integral = 0
      }
      // Align play/pause immediately
      if (s.isPlaying && (video as any).paused) api.play()
      if (!s.isPlaying && !(video as any).paused) api.pause()
      // Sync baseline playbackRate (PI loop will micro-adjust)
      try {
        if (Math.abs((video as any).playbackRate - (s.playbackRate || 1)) > 0.001) {
          api.setRate(s.playbackRate || 1)
        }
      } catch {}
    }

    socket.on('state', (s) => {
      stateRef.current = s
      setState({ ...s })
      applyStateToPlayer(s)
    })
    socket.on('resync', (s) => {
      stateRef.current = s
      setState({ ...s })
      applyStateToPlayer(s)
    })
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
      const measuredSkew = serverTimeAtRecv - t2
      const alpha = 0.2
      skewEmaRef.current = (1 - alpha) * skewEmaRef.current + alpha * measuredSkew
      skewRef.current = skewEmaRef.current
      ;(window as any).__lastRTT = rtt
    })

    socket.emit('join', { roomId: id, src: initialSrc })
    const pingIv = setInterval(ping, 2000)
    ping()

    return () => {
      clearInterval(pingIv)
      socket.disconnect()
    }
  }, [id, wsUrl, wsBasePath])

  // Drift correction loop (non-host only, prefer rVFC, fallback interval) using a PI controller
  useEffect(() => {
    if (isHost) return
    const rateResetRef = { id: 0 as unknown as number }
    let useIntervalFallback = true
    const video = videoRef.current
    const api = (video as any)?._playerApi as
      | { play: () => void; pause: () => void; seek: (t: number) => void; setRate: (r: number) => void; getCurrentTime: () => number }
      | undefined
    if (!video || !api) return

    // rVFC-based loop (if supported)
    if ('requestVideoFrameCallback' in video) {
      useIntervalFallback = false
      let lastCheck = 0
      let rafId = 0 as unknown as number
      const tick = (_now: number) => {
        const s = stateRef.current
        if (!s) return
        const nowMs = performance.now()
        if (nowMs - lastCheck >= 300) {
          lastCheck = nowMs
          const target = computeTargetTime(s, Date.now() + skewRef.current)
          const current = api.getCurrentTime()
          const drift = current - target
          const abs = Math.abs(drift)
          if (abs > 1.5) {
            api.seek(target)
            piRef.current.integral = 0
          } else {
            // PI controller around baseline rate
            const baseline = s.playbackRate || 1
            const now = performance.now()
            const dt = Math.max(0.05, (now - piRef.current.lastTime) / 1000)
            piRef.current.lastTime = now
            // accumulate only when playing
            if (s.isPlaying && !(video as any).paused) {
              piRef.current.integral += drift * dt
              // clamp integral to avoid windup
              piRef.current.integral = Math.max(-2, Math.min(2, piRef.current.integral))
            }
            const Kp = 0.25
            const Ki = 0.05
            let nextRate = baseline - Kp * drift - Ki * piRef.current.integral
            const minRate = Math.max(0.5, baseline - 0.15)
            const maxRate = Math.min(2.0, baseline + 0.15)
            nextRate = Math.max(minRate, Math.min(maxRate, nextRate))
            if (Math.abs((video as any).playbackRate - nextRate) > 0.005) {
              api.setRate(nextRate)
            }
          }
          if (s.isPlaying && (video as any).paused) {
            void api.play()
          } else if (!s.isPlaying && !(video as any).paused) {
            api.pause()
          }
        }
        rafId = (video as any).requestVideoFrameCallback(tick)
      }
      rafId = (video as any).requestVideoFrameCallback(tick)
      return () => {
        if (rafId) (video as any).cancelVideoFrameCallback?.(rafId)
        if (rateResetRef.id) clearTimeout(rateResetRef.id)
      }
    }

    // Fallback interval loop
    if (useIntervalFallback) {
      const iv = setInterval(() => {
        const s = stateRef.current
        if (!s) return
        const target = computeTargetTime(s, Date.now() + skewRef.current)
        const current = api.getCurrentTime()
        const drift = current - target
        const abs = Math.abs(drift)
        if (abs > 1.5) {
          api.seek(target)
          piRef.current.integral = 0
        } else {
          const baseline = s.playbackRate || 1
          const now = performance.now()
          const dt = Math.max(0.05, (now - piRef.current.lastTime) / 1000)
          piRef.current.lastTime = now
          if (s.isPlaying && !(video as any).paused) {
            piRef.current.integral += drift * dt
            piRef.current.integral = Math.max(-2, Math.min(2, piRef.current.integral))
          }
          const Kp = 0.25
          const Ki = 0.05
          let nextRate = baseline - Kp * drift - Ki * piRef.current.integral
          const minRate = Math.max(0.5, baseline - 0.15)
          const maxRate = Math.min(2.0, baseline + 0.15)
          nextRate = Math.max(minRate, Math.min(maxRate, nextRate))
          if (Math.abs((video as any).playbackRate - nextRate) > 0.005) {
            api.setRate(nextRate)
          }
        }
        if (s.isPlaying && (video as any).paused) {
          void api.play()
        } else if (!s.isPlaying && !(video as any).paused) {
          api.pause()
        }
      }, 500)
      return () => {
        clearInterval(iv)
        if (rateResetRef.id) clearTimeout(rateResetRef.id)
      }
    }
  }, [isHost])

  // Optional debug metrics overlay
  // Optional debug metrics overlay (only if ?debug)
  const debugEnabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')
  const [debug, setDebug] = useState<{ drift: number; rtt: number; skew: number } | null>(null)
  useEffect(() => {
    if (!debugEnabled) return
    const iv = setInterval(() => {
      const s = stateRef.current
      const video = videoRef.current
      const api = (video as any)?._playerApi
      if (!s || !video || !api) return
      const target = computeTargetTime(s, Date.now() + skewRef.current)
      const current = api.getCurrentTime()
      const drift = current - target
      const rtt = (window as any).__lastRTT || 0
      setDebug({ drift, rtt, skew: skewRef.current })
    }, 500)
    return () => clearInterval(iv)
  }, [debugEnabled])

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

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const effectiveSrc = state?.src || initialSrc

  return (
    <div className={`h-dvh grid grid-cols-1 ${sidebarOpen ? 'md:grid-cols-[1fr_minmax(280px,360px)]' : 'md:grid-cols-1'}`}>
      <div className="relative p-3 md:p-4 overflow-y-auto flex items-center justify-center bg-gray-100">
        {debugEnabled && debug ? (
          <div className="fixed bottom-3 right-3 text-xs bg-black/70 text-white rounded px-2 py-1 z-10">
            <div>drift: {debug.drift.toFixed(3)}s</div>
            <div>rtt: {debug.rtt}ms</div>
            <div>skew: {debug.skew.toFixed(1)}ms</div>
          </div>
        ) : null}

        <div
          ref={(el) => {
            videoRef.current = (el?.querySelector('video') as HTMLVideoElement) || null
          }}
        >
          {effectiveSrc ? (
            <Player src={effectiveSrc} />
          ) : (
            <div className="w-full max-w-5xl mx-auto aspect-video grid place-items-center rounded-lg border border-dashed">
              <div className="text-zinc-600 text-sm">Waiting for host to set a video…</div>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <div className={`relative border-t md:border-t-0 md:border-l border-zinc-200 bg-white ${sidebarOpen ? 'block' : 'hidden'}`}>
        <button
          className="absolute top-3 right-3 z-10 px-3 py-1.5 text-xs rounded-md bg-zinc-100 hover:bg-zinc-200"
          onClick={() => setSidebarOpen((s) => !s)}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          {sidebarOpen ? 'Hide' : 'Show'}
        </button>
        <div className="sticky top-0 h-dvh p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Room {id}</h2>
            <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
              Home
            </Link>
          </div>

          <div className="space-y-2 text-sm text-zinc-700">
            <div>
              <span className="text-zinc-500">Status:</span>{' '}
              {state ? (
                <>
                  {state.isPlaying ? 'Playing' : 'Paused'} @ rate {state.playbackRate}
                </>
              ) : (
                'Connecting…'
              )}
            </div>
            <div>
              <span className="text-zinc-500">Source:</span>{' '}
              {effectiveSrc ? (
                <a href={effectiveSrc} target="_blank" rel="noreferrer" className="text-primary underline break-all">
                  {effectiveSrc}
                </a>
              ) : (
                '—'
              )}
            </div>
            <div>
              <span className="text-zinc-500">Users ({users.length}):</span>
              <div className="mt-1 space-y-1">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center justify-between text-zinc-700">
                    <span>{u.name}</span>
                    <span className="text-xs text-zinc-500">{u.role}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Future: chat, room controls, etc. */}
        </div>
      </div>
      {/* Show button overlay when sidebar is hidden on md+ */}
      {!sidebarOpen ? (
        <button
          className="hidden md:inline-flex absolute top-3 right-3 z-10 px-3 py-1.5 text-xs rounded-md bg-zinc-100 hover:bg-zinc-200 border border-zinc-200"
          onClick={() => setSidebarOpen(true)}
          aria-label="Show sidebar"
        >
          Show
        </button>
      ) : null}
    </div>
  )
}

