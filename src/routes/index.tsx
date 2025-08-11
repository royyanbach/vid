import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import logo from '../logo.svg'
import { Button } from '@/components/ui/button'
import { useCallback } from 'react'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  const navigate = useNavigate()
  const createRoom = useCallback(() => {
    // For Phase 1 MVP we generate a client-side id; server will replace this later
    const id = Math.random().toString(36).slice(2, 8)
    navigate({ to: '/room/$id', params: { id } })
  }, [navigate])

  return (
    <main className="min-h-[calc(100dvh-56px)] grid place-items-center bg-gradient-to-br from-white to-zinc-50">
      <div className="max-w-2xl w-full p-6 text-center">
        <img src={logo} className="mx-auto h-24 mb-4 animate-[spin_20s_linear_infinite]" alt="logo" />
        <h1 className="text-3xl font-semibold tracking-tight">Watch Together</h1>
        <p className="text-zinc-600 mt-2">Host your own HLS video and sync playback with friends.</p>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Button onClick={createRoom}>Create Room</Button>
          <Link to="/player" className="text-primary underline-offset-4 hover:underline">
            Try Player
          </Link>
        </div>
      </div>
    </main>
  )
}
