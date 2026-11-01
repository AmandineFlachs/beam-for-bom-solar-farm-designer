# VIDEO SCRIPT v8 — face-bubble narration (~150 s)

Format: face in a persistent circle bubble over capture and diagram
footage; full-frame face at the open. Product showcase, no eval
findings. Cold open with the result, then problem, a four-part demo
with a beat per feature, how Beam works, close. HTML assets in
eval/video_assets/. Captions burned.

## Beat map

| Beat | Screen | Bubble? | Len |
|---|---|---|---|
| 1. Cold open | FACE full → C1 flythrough | cut to bubble | 10s |
| 2. Problem + product | map → boundary draw | bubble | 12s |
| 3a. Demo: exclusions | C2 draw → red exclusions → pack | bubble | 15s |
| 3c. Demo: sun study | C4 shadow sweep | bubble | 15s |
| 3b. Demo: report | C3 ReportView scroll | bubble | 18s |
| 3d. Demo: Ask Beam | C5 chat + repack | bubble | 18s |
| 4. How Beam works | architecture.html → agent_loop.html | bubble | 40s |
| 4b. The eval | effort_cost.html bars animate | bubble | 18s |
| 5. Close | flythrough tail → end card | bubble ducks | 12s |

## Narration (read to camera, plays under the bubble)

**N1 (~10s):** "I gave Beam a satellite map and one job. Sixty seconds
later it had drawn a solar farm on it: two hundred and forty-eight
tables, two point six megawatts, and a bill of materials ready to
order."

**N2 (~12s):** "Screening land for utility-scale solar still takes
weeks. Desktop studies, map layers, layouts redone every time a
constraint changes. This is BEAM for BOM, Solar Farm designer, built on Beam, a five
hundred billion parameter model from Reflection AI."

**N3a (~15s):** "You draw the boundary of a parcel on the globe. Beam
pulls OpenStreetMap and finds the constraints itself: the pond, the
woods, the farm buildings. They light up red, and the layout engine
packs the solar panels around them automatically."

**N3c (~15s):** "The 3D preview builds real terrain, with satellite
imagery on top, and the water and trees where the map says they are.
Slide the time of day and you watch the sun cross the site, shadows
sweeping the tables from morning to evening. You can see the exposure
hour by hour."

**N3b (~18s):** "Then the report tells you what you're actually
building: how much energy it makes a year, how well it performs, and
exactly what to buy. The bill of materials goes line by line, from the
panels and inverters down to the cables and the transformer. You can
export the whole thing as a proposal."


**N3d (~18s):** "Anytime, you can talk to Beam, for example to
reduce land use by twenty percent and you can watch it think: it picks
the tools, runs the pipeline again, and repacks the site live." 

**N4 (~40s):** "The project has three layers. A React and Cesium globe for
the working map. A Three.js scene on real elevation data for the
preview. And a FastAPI pipeline does the engineering, from spotting
constraints to pricing the parts. Beam sits on top in a true
multi-turn tool-calling loop with six typed tools. It reads your
request, reasons about it, picks a tool and its arguments, gets the
result back, and decides what to do next. You can see its reasoning in
the chat, step by step." 

**N4b (~18s):** "I also ran evals on Beam's different reasoning efforts.
It showed nearly perfect tool selection
across the sixty-six runs. Interestingly, the
highest effort costs twice the tokens for no extra correctness. So low
effort is already enough, which makes this relatively cheap to run, as well."

**N5 (~12s):** "So a feasibility study that used to take weeks happens
while you watch. BEAM for BOM, Solar Farm designer, built on Beam, extended by Mirror.
Links below."

## Captures

- **C1 flythrough** — low over tables, the prettiest shot (~8s). Opens
  under N1 the moment the face cut ends; reuse the tail under N5.
- **C2 draw + exclusions** — clicks → waterbody/woodland/farmstead
  buildings appear red → tables pack around them (~8s). The "it found
  the pond itself" moment is back with the new site; give it a beat of
  silence after the exclusions appear.
- **C3 report** — ReportView scroll, slow enough to read: 2.56 MWp,
  ~2,364.5 MWh/yr, BOM line items; end on proposal export (~10s).
- **C4 sun slider** — 3D preview, shadow sweep morning → evening (~8s).
  The second wow moment; no narration overlap if possible.
- **C5 Ask Beam chat** — "reduce land use 20%" reasoning trace + repack,
  then "just guess X" → tool call (~12s). Two exchanges show two
  strengths: multi-turn scoping and grounding. Film live mode only (the
  offline-scripted label undercuts it). Two takes.

## Graphs / overlays (HTML, OpenEdit renders)

- **G1 architecture.html** — N4 first half: two renderers + FastAPI
  services + Beam endpoint + ledger. Slow pan/zoom, highlight each box
  as it's named.
- **G2 agent_loop.html** — N4 second half: user → Beam → tool calls →
  pipeline → reply + reasoning. Animate along the arrows.
- **G3 effort_cost.html** — under N4b: animated token-cost bars across
  the three effort levels. Let the "high = 2× tokens" bar land as the
  narration says it.
- **G4 end_card.html** — under N5 tail.

## Bubble direction for OpenEdit

- Circle crop, 2px amber border (#f59e0b), soft shadow, ~18% frame
  width.
- Bottom-center or bottom-left preferred; the app's action is
  center-left and the chat panel is on the right. Let the renderer see
  the captures and pick.
- Bubble ducks during the end card.
- 9:16 vertical reframe as a second export.

## Pronunciation notes (French accent)

- **BOM** — say "bomb" (/bɒm/), not the letters. The name is a pun; it
  lands better spoken than spelled.
- **Three.js** — "three-jay-ess". If "three" fights you, "a Three.js
  scene" can become "a Three-JS scene" or just "a 3D scene built on
  Three.js" → simplest fallback: "a Three.js scene" → "a Three-j-s
  scene". Cut to "the 3D scene" if it still trips.
- **FastAPI** — "fast-A-P-I", letters, easy pace.
- **OpenStreetMap** — three clear words; say them separately.
- **constraint / constraints** — the French 't' is silent in French;
  in English say the full "kon-STRAINT". Used twice (N2, N3a); slow
  down there.
- **yield** — "yeeld", one syllable, not "weeld".
- **exclusions** — "ex-KLOO-zhuns"; if it trips, swap in "the red
  zones" (N4 only, N3a already describes them visually).
- **world/terrain/megawatts** — watch the 'r': English 'r' is soft,
  not rolled. "TERR-ayn", "MEG-ah-wotts".
- Removed already: "heightfield", "draped imagery", "GIS layers",
  "PVGIS" (now "solar radiation data").
- **"five hundred billion parameters"** (N2) — kept because it's the
  most impressive fact; the phrasing avoids hyphens and clusters. Say
  it slowly: "five HUN-dred BIL-yun PA-ram-e-ters."

## Structure notes

- Cold open lands the wow in the first 10 seconds with real numbers
  from the demo site (248 tables, 2.56 MWp, BOM).
- The demo is split into four labeled beats so each feature gets air
  time: OSM exclusions, the report and BOM/proposal, the sun-exposure
  study, and Ask Beam.
- N4 is the Beam-strengths beat: six typed tools, multi-turn loop,
  visible reasoning_content trace, grounding in pipeline output.
- N4b covers the eval without dwelling on weaknesses: the impressive
  results are near-perfect tool selection and the finding that low
  effort matches high on correctness at half the token cost — a
  practical, positive takeaway. The scoping failure stays in the
  written submission only.
- Tight ~150s if needed: N4b is the first cut; it leaves the video
  intact because the eval details live in the submission post.
- N3d's second exchange ("just guess a number" → tool call) is the
  strongest single proof of grounding; keep it if cuts are needed.
- Two silent-ish beats let footage breathe: exclusions appearing (C2),
  shadow sweep (C4).
- Tight ~90s cut if needed: merge 3a+3b, cut N4 to two sentences over
  architecture.html only, keep N1 and N5 intact.
