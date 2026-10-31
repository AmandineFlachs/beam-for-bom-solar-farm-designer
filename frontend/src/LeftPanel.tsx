import { useState } from 'react'
import type { DesignAssumptions } from './api'
import { api } from './api'

interface Props {
  onFlyTo: (lon: number, lat: number) => void
  drawMode: string
  setDrawMode: (m: any) => void
  boundaryCount: number
  parcelCount?: number
  onFinishBoundary: () => void
  onClearAll: () => void
  onRemoveLastExclusion: () => void
  exclusionCount: number
  assumptions: DesignAssumptions
  setAssumptions: (a: DesignAssumptions) => void
  onGenerate: () => void
  generating: boolean
  canGenerate: boolean
  onDemo: () => void
}

const input = 'w-full bg-[#10141c] border border-[#303139] rounded px-2 py-1.5 text-sm font-mono'
const label = 'tech-label'

export default function LeftPanel(p: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const a = p.assumptions

  const set = (path: string, v: any) => {
    const next = structuredClone(a)
    const parts = path.split('.')
    let o: any = next
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]
    o[parts.at(-1)!] = v
    p.setAssumptions(next)
  }

  const search = async () => {
    if (!q.trim()) return
    try { setResults((await api.geocode(q)).results) } catch { setResults([]) }
  }

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto h-full">
      <div>
        <h1 className="text-xl font-extrabold brand-text">BEAM for BOM: Solar Farm</h1>
        <p className="text-xs text-slate-400">Draw a boundary. Beam designs the solar farm and tells you what to buy.</p>
      </div>

      <div className="panel p-2">
        <div className={label}>LOCATION SEARCH</div>
        <div className="flex gap-1 mt-1">
          <input className={input} value={q} placeholder="Place name…"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()} />
          <button className="px-2 bg-amber-600/80 hover:bg-amber-500 rounded text-sm font-semibold text-black" onClick={search}>Go</button>
        </div>
        {results.map(r => (
          <button key={r.lat + r.name} className="block text-left text-xs text-blue-300 hover:underline mt-1"
            onClick={() => { p.onFlyTo(r.lon, r.lat); setResults([]) }}>
            {r.name}{r.admin ? `, ${r.admin}` : ''}{r.country ? ` (${r.country})` : ''}
          </button>
        ))}
      </div>

      <div className="panel p-2 flex flex-col gap-2">
        <div className={label}><span className="text-amber-500">01</span> — SITE</div>
        <div className="flex gap-2">
          <button onClick={() => p.setDrawMode(p.drawMode === 'boundary' ? 'none' : 'boundary')}
            className={`flex-1 py-1.5 rounded text-sm ${p.drawMode === 'boundary' ? 'bg-amber-600/80' : 'bg-[#141a24] hover:bg-[#303139]'}`}>
            {p.drawMode === 'boundary' ? 'Click map…' : 'Draw boundary'}
          </button>
          <button onClick={() => p.setDrawMode(p.drawMode === 'exclusion' ? 'none' : 'exclusion')}
            className={`flex-1 py-1.5 rounded text-sm ${p.drawMode === 'exclusion' ? 'bg-red-600' : 'bg-[#141a24] hover:bg-[#303139]'}`}>
            {p.drawMode === 'exclusion' ? 'Click map…' : 'Draw exclusion'}
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={p.onFinishBoundary}
            className="flex-1 py-1 rounded text-xs bg-[#141a24] hover:bg-[#303139]">
            Finish shape ({p.boundaryCount} pts)
          </button>
          <button onClick={p.onClearAll}
            className="flex-1 py-1 rounded text-xs bg-[#141a24] hover:bg-[#303139] text-red-300">
            Clear all
          </button>
        </div>
        {(p.parcelCount ?? 0) > 0 && (
          <div className="text-[11px] text-cyan-300">
            {p.parcelCount} parcel{(p.parcelCount ?? 0) > 1 ? 's' : ''} drawn
            {p.boundaryCount >= 3 ? ' (+1 in progress)' : ''} — draw another to
            make a multi-parcel site
          </div>
        )}
        {p.exclusionCount > 0 && (
          <button onClick={p.onRemoveLastExclusion}
            className="py-1 rounded text-xs bg-[#141a24] hover:bg-[#303139] text-slate-300">
            Remove last exclusion ({p.exclusionCount} drawn)
          </button>
        )}
      </div>

      {p.canGenerate && (<>
      <details className="panel p-2 fade-up" open>
        <summary className={`${label} cursor-pointer select-none`}><span className="text-amber-500">02</span> — ASSUMPTIONS</summary>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div><div className={label}>Tilt °</div>
            <input type="number" className={input} value={a.array.tilt_degrees}
              onChange={e => set('array.tilt_degrees', +e.target.value)} /></div>
          <div><div className={label}>Azimuth °</div>
            <input type="number" className={input} value={a.array.azimuth_degrees}
              onChange={e => set('array.azimuth_degrees', +e.target.value)} /></div>
          <div><div className={label}>Module W</div>
            <input type="number" className={input} value={a.module.wattage}
              onChange={e => set('module.wattage', +e.target.value)} /></div>
          <div><div className={label}>Row pitch m</div>
            <input type="number" className={input} value={a.array.row_pitch_m}
              onChange={e => set('array.row_pitch_m', +e.target.value)} /></div>
          <div><div className={label}>Grid conn.</div>
            <select className={input} value={a.grid.connection_voltage}
              onChange={e => set('grid.connection_voltage', e.target.value)}>
              <option>400V</option><option>11kV</option><option>33kV</option>
            </select></div>
          <div><div className={label}>Target MWp</div>
            <input type="number" step="0.1" className={input}
              value={a.target.target_dc_capacity_mwp ?? ''}
              onChange={e => set('target.target_dc_capacity_mwp', +e.target.value)} /></div>
        </div>
      </details>

      <button onClick={p.onGenerate} disabled={!p.canGenerate || p.generating}
        className="py-2.5 rounded-lg font-semibold text-sm bg-gradient-to-r from-amber-600 to-amber-500 cta-glow disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none fade-up">
        {p.generating ? 'Generating…' : '⚡ Generate BEAM Design'}
      </button>
      </>)}
      <button onClick={p.onDemo}
        className="py-1.5 rounded text-xs bg-[#141a24] hover:bg-[#303139] text-slate-300">
        Run demo scenario (Escrick Field, ~7 ha)
      </button>
      <p className="text-[10px] text-slate-500 leading-snug">
        Demo only · preliminary feasibility estimate
      </p>
    </div>
  )
}
