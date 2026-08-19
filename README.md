# skfiy-next

Local-first macOS desktop pet that fronts a Background Agent, with Computer Use as a permissioned tool layer.

This is the distilled rewrite of [skfiy](../skfiy): the proven core (agent, computer-use, orchestrators, pet renderer) ported with its tests, the process bloat (dogfood program, dashboard, CLI sprawl, agentframe scaffolding) left behind. See `RESCUE-PLAN.md` in the old repo for the diagnosis that motivated this.

## MVP scope

- Floating desktop companion with active and quiet modes.
- Manifest-driven pixel pet skins (bundled `skfiy-black-cat`, local `luoxiaohei-local` override).
- App-agnostic macOS helper primitives: app listing, activation, screenshots/OCR, clicks, drags, scrolls, text input, hotkeys.
- Target-specific adapters: Ghostty terminal, Chrome page observation/actions, Finder file operations, tmux supervision.
- App policy and action risk gates before execution; explicit approval for risky or state-mutating actions.
- Local-only execution. The helper sends nothing remote by itself.

## Architecture

```
src/renderer/       Pet UI (React). Talks to main via the preload-injected DesktopApi.
src/main/           Electron main process.
  assistant-agent.ts      Background Agent (CLI provider: codex / claude-code / hermes)
  computer-use/           Permissioned tool layer: helper client, policies, executor, replay
  orchestrator/           Task runners: ghostty, chrome, finder, tmux
  main-*.ts               Wiring modules (IPC payloads, window controls, routing)
  main.ts                 Shell: window creation + IPC registration
src/shared/         Cross-surface contracts (route-outcome, risk-policy, types)
chrome-extension/   MV3 extension (browser context bridge)
macos-helper/       Swift helper (app control primitives)
scripts/            Build + smoke harness
```

The pet renderer is intentionally independent from the backend: main emits task status (`idle` / `executing` / `waiting` / `failed`), the renderer maps states to the selected skin manifest.

## Develop

```bash
nvm use            # Node 22
npm install
npm test           # vitest, ~475 tests, ~45s
npm run typecheck  # tsc --noEmit, strict, zero any
npm run dev        # vite dev server (renderer)
npm run dev:electron  # electron pointing at the dev server
npm run build      # vite build + tsc electron + swift helper
```

## Status

- [x] Core ported: renderer, agent, computer-use, orchestrators, shared contracts — 505 tests green, typecheck green
- [x] Electron shell ported and slimmed (personalization sprawl + tmux-replay wiring cut)
- [x] App builds and packages: `npm run build` + `package:mac` produce `dist/skfiy.app`
- [x] **smoke:ui passes end-to-end** — app launches, pet renders, agent turn, approval + stop flows work
- [x] CI (GitHub Actions, macOS: typecheck + vitest + build)
- [ ] smoke:cli / smoke:chrome runtime adaptation — their tests pass but the scripts still reference the dropped `dist/skfiy` CLI binary and native-host lanes; needs surgery before they run green
- [ ] Electron 39 → 43 upgrade
- [ ] First-run onboarding (the M1 feature from the old repo's computer-use-loop branch)

## Cut from the old repo (intentionally)

Dashboard (22k LOC), dogfood program (26k LOC of theater), 18.8k-LOC CLI, MCP server, Codex plugin, money-run supervision, automation monitors (frozen — code kept, not expanded), personalization learning loop, `.agentframe/` scaffolding, signed-release tooling (unsigned-alpha path only).

## Known gaps

See [docs/known-gaps.md](docs/known-gaps.md) — the salvaged architectural debt list.
