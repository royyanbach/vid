import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { useCallback, useMemo, useState } from 'react'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const isValidUrl = useMemo(() => {
    if (!input.trim()) return false
    try {
      // Accept http(s) and blob URLs; basic validation
      const u = new URL(input.trim())
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'blob:'
    } catch {
      return false
    }
  }, [input])

  const createRoom = useCallback(() => {
    if (!isValidUrl) {
      setError('Enter a valid video URL (HLS .m3u8 or MP4).')
      return
    }
    setError(null)
    const id = Math.random().toString(36).slice(2, 8)
    try {
      localStorage.setItem(`room:${id}:src`, input.trim())
    } catch {}
    navigate({ to: '/room/$id', params: { id } })
  }, [navigate, input, isValidUrl])

  return (
    <main className="min-h-dvh grid place-items-center bg-gradient-to-b from-white to-zinc-50 px-4">
      <div className="w-full max-w-3xl">
        <div className="flex flex-col items-center gap-6">
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-center">Watch Together</h1>
          <div className="w-full flex items-center gap-2 rounded-2xl border border-zinc-200 bg-white shadow-sm px-4 py-3 md:py-4">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createRoom()
              }}
              placeholder="Paste an HLS (.m3u8) or MP4 URL"
              className="flex-1 bg-transparent outline-none text-base md:text-lg placeholder:text-zinc-400"
            />
            <Button size="lg" onClick={createRoom} disabled={!isValidUrl}>
              Create room
            </Button>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
      </div>
    </main>
  )
}
