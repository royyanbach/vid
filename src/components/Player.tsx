import Hls from 'hls.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  SkipBack,
  SkipForward,
  PictureInPicture,
  Maximize,
  Minimize,
  Captions,
} from 'lucide-react'

type PlayerProps = {
  src?: string
  poster?: string
  mutedByDefault?: boolean
  startTime?: number
  subtitles?: Array<{
    src: string
    label: string
    lang?: string
    default?: boolean
  }>
  fullBleed?: boolean
  onControlsVisibilityChange?: (visible: boolean) => void
  chatAccessory?: React.ReactNode
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

async function loadMpegtsLibrary(): Promise<any | null> {
  // Load from global or inject from CDN to avoid bundler install-time dependencies
  if (typeof window === 'undefined') return null
  if ((window as any).mpegts) return (window as any).mpegts
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    // Pin a known stable version to avoid unexpected breaking changes
    script.src = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.min.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load mpegts.js'))
    document.head.appendChild(script)
  })
  return (window as any).mpegts ?? null
}

export default function Player({
  src,
  poster,
  mutedByDefault = true,
  startTime = 0,
  subtitles = [],
  fullBleed = false,
  onControlsVisibilityChange,
  chatAccessory,
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
  const mpegtsRef = useRef<any | null>(null)
  const lastTimeUpdateRef = useRef(0)
  const hideControlsTimerRef = useRef<number | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(mutedByDefault)
  const [volume, setVolume] = useState(0.7)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [areControlsVisible, setAreControlsVisible] = useState(true)
  const [isControlsHovered, setIsControlsHovered] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [areCaptionsVisible, setAreCaptionsVisible] = useState(true)
  const cueOriginalLineRef = useRef<WeakMap<any, any>>(new WeakMap())
  const HIDE_DELAY_MS = 500

  // Derive a default subtitle from the same directory: /sub.vtt
  const effectiveSubtitles = useMemo(() => {
    if (subtitles && subtitles.length > 0) return subtitles
    try {
      const u = new URL(defaultSrc, typeof window !== 'undefined' ? window.location.href : 'http://localhost')
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length > 0) parts[parts.length - 1] = 'sub.vtt'
      else parts.push('sub.vtt')
      u.pathname = '/' + parts.join('/')
      return [{ src: u.toString(), label: 'Subtitles', lang: 'en', default: true }]
    } catch {
      return []
    }
  }, [defaultSrc, subtitles])

  console.log('effectiveSubtitles', effectiveSubtitles)

  // No overlay renderer: keep behavior simple and fail-safe

  // Load media source
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setErrorMessage(null)

    const isHlsSource = /\.m3u8($|\?)/i.test(defaultSrc)
    const isTsSource = /\.ts($|\?)/i.test(defaultSrc)

    ;(async () => {
      // Clean up any previous instances before loading a new one
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      if (mpegtsRef.current) {
        try {
          mpegtsRef.current.detachMediaElement()
        } catch {}
        try {
          mpegtsRef.current.destroy()
        } catch {}
        mpegtsRef.current = null
      }

      if (isTsSource) {
        try {
          const mpegts = await loadMpegtsLibrary()
          if (mpegts && mpegts.isSupported?.()) {
            const player = mpegts.createPlayer({
              type: 'mpegts',
              url: defaultSrc,
            })
            mpegtsRef.current = player
            player.attachMediaElement(video)
            player.load()
          } else {
            setErrorMessage('MPEG-TS is not supported in this browser')
          }
        } catch (err) {
          setErrorMessage('Failed to initialize MPEG-TS playback')
        }
        return
      }

      if (!isHlsSource) {
        video.src = defaultSrc
        video.load()
        return
      }

      // HLS: prefer native first
      const canUseNative = video.canPlayType('application/vnd.apple.mpegurl')
      if (canUseNative) {
        video.src = defaultSrc
        video.load()
        return
      }

      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          backBufferLength: 90,
          capLevelToPlayerSize: true,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
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
        return
      }

      setErrorMessage('HLS is not supported in this browser')
    })()

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      if (mpegtsRef.current) {
        try {
          mpegtsRef.current.detachMediaElement()
        } catch {}
        try {
          mpegtsRef.current.destroy()
        } catch {}
        mpegtsRef.current = null
      }
    }
  }, [defaultSrc])

  // Set initial params and listeners
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.muted = isMuted
    video.volume = volume
    try {
      ;(video as any).preservesPitch = false
      ;(video as any).mozPreservesPitch = false
      ;(video as any).webkitPreservesPitch = false
    } catch {}

    const onLoadedMetadata = () => {
      setDuration(video.duration || 0)
      if (startTime > 0 && isFinite(startTime)) {
        try {
          video.currentTime = Math.max(0, Math.min(startTime, video.duration || startTime))
        } catch {}
      }
      // No-op: captions auto-enabled in a separate effect
      try {
        // touch textTracks to encourage initialization
        void video.textTracks?.length
      } catch {}
    }
    const onTimeUpdate = () => {
      const now = performance.now()
      if (now - lastTimeUpdateRef.current >= 200) {
        lastTimeUpdateRef.current = now
        setCurrent(video.currentTime || 0)
      }
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => {
      setIsPlaying(false)
      setCurrent(video.currentTime || 0)
    }
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

  // Manage captions visibility (defaults to on). Re-applies when tracks attach.
  useEffect(() => {
    const apply = () => {
      const video = videoRef.current
      if (!video) return
      try {
        const tracks = video.textTracks
        if (!tracks || tracks.length === 0) {
          setTimeout(apply, 50)
          return
        }
        for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled'
        if (areCaptionsVisible && tracks.length > 0) tracks[0].mode = 'showing'
      } catch {}
    }
    const id = window.setTimeout(apply, 0)
    return () => window.clearTimeout(id)
  }, [effectiveSubtitles, defaultSrc, areCaptionsVisible])

  const adjustCueLines = (offsetActive: boolean) => {
    const video = videoRef.current
    if (!video) return
    try {
      const tracks = video.textTracks
      if (!tracks || tracks.length === 0) return
      for (let i = 0; i < tracks.length; i++) {
        const cues = tracks[i].cues
        if (!cues) continue
        for (let j = 0; j < cues.length; j++) {
          const cue: any = cues[j]
          if (!cue) continue
          if (offsetActive) {
            if (!cueOriginalLineRef.current.has(cue)) cueOriginalLineRef.current.set(cue, cue.line)
            try {
              cue.line = -6 // raise about 6 lines above the bottom to clear the panel
            } catch {}
          } else {
            if (cueOriginalLineRef.current.has(cue)) {
              const orig = cueOriginalLineRef.current.get(cue)
              try {
                cue.line = orig ?? 'auto'
              } catch {}
            }
          }
        }
      }
    } catch {}
  }

  // Reposition captions above the control panel when it is visible
  useEffect(() => {
    // slight delay to ensure cues are available
    const id = window.setTimeout(() => adjustCueLines(areControlsVisible), 0)
    return () => window.clearTimeout(id)
  }, [areControlsVisible, effectiveSubtitles, defaultSrc])

  // Notify parent about controls visibility changes
  useEffect(() => {
    onControlsVisibilityChange?.(areControlsVisible)
  }, [areControlsVisible, onControlsVisibilityChange])

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

  // expose imperative API via DOM dataset for simple external control (MVP)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const api = {
      play: () => void video.play(),
      pause: () => video.pause(),
      seek: (to: number) => {
        try {
          video.currentTime = Math.max(0, to)
        } catch {}
      },
      setRate: (r: number) => {
        try {
          video.playbackRate = Math.max(0.25, Math.min(4, r))
        } catch {}
      },
      getCurrentTime: () => video.currentTime || 0,
    }
    ;(video as any)._playerApi = api
    return () => {
      try {
        delete (video as any)._playerApi
      } catch {}
    }
  }, [])

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
    if (video && document.pictureInPictureEnabled && !video.disablePictureInPicture) {
      try {
        await video.requestPictureInPicture()
      } catch {}
    }
  }

  const toggleFullscreen = async () => {
    const container = videoRef.current?.parentElement
    if (!container) return
    const anyEl = container as any
    try {
      if (!document.fullscreenElement) {
        if (anyEl.requestFullscreen) await anyEl.requestFullscreen()
        else if (anyEl.webkitRequestFullscreen) await anyEl.webkitRequestFullscreen()
      } else {
        if (document.exitFullscreen) await document.exitFullscreen()
        else if ((document as any).webkitExitFullscreen) await (document as any).webkitExitFullscreen()
      }
    } catch {}
  }

  // Track fullscreen state
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const clearHideTimer = () => {
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current)
      hideControlsTimerRef.current = null
    }
  }

  const scheduleHide = () => {
    clearHideTimer()
    if (!isPlaying || isControlsHovered) return
    hideControlsTimerRef.current = window.setTimeout(() => {
      setAreControlsVisible(false)
    }, HIDE_DELAY_MS)
  }

  // Keep controls visible when not playing; schedule hide when playback starts
  useEffect(() => {
    if (!isPlaying) {
      setAreControlsVisible(true)
      clearHideTimer()
    } else {
      scheduleHide()
    }
    return () => clearHideTimer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying])

  const revealControls = () => {
    setAreControlsVisible(true)
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current)
      hideControlsTimerRef.current = null
    }
  }

  const handleContainerMouseMove = () => {
    revealControls()
    scheduleHide()
  }

  const toggleCaptions = () => setAreCaptionsVisible((v) => !v)

  const volumeIcon = () => {
    if (isMuted || volume === 0) return <VolumeX className="size-5" />
    if (volume < 0.5) return <Volume1 className="size-5" />
    return <Volume2 className="size-5" />
  }

  return (
    <div className={fullBleed ? 'w-full h-full overflow-hidden bg-black' : 'w-full max-w-5xl mx-auto rounded-lg overflow-hidden bg-black/95 shadow-lg'}>
      <div
        className={`${fullBleed ? 'relative w-full h-full bg-black' : 'relative aspect-video bg-black'} ${isPlaying && !areControlsVisible ? 'cursor-none' : ''}`}
        onMouseMove={handleContainerMouseMove}
        onDoubleClick={toggleFullscreen}
        onClick={() => {
          // clicking the surface toggles play when controls are hidden
          if (!areControlsVisible) togglePlay()
        }}
      >
        <video
          ref={videoRef}
          className={fullBleed ? 'absolute inset-0 w-full h-full object-contain bg-black' : 'size-full'}
          poster={poster}
          playsInline
          controls={false}
          preload="metadata"
          crossOrigin="anonymous"
          onClick={(e) => {
            // prevent video from stopping event propagation above when controls are visible
            if (areControlsVisible) e.stopPropagation()
          }}
        >
          {effectiveSubtitles.map((t, i) => (
            // Browsers only support WebVTT natively. Ensure your subtitle files are .vtt
            <track
              // eslint-disable-next-line react/no-array-index-key
              key={`${t.label}-${i}`}
              kind="captions"
              src={t.src}
              label={t.label}
              srcLang={t.lang || 'en'}
              default={Boolean(t.default)}
            />
          ))}
        </video>

        {errorMessage ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6 bg-black/70 text-white">
            <div className="space-y-2">
              <div className="text-lg font-semibold">{errorMessage}</div>
              <div className="text-sm opacity-80">Check the HLS URL, CORS, or try another browser.</div>
            </div>
          </div>
        ) : null}

        {/* Center Play/Pause overlay */}
        {!isPlaying ? (
          <button
            className="absolute inset-0 m-auto size-16 rounded-full bg-white/10 ring-1 ring-white/20 backdrop-blur-sm text-white flex items-center justify-center hover:bg-white/15 transition"
            onClick={(e) => {
              e.stopPropagation()
              togglePlay()
            }}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="size-7" /> : <Play className="size-7" />}
          </button>
        ) : null}

        {/* Top gradient for subtle polish */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/60 to-transparent transition-opacity duration-200 ${areControlsVisible ? 'opacity-100' : 'opacity-0'}`}
        />

        {/* Bottom bar: controls (auto-hide) + chat accessory (always visible) */}
        <div className="absolute inset-x-0 bottom-0 p-3 text-white flex items-end gap-3">
          {/* Controls block with gradient background, auto-hide */}
          <div
            className={`flex-1 transition-opacity duration-200 ${areControlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            onMouseEnter={() => setIsControlsHovered(true)}
            onMouseLeave={() => setIsControlsHovered(false)}
          >
            <div className="rounded-md bg-gradient-to-t from-black/80 to-black/20 backdrop-blur-sm ring-1 ring-white/10 p-2">
              {/* Seek bar */}
              <div className="flex items-center gap-3 px-2">
                <span className="tabular-nums text-[11px] min-w-12 text-zinc-200">{formatTime(current)}</span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={0.05}
                  value={isFinite(current) ? current : 0}
                  onChange={(e) => handleSeek(parseFloat(e.target.value))}
                  onInput={revealControls}
                  className="flex-1 accent-primary h-1.5 rounded-full bg-white/20"
                  aria-label="Seek"
                />
                <span className="tabular-nums text-[11px] min-w-12 text-zinc-200">{formatTime(duration)}</span>
              </div>

              {/* Buttons Row */}
              <div className="mt-2 flex items-center gap-2 px-1">
                <button
                  className="size-8 grid place-items-center rounded bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
                  onClick={togglePlay}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="size-5" /> : <Play className="size-5" />}
                </button>
                <button
                  className="size-8 grid place-items-center rounded bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
                  onClick={() => handleSeek(Math.max(0, current - 10))}
                  aria-label="Seek backward 10 seconds"
                >
                  <SkipBack className="size-5" />
                </button>
                <button
                  className="size-8 grid place-items-center rounded bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
                  onClick={() => handleSeek(Math.min(duration || current + 10, current + 10))}
                  aria-label="Seek forward 10 seconds"
                >
                  <SkipForward className="size-5" />
                </button>

                {/* Volume */}
                <div className="ml-1 flex items-center gap-2">
                  <button
                    className="size-8 grid place-items-center rounded bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
                    onClick={handleMuteToggle}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {volumeIcon()}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={(e) => handleVolume(parseFloat(e.target.value))}
                    onInput={revealControls}
                    className="w-28 accent-primary h-1.5 rounded-full bg-white/20"
                    aria-label="Volume"
                  />
                </div>

                {/* Right side actions */}
                <div className="ml-auto flex items-center gap-2">
                  <button
                    className={`size-8 grid place-items-center rounded ring-1 ring-white/10 ${areCaptionsVisible ? 'bg-white/20 hover:bg-white/25' : 'bg-white/10 hover:bg-white/15'}`}
                    onClick={toggleCaptions}
                    aria-label="Toggle captions"
                  >
                    <Captions className="size-5" />
                  </button>
                  <button
                    className="size-8 grid place-items-center rounded bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
                    onClick={enterPip}
                    aria-label="Picture in Picture"
                  >
                    <PictureInPicture className="size-5" />
                  </button>
                  <button
                    className="size-8 grid place-items-center rounded bg-white/10 hover:bg-white/15 ring-1 ring-white/10"
                    onClick={toggleFullscreen}
                    aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                  >
                    {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Chat accessory: stays visible */}
          {chatAccessory ? (
            <div className="shrink-0">
              {chatAccessory}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}


