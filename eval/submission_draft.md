# SUBMISSION DRAFT — post to https://huggingface.co/reflection/Beam-1.0-501B-A23B/discussions/5
# Replace bracketed links before posting.

**BEAM for BOM: draw a boundary on a satellite globe. Beam designs the solar
farm, tells you what to buy, and we measured how it thinks while doing it.**

- Space (live demo): [SPACE_URL]
- Code (MIT): [GITHUB_URL]
- Demo video (70 s, captioned): [VIDEO_URL]
- Eval tasks + results CSV: [GITHUB_URL]/tree/main/backend/eval

## Results

11 tasks covering tool selection, pipeline scoping and grounding. Each ran
at three reasoning efforts, 2 runs per cell, against the live model:

| effort | tasks passed | avg reasoning tokens | avg completion tokens | avg latency |
|---|---|---|---|---|
| low    | 16/22 | 190 | 602   | 5.8 s |
| medium | 16/22 | 449 | 919   | 7.2 s |
| high   | 15/22 | 748 | 1,279 | 9.1 s |

Two things fall out of this. Tool selection is already saturated at low
effort: Beam picks the right tool ~100% of the time at every level, so
paying for `high` costs 2.1× the output tokens and buys nothing on
correctness. And the failure mode is not choosing tools, it is scoping
them. On a narrow change ("tilt → 25°") Beam correctly picks `run_stage`
but over-runs `electrical` every time (12/12). On capacity changes it
always takes the full pipeline (6/6) rather than the scoped re-run path the
system prompt describes. More thinking did not fix either.

## What it is

A browser-based agentic solar-farm pre-design tool. You draw a land
boundary on satellite imagery (single or multi-parcel), set assumptions,
and Beam drives a deterministic engineering pipeline:

- Boundary: site + exclusions on Esri imagery; OSM auto-detects buildings,
  water and woodland inside the boundary and excludes them
- Energy: PVGIS yield estimate (hourly, cached)
- Array: deterministic fixed-tilt table packing with shading-derived row
  pitch
- Materials: strings, inverters, cables, transformer rules, BOM, exports

There is also a Three.js photoreal 3D preview: real heightfield terrain
(Mapterhorn DEM), draped imagery, water and trees where OSM says they are,
sun-slider shadows, walkable first-person mode.

## How Beam is used

Two surfaces. `POST /api/chat` is a true multi-turn tool-calling loop with
6 typed tools (run_full_design, run_stage, compare_scenarios,
get_site_conditions, get_design_summary, export_project). `POST
/api/proposal` has Beam write the proposal narrative with every number
grounded in the design JSON, falling back to a template when Beam is not
configured.

The Reflection API requires `reasoning_content` echoed back verbatim on
every assistant tool-call turn; without it the call returns 400. We
preserve it across turns, and every reply exposes Beam's reasoning trace
plus per-turn token and latency meta in the UI.

Every figure comes from a typed tool call; deterministic services compute,
Beam reasons. In eval, asked to "just guess" panel counts, it called a tool
instead of confabulating in 5 of 6 runs. Without `BEAM_API_*` the app runs
a scripted Beam narrating real tool results, and the UI labels that mode
"offline scripted" rather than pretending it is live.

## How it was built

Mirror (Reflection's agent) added MultiPolygon boundaries, the
`/api/proposal` surface and shading-derived row pitch. Session notes are in
`eval/mirror_session.md` and the commits are verifiable in git. Beam-1.0
runs inside the product as the agent over two surfaces (chat tools,
proposal writer).

## Call ledger

All LLM calls route through one chokepoint and land in a JSONL ledger
(`backend/eval/ledger.jsonl`): surface, effort, per-call tokens including
reasoning, tool calls with args, latency. Total spend for the eval sweep
and development is inspectable end to end.

## Limits (please read)

- Feasibility-grade only: slope limit 8°, no shading simulation, no
  planning constraints. Transformer and grid sizing is rule-based; DNO
  confirmation always required.
- Small n: 11 tasks, 1 site, 2 runs per cell. Pass counts are directional.
- The scoping failures are graded against our own system prompt's contract.
  Re-running electrical on a tilt change is wasteful, not wrong.
- The proposal surface is single-turn with no tools, so the
  `reasoning_content` echo quirk does not apply there.

Thanks to Reflection and Hugging Face for Beam API access and the challenge.
