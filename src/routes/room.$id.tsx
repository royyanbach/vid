import { createFileRoute, useParams } from '@tanstack/react-router'
import Player from '@/components/Player'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ClientSocket, type ServerState, computeTargetTime, connectSocket, type ChatMessage } from '@/lib/ws'
import { Button } from '@/components/ui/button'
import { MessageSquare } from 'lucide-react'
import VideoStrip from '@/components/VideoStrip'
import ReactionWidget from '@/components/ReactionWidget'

export const Route = createFileRoute('/room/$id')({
  component: RoomPage,
})

function RoomPage() {
  const { id } = useParams({ from: '/room/$id' })
  const [state, setState] = useState<ServerState | null>(null)
  const stateRef = useRef<ServerState | null>(null)
  const [users, setUsers] = useState<Array<{ id: string; name: string; role: 'host' | 'viewer'; ready?: boolean }>>([])
  const previousUsersRef = useRef<Array<{ id: string; name: string; role: 'host' | 'viewer'; ready?: boolean }>>([])
  const isFirstPresenceRef = useRef(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const chatOpenRef = useRef(false)
  const socketRef = useRef<ClientSocket | null>(null)
  const skewRef = useRef(0)
  const skewEmaRef = useRef(0)
  const rttRef = useRef(200)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [myId, setMyId] = useState<string>('')
  const myIdRef = useRef<string>('')
  const isHost = useMemo(() => users.some((u) => u.id === myId && u.role === 'host'), [users, myId])
  const piRef = useRef({ integral: 0, lastTime: 0 })
  const lastPlayReqRef = useRef(0)
  const lastPauseReqRef = useRef(0)
  const lastSeekAtRef = useRef(0)
  const [chatOpen, setChatOpen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const chatButtonRef = useRef<HTMLButtonElement | null>(null)
  const chatPopupRef = useRef<HTMLDivElement | null>(null)
  const joinAutoplayArmedRef = useRef(false)
  const [bubbleMessage, setBubbleMessage] = useState<ChatMessage | null>(null)
  const bubbleTimeoutRef = useRef<number | null>(null)

  const ensurePlaybackState = useCallback((desiredPlaying: boolean) => {
    const video = videoRef.current
    const api = (video as any)?._playerApi as
      | { play: () => void; pause: () => void }
      | undefined
    if (!video || !api) return
    if (!video.currentSrc) return
    // avoid thrash around seeks or when not ready
    if (video.seeking || video.readyState < 2) return
    const now = performance.now()
    const windowMs = Math.max(300, Math.min(1600, rttRef.current * 2 + 200))
    if (desiredPlaying) {
      if (!video.paused) return
      if (now - lastSeekAtRef.current < 250) return
      // If we just locally paused, don't auto-play immediately
      if (now - lastPauseReqRef.current < windowMs) return
      if (now - lastPlayReqRef.current < windowMs) return
      lastPlayReqRef.current = now
      void api.play()
    } else {
      if (video.paused) return
      // If we just locally played, don't auto-pause immediately
      if (now - lastPlayReqRef.current < windowMs) return
      if (now - lastPauseReqRef.current < 300) return
      lastPauseReqRef.current = now
      api.pause()
    }
  }, [])

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

    socket.on('connect', () => {
      const id = socket.id || ''
      setMyId(id)
      myIdRef.current = id
    })

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
      const seekThreshold = Math.max(1.2, rttRef.current / 250)
      if (Math.abs(drift) > seekThreshold) {
        api.seek(target)
        piRef.current.integral = 0
        lastSeekAtRef.current = performance.now()
      }
      // Align play/pause immediately
      ensurePlaybackState(s.isPlaying)
      // If joining into a playing room, arm autoplay until media is ready
      if (s.isPlaying) joinAutoplayArmedRef.current = true
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
      // If room is playing, attempt immediate play when we first receive state
      if (!isHost && s.isPlaying) {
        const video = videoRef.current
        const api = (video as any)?._playerApi
        if (video && api && (video as any).paused) {
          lastPlayReqRef.current = performance.now()
          void api.play()
        }
      }
    })
    socket.on('resync', (s) => {
      stateRef.current = s
      setState({ ...s })
      applyStateToPlayer(s)
      if (!isHost && s.isPlaying) {
        const video = videoRef.current
        const api = (video as any)?._playerApi
        if (video && api && (video as any).paused) {
          lastPlayReqRef.current = performance.now()
          void api.play()
        }
      }
    })
    socket.on('presence', (p) => {
      const prev = previousUsersRef.current
      const current = p.users

      // Create system messages for joins and leaves
      const systemMessages: ChatMessage[] = []

      if (isFirstPresenceRef.current) {
        // On first presence, show all existing users as joined (except yourself)
        current.forEach((user) => {
          if (user.id !== myIdRef.current) {
            systemMessages.push({
              id: `system-join-${user.id}-${Date.now()}-${Math.random()}`,
              userId: 'system',
              name: 'System',
              ts: Date.now(),
              text: `${user.name} joined`,
            })
          }
        })
        isFirstPresenceRef.current = false
      } else {
        // Find users who joined (in current but not in prev)
        const joined = current.filter(
          (u) => !prev.some((prevU) => prevU.id === u.id)
        )

        // Find users who left (in prev but not in current)
        const left = prev.filter(
          (prevU) => !current.some((u) => u.id === prevU.id)
        )

        joined.forEach((user) => {
          // Don't show a message for yourself joining
          if (user.id !== myIdRef.current) {
            systemMessages.push({
              id: `system-join-${user.id}-${Date.now()}`,
              userId: 'system',
              name: 'System',
              ts: Date.now(),
              text: `${user.name} joined`,
            })
          }
        })

        left.forEach((user) => {
          systemMessages.push({
            id: `system-left-${user.id}-${Date.now()}`,
            userId: 'system',
            name: 'System',
            ts: Date.now(),
            text: `${user.name} left the room`,
          })
        })
      }

      // Update users state
      setUsers(current)
      previousUsersRef.current = current

      // Add system messages if any
      if (systemMessages.length > 0) {
        setMessages((prev) => {
          const next = [...prev, ...systemMessages]
          // keep bounded length on client too
          if (next.length > 300) next.splice(0, next.length - 300)
          return next
        })
        // increment unread if widget is closed
        setUnreadCount((prev) => (chatOpenRef.current ? 0 : Math.min(999, prev + 1)))
      }
    })
    // chat wires
    socket.on('chat', (m) => {
      setMessages((prev) => {
        const next = [...prev, m]
        // keep bounded length on client too
        if (next.length > 300) next.splice(0, next.length - 300)
        return next
      })
      // increment unread if widget is closed
      setUnreadCount((prev) => (chatOpenRef.current ? 0 : Math.min(999, prev + 1)))
      // show bubble if chat is closed (don't show own messages)
      if (!chatOpenRef.current && m.userId !== myIdRef.current) {
        setBubbleMessage(m)
        // auto-hide after 4 seconds
        if (bubbleTimeoutRef.current) window.clearTimeout(bubbleTimeoutRef.current)
        bubbleTimeoutRef.current = window.setTimeout(() => {
          setBubbleMessage(null)
        }, 4000)
      }
    })
    // no more chat history on join: save memory and avoid replay

    // clock skew estimate
    const ping = () => {
      const t0 = Date.now()
      socket.emit('ping', { t0 })
    }
    socket.on('pong', ({ t0, t1 }) => {
      const t2 = Date.now()
      const rtt = t2 - t0
      rttRef.current = rtt
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
      if (bubbleTimeoutRef.current) {
        window.clearTimeout(bubbleTimeoutRef.current)
        bubbleTimeoutRef.current = null
      }
    }
  }, [id, wsUrl, wsBasePath])

  // Autoplay on first readiness if room is playing
  useEffect(() => {
    if (isHost) return
    const video = videoRef.current
    if (!video) return
    const tryAuto = () => {
      if (!joinAutoplayArmedRef.current) return
      const s = stateRef.current
      if (!s || !s.isPlaying) return
      if (video.readyState >= 2 && (video as any).paused) {
        joinAutoplayArmedRef.current = false
        lastPlayReqRef.current = performance.now()
        void (video as any)._playerApi?.play()
      }
    }
    const onLoaded = () => tryAuto()
    const onCanPlay = () => tryAuto()
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('canplay', onCanPlay)
    const iv = window.setInterval(tryAuto, 400)
    return () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('canplay', onCanPlay)
      window.clearInterval(iv)
    }
  }, [isHost])

  // keep refs in sync to avoid stale closure in socket handler
  useEffect(() => {
    myIdRef.current = myId
  }, [myId])

  useEffect(() => {
    chatOpenRef.current = chatOpen
    if (chatOpen) {
      setUnreadCount(0)
      setBubbleMessage(null)
      if (bubbleTimeoutRef.current) {
        window.clearTimeout(bubbleTimeoutRef.current)
        bubbleTimeoutRef.current = null
      }
    }
  }, [chatOpen])

  // no-op

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
          const seekThreshold = Math.max(1.2, rttRef.current / 250)
          if (abs > seekThreshold) {
            api.seek(target)
            piRef.current.integral = 0
            lastSeekAtRef.current = performance.now()
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
          ensurePlaybackState(s.isPlaying)
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
        const seekThreshold = Math.max(1.2, rttRef.current / 250)
        if (abs > seekThreshold) {
          api.seek(target)
          piRef.current.integral = 0
          lastSeekAtRef.current = performance.now()
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
        ensurePlaybackState(s.isPlaying)
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

  // Close chat when clicking anywhere outside the chat popup/button
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      // we'll read latest state via ref to avoid stale closure
      ;(handler as any)._open = chatOpen
      if (!(handler as any)._open) return
      const target = e.target as Node | null
      if (!target) return
      if (chatPopupRef.current && chatPopupRef.current.contains(target)) return
      if (chatButtonRef.current && chatButtonRef.current.contains(target)) return
      setChatOpen(false)
    }
    window.addEventListener('pointerdown', handler as any, { passive: true })
    return () => window.removeEventListener('pointerdown', handler as any)
  }, [chatOpen])

  // Host-only: emit controls based on local player actions
  useEffect(() => {
    const video = videoRef.current
    const socket = socketRef.current
    if (!video || !socket) return
    if (!isHost) return

    const handlePlay = () => {
      lastPlayReqRef.current = performance.now()
      socket.emit('play')
    }
    const handlePause = () => {
      lastPauseReqRef.current = performance.now()
      socket.emit('pause', { atMediaTime: video.currentTime || 0 })
    }
    // debounce seeked and ratechange to avoid bursts
    let seekTimer: number | null = null
    let rateTimer: number | null = null
    const handleSeeked = () => {
      if (seekTimer) window.clearTimeout(seekTimer)
      seekTimer = window.setTimeout(() => {
        lastSeekAtRef.current = performance.now()
        socket.emit('seek', { toMediaTime: video.currentTime || 0 })
      }, 120)
    }
    const handleRate = () => {
      if (rateTimer) window.clearTimeout(rateTimer)
      rateTimer = window.setTimeout(() => {
        socket.emit('rate', { playbackRate: video.playbackRate || 1 })
      }, 150)
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('ratechange', handleRate)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('ratechange', handleRate)
      if (seekTimer) window.clearTimeout(seekTimer)
      if (rateTimer) window.clearTimeout(rateTimer)
    }
  }, [isHost])

  const effectiveSrc = state?.src || initialSrc
  const effectiveSubtitles = (state?.subtitles && state.subtitles.length > 0)
    ? state.subtitles
    : []
  const derivedSubtitleUrl = useMemo(() => {
    if (!effectiveSrc) return null
    try {
      const u = new URL(effectiveSrc, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length > 0) parts[parts.length - 1] = 'sub.vtt'
      else parts.push('sub.vtt')
      u.pathname = '/' + parts.join('/')
      return u.toString()
    } catch {
      return null
    }
  }, [effectiveSrc])
  const [subtitleAvailable, setSubtitleAvailable] = useState<boolean>(false)
  useEffect(() => {
    let aborted = false
    setSubtitleAvailable(false)
    if (!derivedSubtitleUrl) return
    ;(async () => {
      try {
        const res = await fetch(derivedSubtitleUrl, { method: 'GET', mode: 'cors', cache: 'no-store' })
        if (!aborted) setSubtitleAvailable(res.ok)
      } catch {
        if (!aborted) setSubtitleAvailable(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [derivedSubtitleUrl])

  return (
    <div className="relative h-dvh w-dvw bg-black">
      {/* Centered player */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={(el) => {
            videoRef.current = (el?.querySelector('video') as HTMLVideoElement) || null
          }}
          className="w-full h-full"
        >
          {effectiveSrc ? (
            <Player
              src={effectiveSrc}
              subtitles={effectiveSubtitles}
              fullBleed
              onControlsVisibilityChange={setControlsVisible}
              canControl={isHost}
              topRightAccessory={
                <VideoStrip socket={socketRef.current} myId={myId} />
              }
              chatAccessory={(
                <div className="relative flex items-center gap-3">
                  <ReactionWidget socket={socketRef.current} myId={myId} />
                  <div className="relative">
                    <button
                      ref={chatButtonRef}
                      className={`relative size-12 rounded-full grid place-items-center text-white border border-white/20 shadow-lg transition-colors ${
                        chatOpen ? 'bg-primary' : 'bg-white/10 hover:bg-white/15 backdrop-blur'
                      }`}
                      aria-label={chatOpen ? 'Hide chat' : unreadCount > 0 ? `${unreadCount} unread messages. Show chat` : 'Show chat'}
                      onClick={() => setChatOpen((v) => !v)}
                    >
                      <MessageSquare className="size-6" />
                      {!chatOpen && unreadCount > 0 ? (
                        <>
                          <span aria-hidden className="absolute -top-1 -right-1 size-5 rounded-full bg-red-500/60 animate-ping" />
                          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 grid place-items-center rounded-full bg-red-500 text-white text-[10px] font-medium ring-2 ring-black/40">
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        </>
                      ) : null}
                    </button>
                    {chatOpen ? (
                      <div
                        ref={chatPopupRef}
                        className="absolute bottom-16 right-0 z-40 w-[min(92vw,360px)] max-h-[70vh] flex flex-col rounded-lg text-white  p-2"
                      >
                        <ChatPanel
                          myId={myId}
                          messages={messages}
                          onSend={(text) => {
                            const s = socketRef.current
                            if (!s) return
                            s.emit('chat:send', { text })
                          }}
                        />
                      </div>
                    ) : null}
                    {!chatOpen && bubbleMessage ? (
                      <div className="absolute bottom-16 right-0 z-40 w-[min(92vw,200px)] animate-[fadeIn_0.3s_ease-out]">
                        <BubbleChat message={bubbleMessage} myId={myId} />
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            />
          ) : (
            <div className="w-full max-w-5xl mx-auto aspect-video grid place-items-center rounded-lg border border-dashed bg-zinc-100">
              <div className="text-zinc-600 text-sm">Waiting for host to set a video…</div>
            </div>
          )}
        </div>
      </div>

      {/* Top gradient & info overlay */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/75 to-transparent transition-opacity duration-200" style={{ opacity: controlsVisible ? 1 : 0 }} />
      <div className={`absolute top-3 left-3 z-20 text-white/95 text-xs md:text-sm transition-opacity duration-200 max-w-[300px] ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className="px-2 py-1 rounded bg-black/35 backdrop-blur-sm ring-1 ring-white/10 pointer-events-auto">
          <div className="font-medium">Room {id}</div>
          <div className="opacity-90">
            <span className="text-white/70">Status:</span> {state ? (state.isPlaying ? 'Playing' : 'Paused') : 'Connecting…'}
          </div>
          {effectiveSrc ? (
            <div className="truncate">
              <span className="text-white/70">Source:</span>{' '}
              <a className="underline" href={effectiveSrc} target="_blank" rel="noreferrer">
                {effectiveSrc}
              </a>
            </div>
          ) : null}
          {subtitleAvailable && derivedSubtitleUrl ? (
            <div className="truncate">
              <span className="text-white/70">Subtitle:</span>{' '}
              <a className="underline" href={derivedSubtitleUrl} target="_blank" rel="noreferrer">
                {derivedSubtitleUrl}
              </a>
            </div>
          ) : null}
        </div>
      </div>

      {/* Debug (bottom-left to avoid chat overlap) */}
      {debugEnabled && debug ? (
        <div className="fixed bottom-3 left-3 text-xs bg-black/70 text-white rounded px-2 py-1 z-20">
          <div>drift: {debug.drift.toFixed(3)}s</div>
          <div>rtt: {debug.rtt}ms</div>
          <div>skew: {debug.skew.toFixed(1)}ms</div>
        </div>
      ) : null}

      {/* Chat is now rendered inside Player via chatAccessory */}
    </div>
  )
}

// Lightweight chat panel, bounded history and minimal re-renders
function ChatPanel({
  myId,
  messages,
  onSend,
}: {
  myId: string
  messages: ChatMessage[]
  onSend: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const pinnedToBottomRef = useRef(true)

  const scrollToBottom = () => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }

  const handleScroll = () => {
    const el = listRef.current
    if (!el) return
    const threshold = 24
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
    pinnedToBottomRef.current = atBottom
  }

  useEffect(() => {
    if (pinnedToBottomRef.current) {
      requestAnimationFrame(scrollToBottom)
    }
  }, [messages])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }, [draft, onSend])

  return (
    <div className="flex flex-col gap-2 rounded-md flex-1">
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-2 space-y-2 rounded max-h-[200px]"
      >
        {messages.map((m) => (
          <MessageRow key={m.id} self={m.userId === myId} isSystem={m.userId === 'system'} name={m.name} text={m.text} ts={m.ts} />
        ))}
      </div>
      <div className="p-2 pt-0 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Message…"
          className="flex-1 h-9 px-3 rounded-md bg-zinc-900/60 text-white placeholder:text-zinc-400 outline-none ring-1 ring-white/10 focus:ring-white/20"
        />
        <Button size="sm" onClick={send} disabled={!draft.trim()} className="backdrop-contrast-30 bg-white/10 hover:bg-white/15 text-white ring-1 ring-white/10">
          Send
        </Button>
      </div>
    </div>
  )
}

const MessageRow = memo(function MessageRow({
  self,
  isSystem,
  name,
  text,
  ts,
}: {
  self: boolean
  isSystem?: boolean
  name: string
  text: string
  ts: number
}) {
  // light time formatting to avoid heavy Intl on each render
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const time = `${hh}:${mm}`

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-white/50 italic px-2 py-1">
          {text}
        </div>
      </div>
    )
  }

  return (
    <div className={`flex ${self ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-md px-2.5 py-1.5 text-sm backdrop-brightness-50`}
      >
        <div className="flex items-center gap-2 mb-0.5 text-[10px] opacity-80">
          <span className="font-medium truncate max-w-40">{self ? 'You' : name}</span>
          <span>{time}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  )
})

// Bubble chat component for showing new messages when chat is closed
function BubbleChat({ message, myId }: { message: ChatMessage; myId: string }) {
  const d = new Date(message.ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const time = `${hh}:${mm}`
  const isSelf = message.userId === myId

  return (
    <div className="rounded-lg backdrop-brightness-50 border border-white/20 shadow-lg p-3 text-white">
      <div className="flex items-center gap-2 mb-1.5 text-xs opacity-90">
        <span className="font-medium truncate max-w-40">{isSelf ? 'You' : message.name}</span>
        <span className="text-white/60">{time}</span>
      </div>
      <div className="text-sm whitespace-pre-wrap break-words">{message.text}</div>
    </div>
  )
}

