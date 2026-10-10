# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AGENTS.md

This is a LiveKit Agents project (Python SDK for voice AI agents), deployed to LiveKit Cloud. AI 英语口语陪练 "Emma":bilingual short-sentence conversation practice for a Chinese adult beginner (CEFR A1). Personal-use project.

## Two components, zero backend

- `agent/agent.py` — the voice agent (single file; keep `agent.py` as the entrypoint, see Dockerfile). Pipeline: STT `assemblyai/universal-3-5-pro` · LLM `google/gemma-4-31b-it` · TTS `fishaudio/s2.1-pro` (voice Hannah) — all via LiveKit Inference (`livekit.agents.inference`), so no third-party API keys. Uses the LiveKit turn detector with adaptive interruptions and preemptive generation, plus ai_coustics noise cancellation on input.
- `web/` — React 19 + Vite + Tailwind 4 SPA using `livekit-client`. `web/src/Tutor.tsx` is the app shell (connection, transcript, GitHub accounts, session capture); `web/src/History.tsx` is the local history list / sync-to-GitHub / replay UI; `web/src/github.ts` wraps the Contents API used as zero-backend storage (`sessions/<user>/<timestamp>.json` in this repo). Deployed to GitHub Pages (subpath base `/livekit-tutor/`) via `.github/workflows/pages.yml` on pushes touching `web/**`.

**Connection flow (no server of our own):** the browser connects directly to the LiveKit Cloud room with a long-lived token created via `lk token create --agent livekit-tutor` — the agent dispatch is embedded in the token, so Emma joins automatically. The token is the only credential; it lives in browser localStorage, never in the repo. Revoking = reissuing tokens under a new room name. If the user picks a practice scenario, the page publishes it on a data channel (`topic: "scenario"`); the agent's `data_received` handler has Emma open in-role. With no scenario, her instructions make her ask what to practice.

Identity convention: the human participant is always identity `max` (hardcoded in both `web/src/Tutor.tsx` and the token); transcript bubbles and speaking state are keyed off it.

## Commands

Python side uses `uv`; the web side uses npm.

```bash
lk agent dev            # run agent locally with hot reload
lk agent deploy         # update the LiveKit Cloud deployment (after agent changes)

# token for the web page (paste into the H5; long-lived)
lk token create --join --room tutor-max --identity max --valid-for 8760h --agent livekit-tutor

uv run ruff format      # format
uv run ruff check       # lint
uv run pytest           # tests (no tests/ directory yet; add one for agent behavior)

cd web && npm run dev   # web dev server
cd web && npm run build # tsc + vite build (what Pages CI runs)
```

Secrets (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET) live in `.env.local` (gitignored; `agent.py` loads it via `load_dotenv`). `livekit.toml` holds the LiveKit Cloud project subdomain and agent id used by `lk agent` commands.

## LiveKit Documentation

LiveKit Agents evolves fast — always check the latest docs rather than guessing APIs. The LiveKit CLI's `lk docs` subcommand gives full docs access from the terminal (CLI 2.15.0+, `brew install livekit-cli` on macOS). Key commands: `lk docs overview`, `lk docs search`, `lk docs get-page`, `lk docs changelog`. Prefer browsing over search, and search over `code-search` (docs pages are more current). An MCP server with the same access lives at `https://docs.livekit.io/mcp`. If you used these to search or browse, submit constructive feedback with `lk docs submit-feedback`.

## Agent design

Voice AI is latency-sensitive: keep irrelevant context and tools out of LLM requests. For multi-phase conversations, prefer LiveKit's handoffs/tasks (see https://docs.livekit.io/agents/build/workflows/) over one long instruction prompt.

When changing core agent behavior (instructions, tool descriptions, tasks/handoffs), don't guess what will work — write tests for the desired behavior first and iterate until they pass. See https://docs.livekit.io/agents/start/testing/.

Beyond docs access, the `lk` CLI also manages things like SIP trunks for telephony agents (`lk --help`).
