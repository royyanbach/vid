import { createFileRoute } from '@tanstack/react-router'
import Player from '@/components/Player'

export const Route = createFileRoute('/room/test')({
  component: TestRoomPage,
})

function TestRoomPage() {
  const TEST_URL =
    'https://s-rb-prod.b-cdn.net/D21%20FUN%20La%20la%20land%202016%20mp4.mp4'

  return (
    <div className="p-4 md:p-8 space-y-4">
      <h1 className="text-2xl font-semibold">Test Room</h1>
      <Player src={TEST_URL} mutedByDefault={false} />
      <p className="text-sm text-zinc-500">
        Playing hardcoded MP4 for testing.
      </p>
    </div>
  )
}

