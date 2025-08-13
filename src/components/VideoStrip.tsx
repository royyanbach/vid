import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClientSocket } from '@/lib/ws'

type VideoStripProps = {
  socket: ClientSocket | null
  myId: string
}

type PeerConnectionRecord = {
  pc: RTCPeerConnection
  stream: MediaStream
  makingOffer: boolean
  polite: boolean
}

export default function VideoStrip({ socket, myId }: VideoStripProps) {
  const [error, setError] = useState<string | null>(null)
  const [enabled] = useState(true)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, PeerConnectionRecord>>(new Map())
  const [peerIds, setPeerIds] = useState<string[]>([])
  const [, setLocalReady] = useState(false)

  const rtcConfig = useMemo<RTCConfiguration>(() => ({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    bundlePolicy: 'max-bundle',
  }), [])

  // Acquire camera (low resolution) and join signaling
  useEffect(() => {
    let aborted = false
    const start = async () => {
      if (!socket) return
      setError(null)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 320, max: 480 },
            height: { ideal: 180, max: 270 },
            frameRate: { ideal: 10, max: 12 },
            aspectRatio: 16 / 9,
          },
          audio: false,
        })
        if (aborted) return
        localStreamRef.current = stream
        setLocalReady(true)
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
          localVideoRef.current.muted = true
          void localVideoRef.current.play().catch(() => {})
        }
        // Provide a hint to encoders that this is small motion video
        try {
          const vt = stream.getVideoTracks()[0]
          if (vt && 'contentHint' in vt) {
            ;(vt as any).contentHint = 'motion'
          }
        } catch {}
        socket.emit('rtc:join')
      } catch (err) {
        if (!aborted) setError('Camera permission blocked or unavailable')
      }
    }
    if (enabled) start()
    return () => {
      aborted = true
      // stop camera when unmounting or disabled
      const s = localStreamRef.current
      if (s) {
        s.getTracks().forEach((t) => t.stop())
        localStreamRef.current = null
      }
      // close peer connections
      for (const [_id, rec] of peersRef.current) {
        try { rec.pc.close() } catch {}
      }
      peersRef.current.clear()
      setPeerIds([])
      socket?.emit('rtc:leave')
    }
  }, [socket, enabled])

  // Pause sending when tab hidden to save upstream
  useEffect(() => {
    const onVis = () => {
      const s = localStreamRef.current
      if (!s) return
      const enabledNow = document.visibilityState === 'visible'
      for (const t of s.getTracks()) t.enabled = enabledNow
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Signaling wires
  useEffect(() => {
    if (!socket) return
    // tie-breaker retained conceptually but not directly used since we rely on negotiationneeded


    const ensureSenderBitrate = (pc: RTCPeerConnection) => {
      try {
        pc.getSenders().forEach((sender) => {
          if (sender.track && sender.track.kind === 'video') {
            const params = sender.getParameters()
            params.encodings = params.encodings || [{}]
            params.encodings[0].maxBitrate = 80_000 // ~80 kbps target
            ;(params.encodings[0] as any).maxFramerate = 12
            ;(params.encodings[0] as any).scaleResolutionDownBy = 2
            void sender.setParameters(params)
          }
        })
      } catch {}
    }

    const createPeerConnection = (peerId: string): PeerConnectionRecord => {
      const pc = new RTCPeerConnection(rtcConfig)
      const remoteStream = new MediaStream()
      const local = localStreamRef.current
      const polite = !!myId && myId > peerId

      // Always prepare to receive remote video
      try { pc.addTransceiver('video', { direction: 'recvonly' }) } catch {}

      if (local) {
        const vTrack = local.getVideoTracks()[0]
        if (vTrack) {
          // Prefer adding a transceiver with constrained single encoding
          try {
            const tx = pc.addTransceiver(vTrack, {
              direction: 'sendonly',
              streams: [local],
              sendEncodings: [
                {
                  maxBitrate: 80_000,
                  // Some browsers support this non-standard property
                  ...(typeof ({} as any).foo === 'undefined' ? {} : {}),
                  scaleResolutionDownBy: 2,
                },
              ],
            })
            // Prefer low-bitrate codecs (VP9/AV1) if available
            try {
              const caps = RTCRtpSender.getCapabilities('video')
              const codecs = caps?.codecs || []
              const preferred = [...codecs].sort((a: any, b: any) => {
                const prio = (c: any) => (String(c.mimeType || '').includes('AV1') ? 0 : String(c.mimeType || '').includes('VP9') ? 1 : String(c.mimeType || '').includes('VP8') ? 2 : 3)
                return prio(a) - prio(b)
              })
              // Some browsers require only codecs list without RTX duplicates filtered
              const filtered = preferred.filter((c) => !/rtx/i.test(c.mimeType))
              try { (tx as any).setCodecPreferences?.(filtered) } catch {}
            } catch {}
          } catch {
            pc.addTrack(vTrack, local)
          }
        }
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('rtc:ice', { to: peerId, candidate: e.candidate.toJSON() })
      }
      pc.ontrack = (e) => {
        if (e.streams && e.streams[0]) {
          for (const track of e.streams[0].getTracks()) remoteStream.addTrack(track)
        } else if (e.track) {
          remoteStream.addTrack(e.track)
        }
        setPeerIds((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]))
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
          const rec = peersRef.current.get(peerId)
          if (rec) {
            try { rec.pc.close() } catch {}
            peersRef.current.delete(peerId)
            setPeerIds((prev) => prev.filter((id) => id !== peerId))
          }
        }
      }

      const rec: PeerConnectionRecord = { pc, stream: remoteStream, makingOffer: false, polite }
      pc.onnegotiationneeded = async () => {
        try {
          rec.makingOffer = true
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          socket.emit('rtc:offer', { to: peerId, description: offer })
        } catch {
          // ignore
        } finally {
          rec.makingOffer = false
        }
      }
      peersRef.current.set(peerId, rec)
      ensureSenderBitrate(pc)
      return rec
    }

    const handlePeers = async (p: { peers: string[] }) => {
      for (const peerId of p.peers) {
        if (peerId === myId) continue
        if (!peersRef.current.has(peerId)) createPeerConnection(peerId)
        // negotiationneeded will run on either side after tracks/transceivers
      }
    }

    const handleOffer = async (p: { from: string; description: RTCSessionDescriptionInit }) => {
      const peerId = p.from
      const rec = peersRef.current.get(peerId) || createPeerConnection(peerId)
      try {
        const offerCollision = p.description.type === 'offer' && (rec.makingOffer || rec.pc.signalingState !== 'stable')
        if (offerCollision) {
          if (!rec.polite) return
        }
        await rec.pc.setRemoteDescription(p.description)
        const answer = await rec.pc.createAnswer()
        await rec.pc.setLocalDescription(answer)
        socket.emit('rtc:answer', { to: peerId, description: answer })
      } catch {}
    }

    const handleAnswer = async (p: { from: string; description: RTCSessionDescriptionInit }) => {
      const rec = peersRef.current.get(p.from)
      if (!rec) return
      try {
        await rec.pc.setRemoteDescription(p.description)
      } catch {}
    }

    const handleIce = async (p: { from: string; candidate: RTCIceCandidateInit }) => {
      const rec = peersRef.current.get(p.from)
      if (!rec) return
      try {
        await rec.pc.addIceCandidate(p.candidate)
      } catch {}
    }

    const handlePeerJoined = async (p: { peerId: string }) => {
      const peerId = p.peerId
      if (peerId === myId) return
      if (!peersRef.current.has(peerId)) createPeerConnection(peerId)
      // onnegotiationneeded will drive offer from either side
    }

    const handlePeerLeft = (p: { peerId: string }) => {
      const rec = peersRef.current.get(p.peerId)
      if (!rec) return
      try { rec.pc.close() } catch {}
      peersRef.current.delete(p.peerId)
      setPeerIds((prev) => prev.filter((id) => id !== p.peerId))
    }

    socket.on('rtc:peers', handlePeers)
    socket.on('rtc:offer', handleOffer)
    socket.on('rtc:answer', handleAnswer)
    socket.on('rtc:ice', handleIce)
    socket.on('rtc:peer-joined', handlePeerJoined)
    socket.on('rtc:peer-left', handlePeerLeft)

    return () => {
      socket.off('rtc:peers', handlePeers)
      socket.off('rtc:offer', handleOffer)
      socket.off('rtc:answer', handleAnswer)
      socket.off('rtc:ice', handleIce)
      socket.off('rtc:peer-joined', handlePeerJoined)
      socket.off('rtc:peer-left', handlePeerLeft)
    }
  }, [socket, rtcConfig, myId])

  // Suspend camera track when there are no remote peers to save upstream
  useEffect(() => {
    const local = localStreamRef.current
    if (!local) return
    const shouldEnable = peerIds.length > 0 && document.visibilityState === 'visible'
    for (const t of local.getTracks()) t.enabled = shouldEnable
  }, [peerIds])

  // Simple adaptive bitrate: adjust sender params based on outbound stats
  useEffect(() => {
    let iv: number | null = null
    const tick = async () => {
      for (const [_id, rec] of peersRef.current) {
        const pc = rec.pc
        try {
          const stats = await pc.getStats()
          let totalPackets = 0
          let lostPackets = 0
          let rttMs = 0
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              totalPackets += (report.packetsSent as number) || 0
            }
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              lostPackets += (report.packetsLost as number) || 0
              rttMs = Math.max(rttMs, (report.roundTripTime as number) ? (report.roundTripTime as number) * 1000 : 0)
            }
          })
          const lossRatio = totalPackets > 0 ? Math.min(0.2, Math.max(0, lostPackets / totalPackets)) : 0
          const lowBandwidth = lossRatio > 0.02 || rttMs > 350
          for (const sender of pc.getSenders()) {
            if (!sender.track || sender.track.kind !== 'video') continue
            const p = sender.getParameters()
            p.encodings = p.encodings || [{}]
            const enc = p.encodings[0]
            const currentBr = typeof enc.maxBitrate === 'number' ? enc.maxBitrate : 80_000
            let nextBr = currentBr
            let nextScale = typeof enc.scaleResolutionDownBy === 'number' ? enc.scaleResolutionDownBy : 2
            if (lowBandwidth) {
              nextBr = Math.max(40_000, Math.floor(currentBr * 0.8))
              nextScale = Math.min(4, nextScale + 0.25)
            } else {
              nextBr = Math.min(120_000, Math.floor(currentBr * 1.1))
              nextScale = Math.max(1, nextScale - 0.1)
            }
            if (nextBr !== currentBr || nextScale !== enc.scaleResolutionDownBy) {
              enc.maxBitrate = nextBr
              enc.scaleResolutionDownBy = nextScale
              try { await sender.setParameters(p) } catch {}
            }
          }
        } catch {}
      }
    }
    iv = window.setInterval(tick, 2000)
    return () => { if (iv) window.clearInterval(iv) }
  }, [])

  // For each peer id, render its stream by id from ref map
  const remoteTiles = peerIds.slice(0, 4).map((id) => (
    <PeerVideo key={id} peerId={id} getStream={() => peersRef.current.get(id)?.stream || null} label={id === myId ? 'You' : id.slice(0, 4)} />
  ))

  const extraCount = Math.max(0, peerIds.length - 4)

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center justify-end gap-2 flex-wrap max-w-[60vw]">
        <div className="relative w-28 h-20 rounded-md overflow-hidden ring-1 ring-white/15 bg-black/40">
          <video ref={localVideoRef} className="w-full h-full object-cover" playsInline muted />
          <div className="absolute bottom-0 left-0 right-0 text-[10px] px-1 py-0.5 bg-black/40 text-white">You</div>
        </div>
        {remoteTiles}
        {extraCount > 0 ? (
          <div className="w-28 h-20 grid place-items-center rounded-md ring-1 ring-white/15 bg-black/40 text-white text-xs">+{extraCount}</div>
        ) : null}
      </div>
      {error ? <div className="text-[11px] text-red-300/90 bg-red-900/30 px-2 py-1 rounded">{error}</div> : null}
    </div>
  )
}

function PeerVideo({ peerId, getStream, label }: { peerId: string; getStream: () => MediaStream | null; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const s = getStream()
    if (s) {
      el.srcObject = s
      void el.play().catch(() => {})
    }
    // only re-run when stream identity might have changed
  }, [getStream, peerId])
  return (
    <div className="relative w-28 h-20 rounded-md overflow-hidden ring-1 ring-white/15 bg-black/40">
      <video ref={ref} className="w-full h-full object-cover" playsInline />
      <div className="absolute bottom-0 left-0 right-0 text-[10px] px-1 py-0.5 bg-black/40 text-white truncate">{label}</div>
    </div>
  )
}


