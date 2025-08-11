import { Link, createFileRoute, useParams } from '@tanstack/react-router'
import Player from '@/components/Player'

export const Route = createFileRoute('/room/$id')({
  component: RoomPage,
})

function RoomPage() {
  const { id } = useParams({ from: '/room/$id' })
  return (
    <div className="p-4 md:p-8 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Room {id}</h1>
        <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
          Back Home
        </Link>
      </div>

      <Player />

      <div className="text-sm text-zinc-500">
        This is a placeholder room view. Realtime sync, presence, and chat will be added next.
      </div>
    </div>
  )
}

