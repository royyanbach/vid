import { createFileRoute } from '@tanstack/react-router'
import Player from '@/components/Player'

export const Route = createFileRoute('/player')({
  component: PlayerPage,
})

function PlayerPage() {
  return (
    <div className="p-4 md:p-8">
      <h1 className="text-2xl font-semibold mb-4">Player</h1>
      <Player />
      <p className="mt-3 text-sm text-zinc-500">
        Source can be configured via <code>VITE_HLS_URL</code> in your environment.
      </p>
    </div>
  )
}

