# Goal & Scope

Build a Teleparty‑style “watch together” web app where you host your own video, users join a room, and playback stays synchronized with chat/reactions. Start from a simple static UI served from S3+CDN, then layer in realtime sync, presence, and security.

---

# Non‑Goals (for MVP)

* No peer‑to‑peer video delivery (we use HTTP HLS via CDN, not WebRTC media).
* No strong DRM for MVP (tokenized HLS URLs are enough initially).
* No account system; rooms may be anonymous with temporary names (add SSO later).

---

# System Overview

**Frontend**: React app (can be static) → built artifacts to S3 → served via CDN (CloudFront/Cloudflare). Plays HLS with `hls.js`.
**Video**: Bunny Stream transcodes MP4 → HLS manifests/segments on Bunny CDN (optional custom hostname).
**Realtime**: WebSocket service (Node + socket.io or ws). Authoritative room timeline. Optionally Redis for scale.
**Storage**: Postgres (rooms, messages) – optional in MVP; Redis for ephemeral state.

---

# Phase 0 — Static Hosting & Basic Player UI (No Sync)

**Objective**: Ship a static React page that loads an HLS video from Bunny using a direct HLS URL.

## Functional Requirements

* User can open `/player` and play/pause/seek a single video.
* HLS playback works across modern browsers; Safari uses native HLS.
* Controls: Play/Pause, Seek bar, Current time/Duration, Volume, Mute.
* Error handling: friendly message if the stream URL is invalid or blocked (CORS).

## Technical Requirements

* **Hosting**: S3 bucket with static site hosting disabled (use as CDN origin, not website endpoint). CDN in front (CloudFront or Cloudflare) with:

  * Origin: S3 bucket (private) + Origin Access (OAI/OAC) OR public bucket for MVP.
  * Default behavior caches `index.html` with low TTL (e.g., 0–60s) and static assets with long TTLs.
  * Gzip/Brotli enabled.
* **Build**: React app built to `/dist` or `/build` with cache‑busting filenames.
* **Env Config**: `.env` holding `VITE_HLS_URL` (or equivalent) and `VITE_WS_URL` (placeholder for next phases).
* **CORS**: Ensure Bunny HLS host allows cross‑origin range requests for segments.
* **Autoplay**: Respect browser policies – initially require user gesture to start audio; allow muted autoplay toggle.

## Acceptance Criteria

* Video plays on: Chrome (desktop/mobile), Safari (iOS/macOS), Firefox, Edge.
* Segment requests succeed (206 partial content) with no CORS errors in DevTools.
* Lighthouse performance ≥ 90 for static page on desktop.

---

# Phase 1 — Rooms & Routing (Still No Sync)

**Objective**: Enable deep links like `/room/:id` and room creation UI.

## Functional Requirements

* Landing page with “Create Room” → navigates to `/room/:id`.
* Room view shows the player and a read‑only room identifier; no realtime yet.
* Optional: room title and video selection dropdown (admin sets HLS URL).

## Technical Requirements

* Client‑side routing (React Router/Next.js) with dynamic param.
* **Room creation**: Simple serverless function (or minimal Node API) that:

  * Generates `roomId` (e.g., nanoid) and persists `src` (HLS URL) + `ownerId` (temporary).
  * Returns room JSON to client.
* **Tokenized video** (optional now): prepare to fetch a short‑lived signed URL for Bunny Stream via API instead of hardcoding HLS URL in the client.

## Acceptance Criteria

* Hard refresh on `/room/:id` loads the right video and metadata.
* Copy/paste URL opens the same room across devices (but playback is independent for now).

---

# Phase 2 — Realtime Sync MVP (Play/Pause/Seek)

**Objective**: Synchronize playback across clients with a server‑authoritative timeline.

## Functional Requirements

* When host clicks Play/Pause/Seek, all clients reflect the change within \~300ms.
* Late joiners land near the current moment without manual scrubbing.
* Manual seeks by non‑hosts are ignored (configurable).

## Sync Model

* Server maintains room state:

  ```
  { isPlaying: boolean,
    baseMediaTime: number,     // seconds at last update
    baseServerTime: number,    // ms epoch when state set
    playbackRate: number,      // default 1.0
    src: string }
  ```
* Clients compute **targetTime** continuously:
  `target = baseMediaTime + (now() - baseServerTime)/1000 * playbackRate`.
* **Drift correction**:

  * If |drift| > 0.40s → hard seek to target.
  * If 0.10–0.40s → temporary playbackRate nudge (0.95/1.05 for \~1s).
* **Clock offset**: client pings server to estimate offset and adjust `now()`.

## WebSocket API (initial)

* Client→Server: `join { roomId, name }`, `play`, `pause`, `seek { to }`, `ping { t0 }`.
* Server→Client: `state { ... }`, `resync { ... }` (periodic), `pong { t0, t1 }`, `error { code, message }`.

## Technical Requirements

* Node WS service (socket.io or ws). Single instance OK for MVP.
* Maintain in‑memory map for `roomId → state`. Persist optional metadata to Postgres.
* Health checks & liveness endpoint for deployment platform.

## Acceptance Criteria

* Two browsers show <250ms median drift; 95th percentile <400ms during normal network.
* Late joiner enters and starts within 2s of target, after sufficient buffer.

---

# Phase 3 — Buffer‑Aware Start, Presence & Roles

**Objective**: Smooth experience around buffering and basic roles.

## Functional Requirements

* **Ready gate**: User is considered “ready” when `video.buffered` covers `[target, target+X]` (e.g., 2–3s). Playback starts only when ready.
* **Presence list**: show connected users, host badge.
* **Roles**: host controls timeline; optional “request control”. Host can transfer ownership.
* UI indicators for “user is buffering/behind”.

## Technical Requirements

* Client sends `ready { ready: boolean }` when buffer threshold met.
* Server tracks presence and readiness; can pause on behalf of group if quorum falls behind (configurable).

## Acceptance Criteria

* Joining user does not stutter on entry; others aren’t forced to pause unless configured.

---

# Phase 4 — Chat & Reactions (Nice‑to‑Have)

**Objective**: Lightweight chat panel and emoji reactions.

## Functional Requirements

* In‑room text chat with timestamps.
* Quick emoji reactions that float over the video (non‑blocking, ephemeral).

## Technical Requirements

* WS events: `chat { text }` → broadcast `{ from, text, serverTime }`.
* Optional DB persistence of last N messages per room.

## Acceptance Criteria

* Messages show in ≤300ms; reactions render for \~2s and fade.

---

# Phase 5 — Security & Access Control

**Objective**: Prevent unauthorized hotlinking and limit room access.

## Functional Requirements

* **Signed HLS URLs** from Bunny with short TTL (e.g., minutes). Client fetches via your API when entering room.
* **Referrer allowlist** (Bunny) to your domain.
* **Room tokens**: room creation returns a signed room token (JWT) with role claims; guests get viewer tokens.
* Optional: room password or invite link.

## Technical Requirements

* Backend endpoint: `GET /api/room/:id/playback-url` validates room token and returns signed HLS URL.
* Server‑side signature uses Bunny Stream signing key (per Bunny docs) and TTL.
* CORS locks API to your web origin.

## Acceptance Criteria

* Directly opening the HLS URL in a foreign origin fails; opening via your app succeeds.

---

# Phase 6 — Scale & Resilience

**Objective**: Run multiple WS instances safely and survive restarts.

## Technical Requirements

* Add Redis for pub/sub + shared presence (socket.io‑redis adapter or custom).
* Store room state in Redis; periodic snapshot to Postgres if needed.
* Heartbeats: clients send ping; server evicts stale sockets.
* Sticky sessions optional; with Redis adapter, any instance can broadcast.
* Rate limiting on chat and control events.

## Acceptance Criteria

* Rolling deploy does not drop rooms; reconnects resubscribe within 2–5s.

---

# Phase 7 — UX Polish

**Functional/UX Enhancements**

* Subtitle tracks (WebVTT) selectable in UI.
* Thumbnail sprites on scrub.
* Keyboard shortcuts (Space, J/K/L, ←/→, M).
* Picture‑in‑Picture, Media Session API metadata.
* Responsive layout; mobile friendly controls.

---

# Phase 8 — Observability & Analytics

**What to Measure**

* Join latency, time‑to‑first‑frame, buffer ratio, stall count.
* Drift statistics (median, P95).
* Room duration, peak concurrent users.
* Errors (player/network/WS).

**Stack**

* Frontend: simple analytics endpoint or Segment; log to your backend.
* Backend: structured logs, metrics (Prometheus/OpenTelemetry), dashboards (Grafana).

---

# Phase 9 — QA & Test Plan

**Functional**

* Multi‑client sync tests (2–5 clients) for play/pause/seek.
* Late join while room is playing.
* Host handoff.

**Cross‑Browser**

* Chrome, Safari (iOS/macOS), Firefox, Edge; mobile orientations.

**Network**

* Throttle to 3G, add 200–400ms RTT, 1% packet loss; verify drift and recovery.

**Load**

* Simulate 100–500 clients (Artillery/k6) hitting WS and static CDN.

---

# Phase 10 — Deployment & DevOps

**Environments**: dev → staging → prod.
**CI/CD**: build React → upload to S3 → CDN invalidation; build WS → deploy (Docker or serverless websockets if available).
**Config**: secrets via env vars; separate Bunny signing key per env.
**Rollback**: keep previous static build; blue/green or canary for WS.

---

# APIs & Schemas (Initial Draft)

## WebSocket Events

* C→S

  * `join { roomId, name }`
  * `play {}`
  * `pause {}`
  * `seek { toMediaTime: number }`
  * `ready { ready: boolean }`
  * `ping { t0: number }`
  * `chat { text: string }`
* S→C

  * `state { isPlaying, baseMediaTime, baseServerTime, playbackRate, src }`
  * `resync { ...state }`
  * `presence { users: Array<{id,name,role,ready}> }`
  * `pong { t0, t1 }`
  * `chat { from, text, serverTime }`
  * `error { code, message }`

## DB (optional early)

* `rooms(id pk, src, owner_id, title, created_at)`
* `room_members(room_id fk, user_id, role, joined_at)`
* `messages(id pk, room_id fk, user_id, text, ts)`

---

# Definition of Done (Per Phase)

* **P0**: Static player loads via S3+CDN; HLS plays across target browsers.
* **P1**: Deep links `/room/:id` work; room data loads server‑side; optional token fetch.
* **P2**: Multi‑client sync within thresholds; late join works.
* **P3**: Presence and buffer‑aware start; host transfer.
* **P4**: Chat + reactions stable.
* **P5**: Signed HLS URLs + room tokens; referrer allowlist.
* **P6**: Redis adapter; rolling deploy resilience.
* **P7**: Subtitles, thumbnails, shortcuts; responsive polish.
* **P8**: Metrics and dashboards in place.
* **P9**: Test matrix and load tests green.
* **P10**: CI/CD with rollback and env separation.

---

# Open Questions / Decisions

* Hosting for WS: your VM, Fly.io, Render, or serverless WS? (affects scale path.)
* Managed realtime (Ably/Pusher/Supabase Realtime) vs self‑host WS?
* Room access model: public link vs invite‑only vs password.
* Analytics stack and data retention policy.

---

# Next Step (Actionable)

1. Complete **Phase 0**: ship static player from S3+CDN using Bunny HLS URL.
2. Implement **Phase 1** minimal room creation endpoint and routing.
3. Add **Phase 2** WS service with `state` model and drift correction loop.

I can tailor this to your Next.js + deployment preferences (PM2/VM or serverless) and add concrete IaC/CI snippets when you pick the hosting targets.
