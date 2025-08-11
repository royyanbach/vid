import Hls from 'hls.js'
import { useEffect, useMemo, useRef, useState } from 'react'

type PlayerProps = {
  src?: string
  poster?: string
  mutedByDefault?: boolean
  startTime?: number
}

function formatTime(totalSeconds: number): string {
  if (!isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const two = (n: number) => n.toString().padStart(2, '0')
  return hours > 0
    ? `${hours}:${two(minutes)}:${two(seconds)}`
    : `${minutes}:${two(seconds)}`
}

export default function Player({
  src,
  poster,
  mutedByDefault = true,
  startTime = 0,
}: PlayerProps) {
  const defaultSrc = useMemo(() => {
    return (
      src ||
      (import.meta.env.VITE_HLS_URL as string | undefined) ||
      // Public test stream
      'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    )
  }, [src])

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(mutedByDefault)
  const [volume, setVolume] = useState(0.7)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Load HLS source
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setErrorMessage(null)

    const isHlsSource = /\.m3u8($|\?)/i.test(defaultSrc)
    if (!isHlsSource) {
      // MP4 or other progressive source: load directly
      video.src = defaultSrc
      video.load()
    } else {
      // HLS source: prefer native first
      const canUseNative = video.canPlayType('application/vnd.apple.mpegurl')
      if (canUseNative) {
        video.src = defaultSrc
        video.load()
      } else if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          backBufferLength: 90,
        })
        hlsRef.current = hls
        hls.attachMedia(video)
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          hls.loadSource(defaultSrc)
        })
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data?.fatal) {
            setErrorMessage('Failed to load video stream. Please check the URL or CORS settings.')
          }
        })
      } else {
        setErrorMessage('HLS is not supported in this browser')
      }
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [defaultSrc])

  // Set initial params and listeners
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.muted = isMuted
    video.volume = volume

    const onLoadedMetadata = () => {
      setDuration(video.duration || 0)
      if (startTime > 0 && isFinite(startTime)) {
        try {
          video.currentTime = Math.max(0, Math.min(startTime, video.duration || startTime))
        } catch {}
      }
    }
    const onTimeUpdate = () => setCurrent(video.currentTime || 0)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onError = () => setErrorMessage('Playback error. Please try again.')

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
    }
  }, [isMuted, volume, startTime])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch(() => {
        setErrorMessage('Autoplay is blocked. Click play to start.')
      })
    } else {
      video.pause()
    }
  }

  const handleSeek = (value: number) => {
    const video = videoRef.current
    if (!video || !isFinite(value)) return
    video.currentTime = value
  }

  const handleMuteToggle = () => {
    const video = videoRef.current
    if (!video) return
    const next = !isMuted
    video.muted = next
    setIsMuted(next)
  }

  const handleVolume = (value: number) => {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.min(1, Math.max(0, value))
    video.volume = clamped
    setVolume(clamped)
    if (clamped > 0 && isMuted) {
      video.muted = false
      setIsMuted(false)
    }
  }

  const enterPip = async () => {
    const video = videoRef.current
    // @ts-expect-error newer browsers
    if (video && document.pictureInPictureEnabled && !video.disablePictureInPicture) {
      try {
        // @ts-expect-error pip
        await video.requestPictureInPicture()
      } catch {}
    }
  }

  const enterFullscreen = async () => {
    const container = videoRef.current?.parentElement
    if (!container) return
    const anyEl = container as any
    try {
      if (anyEl.requestFullscreen) await anyEl.requestFullscreen()
      else if (anyEl.webkitRequestFullscreen) await anyEl.webkitRequestFullscreen()
    } catch {}
  }

  return (
    <div className="w-full max-w-5xl mx-auto rounded-lg overflow-hidden bg-black/95 shadow-lg">
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          className="size-full"
          poster={poster}
          playsInline
          controls={false}
          preload="metadata"
        />

        {errorMessage ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6 bg-black/70 text-white">
            <div className="space-y-2">
              <div className="text-lg font-semibold">{errorMessage}</div>
              <div className="text-sm opacity-80">Check the HLS URL, CORS, or try another browser.</div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Controls */}
      <div className="grid gap-3 p-3 text-white bg-gradient-to-b from-zinc-900 to-zinc-950">
        <div className="flex items-center gap-3">
          <button
            className="px-3 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>

          <button
            className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700"
            onClick={() => handleSeek(Math.max(0, current - 10))}
          >
            -10s
          </button>
          <button
            className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700"
            onClick={() => handleSeek(Math.min(duration || current + 10, current + 10))}
          >
            +10s
          </button>

          <button
            className="ml-auto px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700"
            onClick={enterPip}
          >
            PiP
          </button>
          <button
            className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700"
            onClick={enterFullscreen}
          >
            Fullscreen
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="tabular-nums text-xs min-w-12 text-zinc-300">{formatTime(current)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={isFinite(current) ? current : 0}
            onChange={(e) => handleSeek(parseFloat(e.target.value))}
            className="flex-1 accent-primary h-1.5 rounded-full bg-zinc-800"
            aria-label="Seek"
          />
          <span className="tabular-nums text-xs min-w-12 text-zinc-300">{formatTime(duration)}</span>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700"
            onClick={handleMuteToggle}
          >
            {isMuted || volume === 0 ? 'Unmute' : 'Mute'}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => handleVolume(parseFloat(e.target.value))}
            className="w-40 accent-primary h-1.5 rounded-full bg-zinc-800"
            aria-label="Volume"
          />
        </div>
      </div>
    </div>
  )
}


