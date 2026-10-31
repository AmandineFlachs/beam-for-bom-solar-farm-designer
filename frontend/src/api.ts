export type GeoPolygon = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] }
export interface Exclusion { id: string; label: string; geometry: GeoPolygon }

export interface DesignAssumptions {
  module: { wattage: number; voc: number; length_m: number; width_m: number }
  array: {
    mounting: string; tilt_degrees: number; azimuth_degrees: number
    modules_per_table_row: number; module_rows_per_table: number
    row_pitch_m: number; boundary_setback_m: number; exclusion_setback_m: number
    access_aisle_every_n_rows: number; access_aisle_width_m: number
    max_slope_degrees: number
  }
  grid: { connection_voltage: string; max_lv_connection_kw: number }
  target: { mode: string; target_dc_capacity_mwp?: number; land_use_factor: number }
  system_loss_percent: number
}

export const defaultAssumptions: DesignAssumptions = {
  module: { wattage: 430, voc: 49.8, length_m: 2.3, width_m: 1.1 },
  array: {
    mounting: 'fixed_tilt', tilt_degrees: 20, azimuth_degrees: 180,
    modules_per_table_row: 12, module_rows_per_table: 2,
    row_pitch_m: 6, boundary_setback_m: 5, exclusion_setback_m: 3,
    access_aisle_every_n_rows: 8, access_aisle_width_m: 4, max_slope_degrees: 8,
  },
  grid: { connection_voltage: '11kV', max_lv_connection_kw: 400 },
  target: { mode: 'target_capacity', target_dc_capacity_mwp: 1.2, land_use_factor: 1.0 },
  system_loss_percent: 14,
}

export interface Design {
  site: any
  terrain?: any
  layout?: any
  electrical?: any
  yield?: any
  bom?: any
  beam_summary?: any
  warnings: string[]
  assumptions: string[]
}

export interface Step { step: string; status: string; summary: string }

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText)
  return r.json()
}

export const api = {
  getProposal: async (siteId: string) => { const r = await fetch('/api/proposal', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({site_id: siteId})}); return r.json(); },
  createSite: (name: string, boundary: GeoPolygon, exclusions: Exclusion[]) =>
    fetch('/api/site', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, boundary, exclusions }) }).then(j<{ site_id: string }>),

  design: (site_id: string, design_assumptions: DesignAssumptions) =>
    fetch('/api/design', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id, design_assumptions }) }).then(j<Design>),

  chat: (site_id: string | null, message: string, design_assumptions?: DesignAssumptions,
         effort?: string) =>
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id, message, design_assumptions, effort }) })
      .then(j<{
        reply: string; design: Design | null; steps: Step[]
        reasoning?: string | null
        meta?: { model?: string; effort?: string; mode?: string; latency_s?: number
                 prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }
      }>),

  export: (site_id: string) =>
    fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id, format: 'all' }) }).then(j<Record<string, string>>),

  /** Streamed design run: calls onStep per workflow step, resolves to Design. */
  designStream: async (
    site_id: string, design_assumptions: DesignAssumptions,
    onStep: (s: Step) => void,
  ): Promise<Design> => {
    const r = await fetch('/api/design/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site_id, design_assumptions }),
    })
    if (!r.ok || !r.body) throw new Error(`stream failed: ${r.status}`)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = '', result: Design | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const events = buf.split('\n\n'); buf = events.pop()!
      for (const ev of events) {
        const line = ev.trim().replace(/^data: /, '')
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.type === 'step') onStep(msg.data)
        else if (msg.type === 'result') result = msg.data
        else if (msg.type === 'error') throw new Error(msg.data.detail)
      }
    }
    if (!result) throw new Error('stream ended without result')
    return result
  },

  demo: () =>
    fetch('/api/demo', { method: 'POST' }).then(j<{ site_id: string }>),

  conditions: (site_id: string) =>
    fetch(`/api/site/${site_id}/conditions`).then(j<{
      source: string; ghi_wm2?: number; dni_wm2?: number; temperature_c?: number
      cloud_cover_pct?: number; wind_ms?: number; is_day?: boolean; fetched_at?: string
    }>),

  geocode: (q: string) =>
    fetch(`/api/geocode?q=${encodeURIComponent(q)}`)
      .then(j<{ results: { name: string; lat: number; lon: number; admin?: string; country?: string }[] }>),
}
