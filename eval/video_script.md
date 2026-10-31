# VIDEO SCRIPT v5 — face-bubble narration (~70 s)

Format: your face in a persistent circle bubble over capture and graph
footage. Full-frame face at the very open and very close, or bubble
throughout. This is a Build-with-Beam submission: the model is the subject,
the product is the evidence. HTML assets in eval/video_assets/. Captions
burned.

## Beat map

| Beat | Screen | Bubble? | Len |
|---|---|---|---|
| 1. Hook | FACE full → flythrough | cut to bubble | 10s |
| 2. Problem + product | draw → exclusions → 3D → chat | bubble | 25s |
| 3. What Beam did | effort_cost → scoping_map | bubble | 25s |
| 4. Close | end card | bubble/full | 8s |

## Narration (read to camera, plays under the bubble)

**N1 (~10s):** "I gave Beam, Reflection's five-hundred-billion parameter
reasoning model, a satellite map and one job: design a solar farm on it.
Then I measured how it actually thinks."

**N2 (~25s):** "The problem it solves is real: screening land for solar
takes weeks. Here, Beam calls real engineering tools. You draw a boundary,
it finds the pond and the copse itself from OpenStreetMap, packs tables
around them, sizes the electrical kit, estimates yield, writes the bill of
materials. Ask it to pack tighter and you watch it reason, then repack.
Ask it to guess a number and it calls a tool instead. It does not invent
figures."

**N3 (~25s):** "So I measured it. Eleven agent tasks at three reasoning
efforts. Tool selection? Nearly perfect, even at low effort. But high
effort costs twice the tokens for zero extra correctness. And its real
weakness is scoping, not choosing. Ask for a tilt change and it re-runs the
electrical stage every single time. More thinking did not fix it."

**N4 (~8s):** "Extended by Mirror, Reflection's own agent, running on Beam.
Links below."

## Captures

- **C1 flythrough** — low over tables (~6s)
- **C2 draw + exclusions** — clicks (2×) → pond/copse appear red → tables
  pack around them (~8s)
- **C3 3D preview** — sun slider shadow sweep (~5s)
- **C4 chat** — "reduce land use 20%" reasoning trace + repack; then
  "just guess" → calls a tool (~6s)

## Graphs (HTML, OpenEdit renders)

- **G1 effort_cost.html** — during N3 first half
- **G2 scoping_map.html** — during N3 second half (`electrical` pulses red)
- **G3 end_card.html** — under N4

## Bubble direction for OpenEdit

- Circle crop, 2px amber border (#f59e0b), soft shadow, ~18% frame width.
- Bottom-center or bottom-left preferred; the app's action is center-left
  and the chat panel is on the right. Let the renderer see the captures
  and pick.
- Bubble ducks during the end card.
- Film live mode only for C4 (the offline-scripted label undercuts it).
  Two takes.
- 9:16 vertical reframe as a second export.

## Structure against the judging criteria

- Model first: Beam named in line 1, effort/tool-calling/reasoning named
  in N2 and N3.
- Problem stated plainly in N2's first sentence.
- What we did: the product demo (N2) and the measurement (N3), which is
  the differentiator.