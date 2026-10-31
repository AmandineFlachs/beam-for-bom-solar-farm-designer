import { useEffect, useRef, useState } from 'react'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Design, Step } from './api'
import { api } from './api'

interface Props {
  design: Design | null
  steps: Step[]
  siteId: string | null
  onDesign: (d: Design, steps: Step[]) => void
  assumptions: any
  onReport?: () => void
}

const STEP_LABELS: Record<string, string> = {
  boundary: 'Boundary received', terrain: 'Terrain analysed',
  layout: 'PV layout generated', electrical: 'Electrical system designed',
  yield: 'Yield estimated', bom: 'BOM generated', export: 'Package ready',
}

type ChatMsg = {
  who: string; text: string; reasoning?: string | null
  meta?: { model?: string; effort?: string; mode?: string; latency_s?: number
           prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }
}

export default function RightPanel({ design, steps, siteId, onDesign, assumptions, onReport }: Props) {
  const [msg, setMsg] = useState('')
  const [effort, setEffort] = useState('medium')
  const [chat, setChat] = useState<ChatMsg[]>([
    { who: 'beam', text: "I'm BEAM — your solar pre-design engineer. Draw a boundary, set assumptions, and I'll generate the layout, electrical design, yield estimate and BOM." },
  ])
  const [busy, setBusy] = useState(false)
  const [exports_, setExports] = useState<Record<string, string> | null>(null)
  const [proposal, setProposal] = useState<{ markdown: string; mode?: string } | null>(null)
  const [propBusy, setPropBusy] = useState(false)
  const [conds, setConds] = useState<{
    source: string; ghi_wm2?: number; dni_wm2?: number; temperature_c?: number
    cloud_cover_pct?: number; wind_ms?: number; is_day?: boolean; fetched_at?: string
  } | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)

  // live site conditions (Open-Meteo), refreshed every 60 s
  useEffect(() => {
    if (!siteId) { setConds(null); return }
    let alive = true
    const load = () => api.conditions(siteId).then(c => alive && setConds(c)).catch(() => {})
    load()
    const id = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [siteId])

  // keep chat scrolled to the latest message
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [chat, busy])

  const send = async () => {
    if (!msg.trim() || busy) return
    const m = msg; setMsg('')
    setChat(c => [...c, { who: 'you', text: m }])
    setBusy(true)
    try {
      const r = await api.chat(siteId, m, assumptions, effort)
      setChat(c => [...c, { who: 'beam', text: r.reply, reasoning: r.reasoning, meta: r.meta }])
      if (r.design) onDesign(r.design, r.steps)
    } catch (e: any) {
      setChat(c => [...c, { who: 'beam', text: `Tool error: ${e.message}` }])
    }
    setBusy(false)
  }

  const doExport = async () => {
    if (!siteId) return
    try { setExports(await api.export(siteId)) } catch { }
  }

  const doProposal = async () => {
    if (!siteId) return
    setPropBusy(true)
    try { setProposal(await api.getProposal(siteId)) } catch { }
    setPropBusy(false)
  }

  const t = design?.terrain, l = design?.layout, e = design?.electrical,
        y = design?.yield, b = design?.bom

  return (
    <div className="flex flex-col h-full p-3 gap-3">
      {/* ============ BEAM CHAT — the headline feature ============ */}
      <div className="panel flex flex-col min-h-0 shrink-0" style={{ flexBasis: '44%' }}>
        <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5 border-b border-[#262b33]">
          <span className="text-[12px] font-bold uppercase tracking-wider brand-text">⚡ ASK BEAM</span>
          {busy && <span className="text-[10px] text-yellow-400 animate-pulse">thinking…</span>}
        </div>
        <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 px-2 py-2">
          {chat.map((c, i) => (
            <div key={i} className={`text-xs rounded-lg px-2.5 py-1.5 whitespace-pre-wrap max-w-[92%] ${c.who === 'beam' ? 'bg-[#141a24] text-slate-200' : 'bg-blue-700/50 text-blue-50 self-end'}`}>
              {c.reasoning && (
                <details className="mb-1.5 border-b border-[#303139] pb-1">
                  <summary className="cursor-pointer text-purple-300/80 text-[11px] select-none">
                    🧠 Beam's reasoning — click to expand
                  </summary>
                  <div className="mt-1 text-[11px] text-slate-400 whitespace-pre-wrap max-h-56 overflow-y-auto">
                    {c.reasoning}
                  </div>
                </details>
              )}
              {c.text}
              {c.meta?.mode === 'live' && (
                <div className="mt-1 pt-1 border-t border-[#303139] text-[10px] text-slate-500">
                  {c.meta.model} · effort {c.meta.effort} · {c.meta.latency_s}s
                  {c.meta.completion_tokens != null &&
                    ` · ${c.meta.completion_tokens} tok (${c.meta.reasoning_tokens ?? 0} reasoning)`}
                </div>
              )}
              {c.meta?.mode === 'offline-scripted' && (
                <div className="mt-1 pt-1 border-t border-[#303139] text-[10px] text-slate-500 italic">
                  offline scripted mode — numbers still come from the real pipeline
                </div>
              )}
            </div>
          ))}
          {busy && <div className="text-xs text-slate-500 px-1">Beam is working…</div>}
          <div ref={chatEnd} />
        </div>
        <div className="flex gap-1 items-center p-2 border-t border-[#262b33]">
          <input className="flex-1 min-w-0 bg-[#10141c] border border-[#303139] rounded-lg px-2.5 py-1.5 text-sm"
            value={msg} onChange={e => setMsg(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()}
            placeholder='e.g. "Reduce land use by 20%"' />
          <select value={effort} onChange={e => setEffort(e.target.value)}
            title="Beam thinking depth"
            className="shrink-0 w-[62px] bg-[#10141c] border border-[#303139] rounded-lg px-1 py-1.5 text-[11px] text-slate-300">
            <option value="low">low</option>
            <option value="medium">med</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
          <button onClick={send} className="shrink-0 px-3 py-1.5 bg-amber-600/80 hover:bg-amber-500 rounded text-sm font-semibold text-black">Send</button>
        </div>
      </div>

      {/* ============ collapsible details ============ */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
        {steps.length > 0 && (
          <Section title="Pipeline progress" defaultOpen={steps.some(s => s.status !== 'done')}>
            {steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-xs py-0.5">
                <span className={s.status === 'done' ? 'text-green-400' : s.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}>
                  {s.status === 'done' ? '●' : s.status === 'failed' ? '✕' : '◌'}
                </span>
                <div>
                  <span className="text-slate-300">{STEP_LABELS[s.step] || s.step}</span>
                  {s.summary && <div className="text-slate-500">{s.summary}</div>}
                </div>
              </div>
            ))}
          </Section>
        )}

        {conds && (
          <Section title="Live site conditions" pulse>
            <div className="grid grid-cols-4 gap-1 text-center">
              <Metric k="GHI" v={conds.ghi_wm2 != null ? `${Math.round(conds.ghi_wm2)} W/m²` : '—'} />
              <Metric k="Est. now" v={conds.ghi_wm2 != null && l
                ? `${(l.dc_capacity_kwp * conds.ghi_wm2 / 1000 * 0.78 / 1000).toFixed(2)} MW` : '—'} />
              <Metric k="Temp" v={conds.temperature_c != null ? `${conds.temperature_c.toFixed(1)}°C` : '—'} />
              <Metric k="Wind" v={conds.wind_ms != null ? `${conds.wind_ms.toFixed(1)} m/s` : '—'} />
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              {conds.source} · {conds.fetched_at} · cloud cover {conds.cloud_cover_pct ?? '—'}%{!conds.is_day && ' · night'}
            </div>
          </Section>
        )}

        {design && (
          <Section title="Key metrics" defaultOpen>
            <div className="grid grid-cols-3 gap-1.5">
              <Metric k="Site" v={t ? `${t.total_area_ha} ha` : '—'} />
              <Metric k="Usable" v={t ? `${t.usable_area_ha} ha` : '—'} />
              <Metric k="DC capacity" v={l ? `${(l.dc_capacity_kwp / 1000).toFixed(2)} MWp` : '—'} />
              <Metric k="Tables" v={l?.table_count ?? '—'} />
              <Metric k="Modules" v={l?.module_count ?? '—'} />
              <Metric k="Inverters" v={e ? `${e.inverter_count}×${e.inverter_capacity_kw}kW` : '—'} />
              <Metric k="DC/AC" v={e?.dc_ac_ratio ?? '—'} />
              <Metric k="Generation" v={y ? `${y.annual_energy_mwh} MWh/yr` : '—'} />
              <Metric k="Spec. yield" v={y ? `${y.specific_yield_kwh_per_kwp}` : '—'} />
              <Metric k="Transformer" v={e?.transformer_kva ? `${e.transformer_kva} kVA` : '—'} />
              <Metric k="BOM lines" v={b?.line_count ?? '—'} />
              <Metric k="Strings" v={e ? `${e.string_count}×${e.modules_per_string}` : '—'} />
            </div>
          </Section>
        )}

        {y?.monthly_generation_kwh && (
          <Section title="Monthly generation (kWh)" defaultOpen>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={y.monthly_generation_kwh.map((v: number, i: number) => ({
                  m: ['J','F','M','A','M','J','J','A','S','O','N','D'][i], v: Math.round(v),
                }))}>
                  <XAxis dataKey="m" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={45} />
                  <Tooltip contentStyle={{ background: '#11161d', border: '1px solid #303139', fontSize: 12 }} />
                  <Bar dataKey="v" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {onReport && (
              <button onClick={onReport}
                className="mt-1.5 w-full py-1.5 rounded text-xs bg-[#141a24] hover:bg-[#303139] text-slate-300">
                📄 See full report
              </button>
            )}
          </Section>
        )}
        {b && (
          <Section title={`Bill of materials (${b.line_count} lines)`}>
            {b.packages.map((p: any) => (
              <div key={p.package} className="mb-1">
                <div className="text-xs font-semibold text-blue-300">{p.package}</div>
                {p.items.map((i: any) => (
                  <div key={i.item} className="flex justify-between text-xs text-slate-300 pl-2">
                    <span>{i.item}{(i.dno_confirmation_required || i.supplier_confirmation_required) && <span className="text-yellow-400"> ⚠</span>}</span>
                    <span className="text-slate-400">{i.quantity} {i.unit}</span>
                  </div>
                ))}
              </div>
            ))}
          </Section>
        )}

        {!!design?.warnings?.length && (
          <Section title={`Warnings & assumptions (${design.warnings.length})`} warn defaultOpen>
            {design.warnings.map((w, i) => <div key={i} className="text-xs text-yellow-200/80 py-0.5">⚠ {w}</div>)}
            {design.assumptions.map((w, i) => <div key={'a' + i} className="text-xs text-slate-400 py-0.5">· {w}</div>)}
          </Section>
        )}

        {design && (
          <Section title="Export">
            <button onClick={doExport} className="w-full py-1.5 rounded-lg text-sm bg-amber-700/70 hover:bg-amber-600">
              Export project package
            </button>
            <button onClick={doProposal} disabled={propBusy}
              className="mt-1 w-full py-1.5 rounded text-xs bg-[#141a24] hover:bg-[#303139] text-slate-300 disabled:opacity-50">
              {propBusy ? 'Beam is writing…' : '⚡ Beam proposal (narrative)'}
            </button>
            {proposal && (
              <div className="mt-1.5">
                <div className="text-[10px] text-slate-500 italic mb-0.5">
                  {proposal.mode === 'beam' ? 'written by Beam — numbers from the design pipeline' : 'template fallback — Beam offline'}
                </div>
                <div className="max-h-64 overflow-y-auto text-xs text-slate-300 whitespace-pre-wrap bg-[#10141c] rounded p-2">
                  {proposal.markdown}
                </div>
              </div>
            )}
            {exports_ && (
              <div className="mt-1 flex flex-col gap-0.5">
                {Object.entries(exports_).map(([k, v]) => (
                  <a key={k} href={v} download className="text-xs text-blue-300 hover:underline">{k}</a>
                ))}
              </div>
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children, defaultOpen = false, warn = false, pulse = false }:
  { title: string; children: React.ReactNode; defaultOpen?: boolean; warn?: boolean; pulse?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`panel shrink-0 ${warn ? 'border-yellow-700/50' : ''}`}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-2.5 py-2 text-left select-none">
        <span className={`tech-label flex items-center gap-1.5 ${warn ? 'text-yellow-400' : 'text-slate-300'}`}>
          {pulse && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />}
          {title}
        </span>
        <span className={`text-xs transition-transform duration-150 ${open ? 'rotate-180' : ''} text-slate-500`}>▾</span>
      </button>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  )
}

function Metric({ k, v }: { k: string; v: any }) {
  return (
    <div className="metric-card">
      <div className="text-[10px] uppercase text-slate-500">{k}</div>
      <div className="text-sm font-semibold text-slate-100">{v}</div>
    </div>
  )
}
