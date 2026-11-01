import { useState } from 'react'
import { api } from './api'

interface Props {
  onPick: (lon: number, lat: number) => void
  onDemo: () => void
  busy: boolean
}

/** Opening screen: no map — just location search or the demo. The globe
 * zooms in behind the card once a choice is made. */
export default function StartScreen({ onPick, onDemo, busy }: Props) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])

  const search = async () => {
    if (!q.trim()) return
    try { setResults((await api.geocode(q)).results.slice(0, 5)) } catch { setResults([]) }
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#07090e]/95 backdrop-blur-md fade-in">
      <div className="panel p-8 w-[420px] text-center">
        <h1 className="text-4xl font-extrabold brand-text mb-2">BEAM for BOM: Solar Farm Designer</h1>
        <p className="text-sm text-slate-300 mb-6">
          Draw a boundary. Beam designs the solar farm<br />and tells you what to buy.
        </p>

        <div className="flex gap-1.5 mb-2">
          <input
            className="flex-1 bg-[#10141c] border border-[#303139] rounded-lg px-3 py-2 text-sm"
            value={q} placeholder="Search a place — e.g. York, UK"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            autoFocus />
          <button onClick={search}
            className="px-4 bg-amber-600 hover:bg-amber-500 rounded-lg text-sm font-semibold text-black">
            Go
          </button>
        </div>
        {results.length > 0 && (
          <div className="panel mb-4 text-left divide-y divide-white/5">
            {results.map(r => (
              <button key={r.lat + r.name}
                className="block w-full text-left px-3 py-2 text-sm text-amber-300 hover:bg-white/5 first:rounded-t-lg last:rounded-b-lg"
                onClick={() => onPick(r.lon, r.lat)}>
                {r.name}{r.admin ? `, ${r.admin}` : ''}{r.country ? ` (${r.country})` : ''}
              </button>
            ))}
          </div>
        )}

        <div className="text-[11px] uppercase tracking-wide text-slate-500 my-3">or</div>
        <button onClick={onDemo} disabled={busy}
          className="w-full py-2.5 rounded-lg font-semibold text-sm text-black bg-gradient-to-r from-amber-600 to-amber-500 cta-glow disabled:opacity-40">
          {busy ? 'Starting…' : '⚡ Run the demo — East York Water Field, Vale of York'}
        </button>
        <p className="text-[10px] text-slate-500 mt-4 leading-snug">
        </p>
      </div>
    </div>
  )
}
