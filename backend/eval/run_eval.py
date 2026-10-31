"""BEAM agentic eval runner.

Runs tasks.json against a live backend (/api/chat) and grades:
  - tool_selection : did the model call the expected tool(s)?
  - stage_scoping  : did a narrow change re-run only the needed stages?
  - grounding      : did the model call a tool instead of inventing numbers,
                     and does the reply cite real constraints?

Usage:
    uv run python eval/run_eval.py --effort low medium high --runs 3
    uv run python eval/run_eval.py --base-url http://localhost:8000 --out results.csv

Each (effort, run) resets the demo site so state doesn't leak between tasks.
Requires the backend to be running with BEAM_API_* configured (live mode);
offline-scripted mode is detected and skipped (it has no tool choice).
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

import httpx

TASKS_PATH = Path(__file__).parent / "tasks.json"


def load_demo_site(base: str) -> str:
    r = httpx.post(f"{base}/api/demo", timeout=30)
    r.raise_for_status()
    return r.json()["site_id"]


def chat(base: str, site_id: str, message: str, effort: str | None,
         timeout: float = 600) -> dict:
    r = httpx.post(f"{base}/api/chat", timeout=timeout, json={
        "site_id": site_id, "message": message, "effort": effort})
    r.raise_for_status()
    return r.json()


def stages_run(resp: dict) -> list[str]:
    return [s.get("step") for s in (resp.get("steps") or [])]


def tools_called(resp: dict) -> list[str]:
    return [t["tool"] for t in (resp.get("meta") or {}).get("tools_called") or []]


def tool_args(resp: dict, tool: str) -> list[dict]:
    return [t.get("args") or {} for t in (resp.get("meta") or {}).get("tools_called") or []
            if t["tool"] == tool]


def grade(task: dict, resp: dict) -> tuple[bool, str]:
    """Return (passed, notes). One task may check tools, stages, args, reply."""
    fails: list[str] = []
    notes: list[str] = []
    tools = tools_called(resp)
    stages = stages_run(resp)
    meta = resp.get("meta") or {}

    if meta.get("mode") == "offline-scripted":
        return False, "SKIP: offline-scripted mode (no live Beam)"

    if "expected_tools" in task:
        missing = [t for t in task["expected_tools"] if t not in tools]
        if missing:
            fails.append(f"missing tools {missing} (called {tools})")
    if "expected_tools_any" in task:
        options = [set(o) for o in task["expected_tools_any"]]
        if set(tools) not in options:
            fails.append(f"tools {tools} not in allowed {task['expected_tools_any']}")
    for ft in task.get("forbidden_tools") or []:
        if ft in tools:
            fails.append(f"forbidden tool {ft} called")

    if "expected_stages" in task:
        missing = [s for s in task["expected_stages"] if s not in stages]
        if missing:
            fails.append(f"missing stages {missing} (ran {stages})")
    if "expected_stages_min" in task:
        missing = [s for s in task["expected_stages_min"] if s not in stages]
        if missing:
            fails.append(f"missing stages {missing} (ran {stages})")
    for fs in task.get("forbidden_stages") or []:
        if fs in stages:
            fails.append(f"forbidden stage {fs} ran")

    ea = task.get("expected_args")
    if ea:
        all_args = [a for call in (resp.get("meta") or {}).get("tools_called") or []
                    for a in [call.get("args") or {}]]
        for k, v in ea.items():
            if not any(abs((a.get(k) or 0) - v) < 1e-6 for a in all_args):
                fails.append(f"no tool call with {k}={v} (args seen: {all_args})")

    if task.get("min_scenarios"):
        n = max((len((a.get("land_use_factors") or []))
                 for a in tool_args(resp, "compare_scenarios")), default=0)
        if n < task["min_scenarios"]:
            fails.append(f"compare_scenarios used {n} factors, need >= {task['min_scenarios']}")

    if task.get("expect_design") and not resp.get("design"):
        fails.append("no design returned")

    must = task.get("reply_must_mention_any")
    if must:
        reply = (resp.get("reply") or "").lower()
        if not any(w in reply for w in must):
            fails.append(f"reply mentions none of {must}")

    notes.append(f"tools={tools} stages={stages}")
    return (not fails), "; ".join(fails) if fails else "PASS | " + "; ".join(notes)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--effort", nargs="+", default=["medium"])
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--tasks", type=Path, default=TASKS_PATH)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "results.csv")
    args = ap.parse_args()

    tasks = json.loads(args.tasks.read_text())["tasks"]

    health = httpx.get(f"{args.base_url}/api/health", timeout=10).json()
    if not health.get("beam_agent"):
        print("WARNING: backend reports beam_agent=false — results will be "
              "offline-scripted and skipped.", file=sys.stderr)

    rows: list[dict] = []
    for effort in args.effort:
        for run in range(1, args.runs + 1):
            site_id = load_demo_site(args.base_url)
            prior_design = False
            for task in tasks:
                if task.get("requires_prior_design") and not prior_design:
                    # seed the design deterministically so scoping is measurable
                    httpx.post(f"{args.base_url}/api/design",
                               json={"site_id": site_id}, timeout=600).raise_for_status()
                    prior_design = True
                t0 = time.time()
                try:
                    resp = chat(args.base_url, site_id, task["prompt"], effort)
                except Exception as e:
                    resp = {"meta": {}, "reply": "", "steps": [], "design": None}
                    passed, notes = False, f"ERROR: {e}"
                else:
                    passed, notes = grade(task, resp)
                    if resp.get("design"):
                        prior_design = True
                meta = resp.get("meta") or {}
                row = {
                    "effort": effort, "run": run, "task_id": task["id"],
                    "category": task["category"], "passed": passed,
                    "tools": "|".join(tools_called(resp)),
                    "stages": "|".join(stages_run(resp)),
                    "prompt_tokens": meta.get("prompt_tokens"),
                    "completion_tokens": meta.get("completion_tokens"),
                    "reasoning_tokens": meta.get("reasoning_tokens"),
                    "latency_s": meta.get("latency_s", round(time.time() - t0, 1)),
                    "notes": notes,
                }
                rows.append(row)
                print(f"[{effort} r{run}] {task['id']:<20} "
                      f"{'PASS' if passed else 'FAIL'}  {notes[:110]}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"\nWrote {len(rows)} rows -> {args.out}")

    # quick summary
    from collections import defaultdict
    agg: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        if "SKIP" in r["notes"]:
            continue
        agg[r["effort"]].append(r["passed"])
    for effort, res in agg.items():
        print(f"effort={effort:<7} pass={sum(res)}/{len(res)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
