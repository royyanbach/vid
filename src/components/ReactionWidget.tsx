import { useEffect, useRef, useState } from 'react'
import type { ClientSocket } from '@/lib/ws'

type Burst = {
  id: number
  emoji: string
  dx: number
  dy: number
  durationMs: number
  sizeRem: number
}

const REACTIONS = ['😱', '😭', '😂', '🔥', '🤤'] as const

export default function ReactionWidget({ socket, myId }: { socket: ClientSocket | null; myId?: string }) {
  const [open, setOpen] = useState(false)
  const [bursts, setBursts] = useState<Burst[]>([])
  const idRef = useRef(0)
  const closeTimerRef = useRef<number | null>(null)

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const openNow = () => {
    clearCloseTimer()
    setOpen(true)
  }

  const scheduleClose = () => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 160)
  }

  const spawn = (emoji: string) => {
    const id = ++idRef.current
    // Randomize trajectory and size a bit for organic feel
    const dx = -40 - Math.random() * 120 // drift left
    const dy = -200 - Math.random() * 160 // float up
    const durationMs = 2200 + Math.floor(Math.random() * 900)
    const sizeRem = 2.2 + Math.random() * 1.2
    setBursts((prev) => [...prev, { id, emoji, dx, dy, durationMs, sizeRem }])
  }

  // Listen for reactions from others
  useEffect(() => {
    if (!socket) return
    const handler = (e: { id: string; userId: string; emoji: string; ts: number }) => {
      // Ignore our own echo if the server happens to send it to us
      if (myId && e.userId === myId) return
      spawn(e.emoji)
    }
    socket.on('reaction', handler)
    return () => {
      socket.off('reaction', handler as any)
    }
  }, [socket, myId])

  return (
    <div className="relative select-none" onMouseEnter={openNow} onMouseLeave={scheduleClose}>
      {/* Floating emojis overlay (anchored to this widget) */}
      <div className="pointer-events-none absolute -bottom-1 -right-1">
        {bursts.map((b) => (
          <div
            key={b.id}
            className="reaction-float"
            style={{
              ['--dx' as any]: `${b.dx}px`,
              ['--dy' as any]: `${b.dy}px`,
              ['--dur' as any]: `${b.durationMs}ms`,
            }}
            onAnimationEnd={() => setBursts((prev) => prev.filter((x) => x.id !== b.id))}
          >
            <div
              className="drop-shadow-[0_6px_16px_rgba(0,0,0,0.45)]"
              style={{ fontSize: `${b.sizeRem}rem`, lineHeight: 1 }}
            >
              {b.emoji}
            </div>
          </div>
        ))}
      </div>

      {/* Main reaction button */}
      <button
        className="relative size-12 rounded-full grid place-items-center text-white border border-white/20 shadow-lg transition-colors bg-white/10 hover:bg-white/15"
        aria-label="Send reaction"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const emoji = '❤️'
          spawn(emoji)
          try {
            socket?.emit('reaction:send', { emoji })
          } catch {}
        }}
      >
        <span className="text-2xl" aria-hidden>
          ❤️
        </span>
      </button>

      {/* Hover popover with additional options */}
      <div
        className={`absolute bottom-14 right-0 z-50 rounded-lg bg-zinc-950/85 text-white backdrop-blur-sm p-1 ring-1 ring-white/10 shadow-lg transition-all ${
          open ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none'
        }`}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
      >
        <div className="flex items-center gap-1.5">
          {REACTIONS.map((r) => (
            <button
              key={r}
              className="size-10 grid place-items-center rounded-full bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                spawn(r)
                try {
                  socket?.emit('reaction:send', { emoji: r })
                } catch {}
              }}
              aria-label={`React with ${r}`}
            >
              <span className="text-xl" aria-hidden>
                {r}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}


