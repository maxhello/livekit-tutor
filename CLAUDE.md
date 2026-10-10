# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AGENTS.md

AI 英语口语陪练 "Emma":bilingual short-sentence conversation practice for a Chinese adult beginner (CEFR A1). Personal-use project.

## Three parts, each deployed separately

- `agent/` — the voice agent. Entrypoint `agent/main.py` (Dockerfile CMD); pure correction logic (analyzer prompt, gating, card parsing) lives in `agent/corrections.py` so tests import it without loading the whole agent. Pipeline: STT `assemblyai/universal-3-5-pro` · LLM `google/gemma-4-31b-it` · TTS `fishaudio/s2.1-pro` (voice Hannah) — all via LiveKit Inference (`livekit.agents.inference`), so no third-party API keys. Uses the LiveKit turn detector with adaptive interruptions and preemptive generation, plus ai_coustics noise cancellation on input. Deployed to LiveKit Cloud with `lk agent deploy`.
  - **Live correction notebook**: every completed user turn triggers a background `google/gemini-3.1-flash-lite` analysis (`on_user_turn_completed` → fire-and-forget task, rate-limited, never blocks the reply); real mistakes are pushed as cards on data channel topic `correction` (grammar/word/pronunciation + Chinese point + IPA words, fed by low-confidence STT words). Emma's spoken "更正:" behavior is unchanged.
  - **Simli avatar (opt-in)**: enabled only when `SIMLI_API_KEY` + `SIMLI_FACE_ID` are set in `.env.local`; the avatar worker republishes lip-synced A/V so the agent's own `audio_output` is disabled in that case. Without keys: plain voice, identical to before.
- `web/` — React 19 + Vite + Tailwind 4 SPA using `livekit-client`, deployed to GitHub Pages (subpath base `/livekit-tutor/`) via `.github/workflows/pages.yml` on pushes touching `web/**`. `web/src/Tutor.tsx` is the app shell (connection, transcript, live correction cards, avatar video, session capture); `web/src/History.tsx` is the history list / sync / replay; `web/src/api.ts` is the backend client (GitHub PAT → backend-issued JWT, silent re-auth on 401).
- `server/` — history backend: FastAPI + SQLAlchemy (Neon serverless PostgreSQL in prod — direct endpoint, small pool with `pool_recycle` for autosuspend; sqlite in tests), GitHub OAuth one-click login (code flow with state cookie, allowlist-checked, issues 30-day JWTs delivered back to the SPA via URL hash; a legacy PAT login endpoint also exists), session/message/correction CRUD, and `POST /api/token` which mints short-lived LiveKit room tokens. Split: `main.py` (app/routes), `models.py` (DB models + engine), `auth.py` (PAT verify + JWT). Deployed on the user's k3s server: `server/deploy/ingress.yaml` (Traefik + cert-manager Let's Encrypt; per-service subdomain `tutor.<IP-dashes>.sslip.io`) is in git; **`tutor-api.yaml` (Deployment, with plaintext env secrets) is gitignored** — the full template to recreate it lives in `server/deploy/README.md`. Image built by `.github/workflows/server-image.yml` to `ghcr.io/maxhello/tutor-api`. Deploy steps: `server/deploy/README.md`.

**Connection flow:** on Start (login required), the page calls `POST /api/token` on the backend, which signs a fresh 12h LiveKit room token with the API key/secret (embedded agent dispatch → Emma joins automatically) — no long-lived tokens in the browser, no manual `lk token create` for the web. Room `tutor-max`, identity `max` are fixed on the backend (`server/main.py`). If the user picks a practice scenario, the page publishes it on a data channel (`topic: "scenario"`); the agent's `data_received` handler has Emma open in-role. The agent pushes correction cards back on `topic: "correction"`. Human participant identity is always `max`; transcript bubbles and speaking state are keyed off it.

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
