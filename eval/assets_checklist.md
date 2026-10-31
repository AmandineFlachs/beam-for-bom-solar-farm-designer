# Submission assets checklist — video / GitHub / Hugging Face

Status: ✅ done · 🟡 drafted · ❌ to create

## Video (OpenEdit, ~70 s, face bubble)

| Asset | Status | Notes |
|---|---|---|
| `eval/video_script.md` v5 | ✅ | narration N1–N4, model-first |
| `video_assets/title_card.html` | ✅ | |
| `video_assets/eval_card.html` | ✅ | findings table |
| `video_assets/effort_cost.html` | ✅ | animated bars |
| `video_assets/scoping_map.html` | ✅ | animated expected-vs-actual |
| `video_assets/end_card.html` | ✅ | fill real URLs before render |
| Face recording (N1–N4) | ❌ | one take per paragraph, 2 takes |
| Captures C1–C4 | ❌ | flythrough, draw+exclusions, 3D sun, chat |
| Captions | ❌ | OpenEdit transcribes; check token terms (MWh, MWp, PVGIS) |
| Music bed | ❌ | subtle ambient, out during N3 |
| 9:16 vertical reframe | ❌ | second export for X |
| Thumbnail / cover frame | ❌ | still from flythrough + title text |

## GitHub repo

| Asset | Status | Notes |
|---|---|---|
| Secrets scan (chat1/2.json, zip, db) | ❌ | before going public |
| README hero screenshot | ❌ | full app with a finished design; or short mp4 embed |
| `docs/architecture.png` | 🟡 | render `video_assets/architecture.html` → PNG |
| `docs/agent_loop.png` | 🟡 | render `video_assets/agent_loop.html` → PNG |
| README link to eval suite + results | ✅ | `backend/eval/` |
| Remove `beam_for_bom_mac.zip`? | ❌ | decide: stale duplicate |
| LICENSE file | 🟡 | README says MIT; add LICENSE |
| Topics/description on GitHub | ❌ | "solar, agent, beam, cesium, fastapi" |

## Hugging Face

| Asset | Status | Notes |
|---|---|---|
| Submission post | 🟡 | `eval/submission_draft.md`, fill URLs |
| Docker Space | ❌ | create, push repo, set BEAM_* secrets |
| Space README front-matter | ❌ | `title`, `sdk: docker`, `app_port: 7860` |
| Space screenshot/thumbnail | ❌ | same hero as GitHub |
| Video host | ❌ | HF dataset repo `media/` (embeddable, like HAR2Client) |
| `eval/` + `ledger` in repo | ✅ | already committed; link from post |
| `eval/mirror_session.md` | ✅ | provenance artifact |

## Diagrams (built as HTML → render to PNG/SVG for README)

| Asset | Shows |
|---|---|
| `video_assets/architecture.html` ✅ | two renderers (Cesium map / Three.js Scene3D) + FastAPI services + Beam endpoint + ledger |
| `video_assets/agent_loop.html` ✅ | user → Beam → tool calls → deterministic pipeline → reply + reasoning + tokens |
| `video_assets/scoping_map.html` ✅ | doubles as the "scoping finding" diagram |

## Render HTML → PNG (for README/Space, they can't embed HTML)

Any headless browser shot at 1920×1080 works, e.g.:
`npx playwright screenshot --viewport-size=1920,1080 eval/video_assets/architecture.html docs/architecture.png`
or open in Chrome and screenshot.
