import { Link, useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

export default function Header() {
  const navigate = useNavigate()
  const handleNewRoom = () => {
    const id = Math.random().toString(36).slice(2, 8)
    navigate({ to: '/room/$id', params: { id } })
  }
  return (
    <header className="px-4 h-14 flex items-center bg-white border-b border-zinc-200">
      <nav className="w-full flex items-center gap-4 text-sm">
        <Link to="/" className="font-semibold">Home</Link>
        <Link to="/player" className="text-zinc-600 hover:text-zinc-900">Player</Link>
        <Link to="/room/test" className="text-zinc-600 hover:text-zinc-900">Test Room</Link>
        <div className="ml-auto">
          <Button size="sm" variant="secondary" onClick={handleNewRoom}>
            New Room
          </Button>
        </div>
      </nav>
    </header>
  )
}
