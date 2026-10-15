# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AGENTS.md

AI 英语口语陪练 "Emma":bilingual short-sentence conversation practice for a Chinese adult beginner (CEFR A1). Personal-use project.

## Three parts, each deployed separately

- `agent/` — the voice agent. Entrypoint `agent/main.py` (Dockerfile CMD); pure correction logic (analyzer prompt, gating, card parsing) lives in `agent/corrections.py` so tests import it without loading the whole agent. Pipeline: STT `assemblyai/universal-3-5-pro` · LLM `google/gemma-4-31b-it` · TTS `fishaudio/s2.1-pro` (voice Hannah) — all via LiveKit Inference (`livekit.agents.inference`), so no third-party API keys. Uses the LiveKit turn detector with adaptive interruptions and preemptive generation, plus ai_coustics noise cancellation on input. Deployed to LiveKit Cloud with `lk agent deploy`.
  - **Live correction notebook**: every completed user turn triggers a background `google/gemini-3.1-flash-lite` analysis (`on_user_turn_completed` → fire-and-forget task, rate-limited, never blocks the reply); real mistakes are pushed as cards on data channel topic `correction` (grammar/word/pronunciation + Chinese point + IPA words, fed by low-confidence STT words). Emma's spoken "更正:" behavior is unchanged.
  - **Simli avatar (opt-in)**: enabled only when `SIMLI_API_KEY` + `SIMLI_FACE_ID` are set in `.env.local`; the avatar worker republishes lip-synced A/V so the agent's own `audio_output` is disabled in that case. Without keys: plain voice, identical to before. Startup retries on Simli 429 (first attempt inline before `session.start`, then a background task that waits for `/ratelimiter/sessions` to clear the concurrency slot — reconnecting within ~20s of leaving can hit the 429 because the previous job's shutdown still holds the slot). Tests: `tests/test_avatar_retry.py`.
- `web/` — React 19 + Vite + Tailwind 4 SPA using `livekit-client`, deployed to GitHub Pages (subpath base `/livekit-tutor/`) via `.github/workflows/pages.yml` on pushes touching `web/**`. `web/src/Tutor.tsx` is the app shell (connection, transcript, live correction cards, avatar video, session capture); `web/src/History.tsx` is the history list / replay (read straight from the backend — no localStorage history; only login state lives in localStorage); `web/src/api.ts` is the backend client (GitHub PAT → backend-issued JWT, silent re-auth on 401).
- `server/` — history backend: FastAPI + SQLAlchemy (Neon serverless PostgreSQL in prod — direct endpoint, small pool with `pool_recycle` for autosuspend; sqlite in tests), GitHub OAuth one-click login (code flow with state cookie, allowlist-checked, issues 30-day JWTs delivered back to the SPA via URL hash; a legacy PAT login endpoint also exists), session/message/correction CRUD, and `POST /api/token` which mints short-lived LiveKit room tokens and creates the session row (server-generated id + `started_at`; `ended_at` set on the first save — the client never supplies ids or times). Split: `main.py` (app/routes), `models.py` (DB models + engine), `auth.py` (PAT verify + JWT). Deployed on the user's k3s server (Traefik + cert-manager Let's Encrypt; per-service subdomain `tutor.<IP-dashes>.sslip.io`). k8s manifests and deploy docs are kept outside this repo. Image built by `.github/workflows/server-image.yml` to `ghcr.io/maxhello/tutor-api`.

**Connection flow:** on Start (login required), the page calls `POST /api/token` on the backend, which signs a fresh 12h LiveKit room token with the API key/secret (embedded agent dispatch → Emma joins automatically) — no long-lived tokens in the browser, no manual `lk token create` for the web. Room `tutor-max`, identity `max` are fixed on the backend (`server/main.py`). On hang-up the page auto-saves the transcript + correction cards with `PUT /api/sessions/{sessionId}` (idempotent, retried). **What to practice** is decided at Start and sent in the `/api/token` body: a scenario wins; otherwise a Duolingo unit (default = current unit, any learned unit selectable for review), otherwise free chat. The web reads the unit data live on page load from the personal site repo's raw files (`web/src/units.ts`: `duolingo-history.json` → current unit = latest `score.lastUnitDone` + 1, `duolingo-guidebooks.json` → objective/key sentences/grammar; same algorithm as the site's `Learn.tsx`). The backend validates/clamps it and puts it in the agent dispatch metadata; `agent/practice.py` parses `ctx.job.metadata` into the "Today's practice" instructions (unit material fenced as data) and Emma opens accordingly in `on_enter`. Behavior tests: `tests/test_practice_behavior.py` (real LLM + judge, skipped without credentials). The personal site's learning path (`/english/learn`) links here with `?unit=N` / `?history=unit:N` and shows per-unit practice counts from `GET /api/units/stats` (same origin, shares the tutor login in localStorage). The agent pushes correction cards back on `topic: "correction"`. Human participant identity is always `max`; transcript bubbles and speaking state are keyed off it.

Old GitHub-as-storage history (`sessions/` JSON) was dropped intentionally — history now lives in PostgreSQL only.

## Commands

Agent and server side use `uv`; the web side uses npm. Two separate uv projects: repo root (agent) and `server/`.

```bash
lk agent dev agent/main.py   # run agent locally with hot reload (entrypoint must be explicit after src/→agent/ rename)
lk agent deploy               # update the LiveKit Cloud deployment (after agent changes)
                              # Simli 密钥经 LiveKit Cloud secrets 注入(不进镜像/git):
                              #   lk agent deploy --secrets SIMLI_API_KEY=xxx --secrets SIMLI_FACE_ID=yyy

uv run ruff format && uv run ruff check   # agent lint/format
uv run pytest                              # agent tests (tests/)

cd server && uv run pytest    # backend tests (sqlite in-memory; server/ has its own uv project)
cd server && uv run uvicorn main:app --reload   # backend dev (needs a local PG or sqlite fallback)

cd web && npm run dev    # web dev server
cd web && npm run build  # tsc + vite build (what Pages CI runs)
```

Secrets live in `.env.local` (gitignored; loaded by `agent/main.py` via `load_dotenv`): `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, plus optional `SIMLI_API_KEY` / `SIMLI_FACE_ID`. `livekit.toml` holds the LiveKit Cloud project subdomain and agent id used by `lk agent` commands.

Frontend version marker: `APP_VERSION` in `web/src/Tutor.tsx` — bump on every web change; the footer shows it to verify the Pages deploy. The backend URL is `API_BASE` in `web/src/api.ts` (sslip.io domain of the server).

## LiveKit Documentation

LiveKit Agents evolves fast — always check the latest docs rather than guessing APIs. The LiveKit CLI's `lk docs` subcommand gives full docs access from the terminal (CLI 2.15.0+, `brew install livekit-cli` on macOS). Key commands: `lk docs overview`, `lk docs search`, `lk docs get-page`, `lk docs changelog`. Prefer browsing over search, and search over `code-search` (docs pages are more current). An MCP server with the same access lives at `https://docs.livekit.io/mcp`. If you used these to search or browse, submit constructive feedback with `lk docs submit-feedback`.

## Agent design

Voice AI is latency-sensitive: keep irrelevant context and tools out of LLM requests. Background work (like the correction analyzer) must run as fire-and-forget tasks with held references — never inline in hooks that gate Emma's reply.

When changing core agent behavior (instructions, tool descriptions, tasks/handoffs, the correction pipeline), don't guess what will work — write tests for the desired behavior first and iterate until they pass. See https://docs.livekit.io/agents/start/testing/.

Beyond docs access, the `lk` CLI also manages things like SIP trunks for telephony agents (`lk --help`).
