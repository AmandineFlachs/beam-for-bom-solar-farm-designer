import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Design } from './api'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/** Full-page design report: sun exposure, generation, electrical, terrain, BOM. */
export default function ReportView({ design, onClose }: { design: Design; onClose: () => void }) {
  const t = design.terrain, l = design.layout, e = design.electrical,
        y = design.yield, b = design.bom, site = design.site

  const monthly = (y?.monthly_generation_kwh ?? []).map((v: number, i: number) => ({
    m: MONTHS[i], kwh: Math.round(v),
  }))
  const best = monthly.reduce((a: any, c: any) => c.kwh > (a?.kwh ?? -1) ? c : a, monthly[0])
  const worst = monthly.reduce((a: any, c: any) => c.kwh < (a?.kwh ?? Infinity) ? c : a, monthly[0])

  const kpis: [string, string, string][] = [
    ['DC capacity', l ? `${(l.dc_capacity_kwp / 1000).toFixed(2)} MWp` : '—', `${l?.module_count ?? '?'} modules · ${l?.table_count ?? '?'} tables`],
    ['Annual generation', y ? `${y.annual_energy_mwh.toLocaleString()} MWh` : '—', `${Math.round(y?.annual_energy_kwh ?? 0).toLocaleString()} kWh/yr`],
    ['Specific yield', y ? `${Math.round(y.specific_yield_kwh_per_kwp)} kWh/kWp` : '—', y?.performance_ratio != null ? `PR ${(y.performance_ratio * 100).toFixed(0)}%` : ''],
    ['Site area', t ? `${t.total_area_ha} ha` : '—', t ? `${t.usable_area_ha} ha usable` : ''],
  ]

  const rows = (arr: [string, string][]) => arr.map(([k, v]) => (
    <div key={k} className="flex justify-between gap-4 py-1 border-b border-white/5 text-sm">
      <span className="text-slate-400">{k}</span><span className="text-slate-100 text-right">{v}</span>
    </div>
  ))

  return (
    <div className="w-full h-full overflow-y-auto bg-[#0b0f14] fade-in">
      <div className="max-w-3xl mx-auto py-6 px-4">
        <div className="flex items-start justify-between mb-5">
          <div>
            <button onClick={onClose} className="mapbtn px-3 py-1.5 text-xs mb-2">← Back to map</button>
            <h1 className="text-2xl font-extrabold brand-text">Site report</h1>
            <div className="text-xs text-slate-400 mt-0.5">
              {site?.name ?? 'Solar site'} · {site?.centroid ? `${site.centroid.lat.toFixed(4)}, ${site.centroid.lon.toFixed(4)}` : ''}
              {' '}· generated {new Date().toLocaleDateString()}
            </div>
          </div>
          <button onClick={() => window.print()} className="mapbtn px-3 py-1.5 text-xs mt-1">🖨 Print / PDF</button>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-4 gap-2 mb-5">
          {kpis.map(([k, v, sub]) => (
            <div key={k} className="metric-card">
              <div className="text-[10px] uppercase text-slate-500">{k}</div>
              <div className="text-lg font-bold text-white leading-tight">{v}</div>
              <div className="text-[10px] text-slate-400">{sub}</div>
            </div>
          ))}
        </div>

        {/* sun + generation */}
        {monthly.length === 12 && (
          <section className="mb-5">
            <h2 className="text-xs uppercase tracking-wide text-amber-300 mb-2">☀ Sun exposure & generation</h2>
            <div className="h-44 mb-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#223041" vertical={false} />
                  <XAxis dataKey="m" tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={52} />
                  <Tooltip contentStyle={{ background: '#11161d', border: '1px solid #223041', fontSize: 12 }}
                    formatter={(v: any) => [`${Number(v).toLocaleString()} kWh`, 'Generation']} />
                  <Bar dataKey="kwh" fill="#fbbf24" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {rows([
                ['Best month', `${best.m} — ${best.kwh.toLocaleString()} kWh`],
                ['Lowest month', `${worst.m} — ${worst.kwh.toLocaleString()} kWh`],
              ])}
              {rows([
                ['Summer share (Apr–Sep)', `${((monthly.slice(3, 9).reduce((s: number, m: any) => s + m.kwh, 0) / y.annual_energy_kwh) * 100).toFixed(0)}%`],
                ['Source', y.source ?? 'PVGIS'],
              ])}
            </div>
          </section>
        )}

        <div className="grid grid-cols-2 gap-5 mb-5">
          {/* electrical */}
          <section>
            <h2 className="text-xs uppercase tracking-wide text-sky-300 mb-2">⚡ Electrical</h2>
            {rows([
              ['Strings', e ? `${e.string_count} × ${e.modules_per_string} modules` : '—'],
              ['Inverters', e ? `${e.inverter_count} × ${e.inverter_capacity_kw} kW (${e.inverter_model})` : '—'],
              ['DC/AC ratio', e?.dc_ac_ratio ?? '—'],
              ['Est. DC cable', e ? `${Math.round(e.estimated_dc_cable_length_m).toLocaleString()} m` : '—'],
              ['Est. AC cable', e ? `${Math.round(e.estimated_ac_cable_length_m).toLocaleString()} m` : '—'],
              ['Voltage drop', e ? `${e.voltage_drop_percent}%` : '—'],
              ['Transformer', e?.transformer_required ? `${e.transformer_kva} kVA` : 'Not required'],
              ['Grid connection', e?.grid_connection_recommendation ?? '—'],
            ])}
          </section>
          {/* terrain + layout */}
          <section>
            <h2 className="text-xs uppercase tracking-wide text-green-300 mb-2">⛰ Terrain & layout</h2>
            {rows([
              ['Total area', t ? `${t.total_area_ha} ha` : '—'],
              ['Usable area', t ? `${t.usable_area_ha} ha` : '—'],
              ['Excluded area', t ? `${t.excluded_area_ha} ha` : '—'],
              ['Auto-detected constraints', t ? `${(t.auto_exclusions ?? []).length} (OSM)` : '—'],
              ['Average slope', t ? `${t.average_slope_degrees}°` : '—'],
              ['Max slope', t ? `${t.max_slope_degrees}°` : '—'],
              ['Modules', l?.module_count?.toLocaleString() ?? '—'],
              ['Tables', l?.table_count ?? '—'],
            ])}
          </section>
        </div>

        {/* BOM summary */}
        {b && (
          <section className="mb-5">
            <h2 className="text-xs uppercase tracking-wide text-purple-300 mb-2">📦 Bill of materials — {b.line_count} lines</h2>
            <div className="grid grid-cols-2 gap-x-6">
              {b.packages.map((p: any) => (
                <div key={p.package} className="mb-2">
                  <div className="text-xs font-semibold text-blue-300 mb-0.5">{p.package}</div>
                  {p.items.map((i: any) => (
                    <div key={i.item} className="flex justify-between text-xs text-slate-300">
                      <span>{i.item}</span>
                      <span className="text-slate-400">{i.quantity} {i.unit}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* warnings */}
        {!!design.warnings?.length && (
          <section className="mb-2">
            <h2 className="text-xs uppercase tracking-wide text-yellow-400 mb-2">⚠ Warnings & assumptions</h2>
            {design.warnings.map((w, i) => <div key={i} className="text-xs text-yellow-200/80 py-0.5">⚠ {w}</div>)}
            {design.assumptions.map((w, i) => <div key={'a' + i} className="text-xs text-slate-400 py-0.5">· {w}</div>)}
          </section>
        )}

        <div className="text-[10px] text-slate-500 mt-4">
          Preliminary feasibility and procurement-planning only — not a bankable,
          construction-ready, or grid-application design. DNO confirmation always required.
        </div>
      </div>
    </div>
  )
}
