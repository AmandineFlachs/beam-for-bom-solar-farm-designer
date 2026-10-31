import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import * as Cesium from 'cesium'
import MapView, { flyTo, frameSite3d, type DrawMode, type PickedInfo } from './MapView'
import Scene3D from './Scene3D'
import ReportView from './ReportView'
import StartScreen from './StartScreen'
import LeftPanel from './LeftPanel'
import RightPanel from './RightPanel'
import { api, defaultAssumptions, outerRings, type Design, type DesignAssumptions, type Exclusion, type GeoPolygon, type Step } from './api'

/** Error boundary: a crash inside the map shows a message instead of a
 * black page (React unmounts the whole tree on uncaught render errors). */
class MapErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null }
  static getDerivedStateFromError(e: any) { return { err: e?.message ?? String(e) } }
  render() {
    if (this.state.err) return (
      <div className="w-full h-full flex items-center justify-center bg-[#0b0f14]">
        <div className="panel p-4 max-w-md text-sm text-red-200">
          <div className="font-semibold mb-1">Map failed to render</div>
          {this.state.err}
        </div>
      </div>
    )
    return this.props.children
  }
}

export default function App() {
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [boundary, setBoundary] = useState<number[][]>([])
  const [parcels, setParcels] = useState<number[][][]>([])  // finished boundary rings
  const [exclusions, setExclusions] = useState<Exclusion[]>([])
  const [pendingEx, setPendingEx] = useState<number[][]>([])
  const [siteId, setSiteId] = useState<string | null>(null)
  const [design, setDesign] = useState<Design | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [assumptions, setAssumptions] = useState<DesignAssumptions>(defaultAssumptions)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view3d, setView3d] = useState(false)
  const [preview3d, setPreview3d] = useState(false)
  const [report, setReport] = useState(false)
  const [started, setStarted] = useState(false)
  const [rightOpen, setRightOpen] = useState(true)
  const [leftOpen, setLeftOpen] = useState(true)
  const [sunHour, setSunHour] = useState(15)
  const [sunPlaying, setSunPlaying] = useState(false)
  const [picked, setPicked] = useState<PickedInfo | null>(null)

  const onBoundaryPoint = useCallback((p: number[]) => setBoundary(b => [...b, p]), [])
  const onExclusionPoint = useCallback((p: number[]) => setPendingEx(b => [...b, p]), [])
  const onPick = useCallback((i: PickedInfo | null) => setPicked(i), [])

  const finishShape = () => {
    if (drawMode === 'boundary' && boundary.length >= 3) {
      setParcels(p => [...p, boundary])
      setBoundary([])
    }
    if (drawMode === 'exclusion' && pendingEx.length >= 3) {
      setExclusions(exs => [...exs, {
        id: `exclusion_${exs.length + 1}`, label: 'Exclusion',
        geometry: { type: 'Polygon', coordinates: [[...pendingEx, pendingEx[0]]] },
      }])
      setPendingEx([])
    }
    setDrawMode('none')
  }

  const clearAll = () => {
    setBoundary([]); setParcels([]); setExclusions([]); setPendingEx([])
    setDesign(null); setSteps([]); setSiteId(null); setDrawMode('none')
    setError(null); setPicked(null)
  }

  const runDesign = async (sid: string, a: DesignAssumptions) => {
    setSteps([])
    const d = await api.designStream(sid, a, s =>
      setSteps(prev => {
        const i = prev.findIndex(x => x.step === s.step)
        return i >= 0 ? prev.map((x, j) => j === i ? s : x) : [...prev, s]
      }))
    setDesign(d)
    return d
  }

  const allRings = (b: number[][] = boundary, p: number[][][] = parcels) =>
    [...p, ...(b.length >= 3 ? [b] : [])]

  const generate = async (b: number[][] = boundary, exs: Exclusion[] = exclusions,
    a: DesignAssumptions = assumptions) => {
    const rings = allRings(b)
    if (!rings.length) { setError('Draw a boundary with at least 3 points.'); return }
    setGenerating(true); setError(null); setDesign(null); setPicked(null)
    setSteps([{ step: 'boundary', status: 'active', summary: 'Uploading site…' }])
    try {
      const poly: GeoPolygon = rings.length === 1
        ? { type: 'Polygon', coordinates: [[...rings[0], rings[0][0]]] }
        : { type: 'MultiPolygon', coordinates: rings.map(r => [[...r, r[0]]]) }
      const { site_id } = await api.createSite('Hackathon Field', poly, exs)
      setSiteId(site_id)
      const d = await runDesign(site_id, a)
      // auto-dive into 3D once the layout is computed
      if (d?.site?.centroid) {
        setView3d(true); setSunHour(9.5)
        frameSite3d(viewerRef.current, outerRings(d.site.boundary).flat())
      }
    } catch (e: any) {
      setError(e.message)
      setSteps(prev => [...prev, { step: 'error', status: 'failed', summary: e.message }])
    }
    setGenerating(false)
  }

  // Demo: committed Escrick Field site + warm caches → works offline
  const runDemo = async () => {
    setGenerating(true); setError(null); setDesign(null); setPicked(null)
    try {
      const { site_id } = await api.demo()
      const site = await fetch(`/api/site/${site_id}`).then(r => r.json())
      const rings = outerRings(site.boundary)
      setBoundary(rings[0]); setParcels(rings.slice(1))
      setExclusions(site.exclusions); setPendingEx([])
      setSiteId(site_id)
      flyTo(viewerRef.current, site.centroid.lon, site.centroid.lat, 2500)
      // demo on a ~7 ha field: 1.2 MWp only fills a corner — size to the site
      const demoA = { ...assumptions, target: { ...assumptions.target, target_dc_capacity_mwp: 4.0 } }
      const d = await runDesign(site_id, demoA)
      if (d?.site?.centroid) {
        setView3d(true); setSunHour(9.5)
        frameSite3d(viewerRef.current, outerRings(d.site.boundary).flat())
      }
    } catch (e: any) {
      setError(e.message)
    }
    setGenerating(false)
  }

  // surface any runtime error in the UI (no devtools needed)
  useEffect(() => {
    const onErr = (e: ErrorEvent) => setError(`JS error: ${e.message}`)
    const onRej = (e: PromiseRejectionEvent) => setError(`Async error: ${e.reason?.message ?? e.reason}`)
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
    }
  }, [])

  // 24h sun timelapse: ~15 min of sun per real second (90× speed)
  useEffect(() => {
    if (!sunPlaying) return
    const id = setInterval(() => setSunHour(h => (h + 0.25) % 24), 100)
    return () => clearInterval(id)
  }, [sunPlaying])

  const zoomBy = (dir: 1 | -1) => {
    const c = viewerRef.current?.camera
    if (!c) return
    const h = c.positionCartographic.height
    dir === 1 ? c.zoomIn(h * 0.25) : c.zoomOut(h * 0.33)
  }

  const pendingExclusions: Exclusion[] = pendingEx.length >= 3
    ? [...exclusions, { id: 'pending', label: 'pending', geometry: { type: 'Polygon', coordinates: [[...pendingEx, pendingEx[0]]] } }]
    : exclusions

  return (
    <div className="relative h-full overflow-hidden">
      {/* full-bleed map — kept mounted (Cesium canvas can't survive unmount),
          hidden while the report occupies the main pane */}
      <div className="absolute inset-0" style={{ display: report ? 'none' : 'block' }}>
        <MapErrorBoundary>
          <MapView drawMode={drawMode} boundary={boundary} parcels={parcels} exclusions={pendingExclusions}
            design={design} view3d={view3d} tiltDeg={assumptions.array.tilt_degrees}
            sunHour={sunHour}
            onBoundaryPoint={onBoundaryPoint} onExclusionPoint={onExclusionPoint}
            onPick={onPick} viewerRef={viewerRef} />
        </MapErrorBoundary>
      </div>
      {report && design && (
        <div className="absolute inset-0 z-40">
          <ReportView design={design} onClose={() => setReport(false)} />
        </div>
      )}

      {/* floating glass side panels — appear after the start screen */}
      {started && (
      <div className="absolute left-3 top-3 bottom-3 w-[292px] z-10 fade-in pointer-events-none">
        <button onClick={() => setLeftOpen(o => !o)}
          className="mapbtn pointer-events-auto absolute top-1/2 -translate-y-1/2 w-6 h-14 text-xs z-20"
          style={leftOpen ? { right: '-1.75rem' } : { left: '0.25rem' }}
          title={leftOpen ? 'Collapse panel' : 'Expand panel'}>
          {leftOpen ? '◂' : '▸'}
        </button>
        {!leftOpen && (
          <div className="pointer-events-auto absolute top-0 left-0 panel px-3 py-2">
            <div className="text-sm font-extrabold brand-text whitespace-nowrap">BEAM for BOM: Solar Farm</div>
          </div>
        )}
        <div className={`panel h-full overflow-hidden pointer-events-auto transition-transform duration-300 ${leftOpen ? '' : '-translate-x-[calc(100%+16px)]'}`}>
        <LeftPanel
          onFlyTo={(lon, lat) => flyTo(viewerRef.current, lon, lat, 20000)}
          drawMode={drawMode} setDrawMode={setDrawMode}
          boundaryCount={drawMode === 'exclusion' ? pendingEx.length : boundary.length}
          parcelCount={parcels.length}
          onFinishBoundary={finishShape} onClearAll={clearAll}
          onRemoveLastExclusion={() => setExclusions(e => e.slice(0, -1))}
          exclusionCount={exclusions.length}
          assumptions={assumptions} setAssumptions={setAssumptions}
          onGenerate={() => generate()} generating={generating}
          canGenerate={allRings().length > 0}
          onDemo={runDemo}
        />
        </div>
      </div>
      )}
      {(generating || design) && (
        <div className="absolute right-3 top-3 bottom-3 w-[340px] z-10 fade-in pointer-events-none">
          <button onClick={() => setRightOpen(o => !o)}
            className="mapbtn pointer-events-auto absolute top-1/2 -translate-y-1/2 w-6 h-14 text-xs z-20"
            style={rightOpen ? { left: '-1.75rem' } : { right: '0.25rem' }}
            title={rightOpen ? 'Collapse panel' : 'Expand panel'}>
            {rightOpen ? '▸' : '◂'}
          </button>
          <div className={`panel h-full overflow-hidden pointer-events-auto transition-transform duration-300 ${rightOpen ? '' : 'translate-x-[calc(100%+16px)]'}`}>
            <RightPanel design={design} steps={steps} siteId={siteId}
              onDesign={(d, s) => { setDesign(d); setSteps(s) }} assumptions={assumptions}
              onReport={() => setReport(true)} />
          </div>
        </div>
      )}

      {/* map overlays — each opts back into pointer events individually;
          hidden while the start screen or report occupies the main pane */}
      {started && !report && (
      <div className="absolute inset-0 pointer-events-none">
        {/* view toggles */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex gap-2 pointer-events-auto">
          {design && (
            <>
              <button onClick={() => setPreview3d(true)}
                className="mapbtn px-3 py-1.5 text-xs">
                🌍 3D Preview
              </button>
              <button onClick={() => setReport(true)}
                className="mapbtn px-3 py-1.5 text-xs">
                📄 Report
              </button>
            </>
          )}
        </div>
        {preview3d && design && (
          <Scene3D design={design} tiltDeg={assumptions.array.tilt_degrees}
            azimuthDeg={assumptions.array.azimuth_degrees}
            onClose={() => setPreview3d(false)} />
        )}
        {/* zoom controls */}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-4 z-10 flex gap-1.5 pointer-events-auto">
          <button onClick={() => zoomBy(1)} className="mapbtn w-8 h-8 text-lg leading-none">+</button>
          <button onClick={() => zoomBy(-1)} className="mapbtn w-8 h-8 text-lg leading-none">−</button>
        </div>
        {view3d && (
          <div className="absolute bottom-4 left-[308px] z-10 panel px-3 py-2 flex items-center gap-2 pointer-events-auto">
            <button onClick={() => setSunPlaying(p => !p)}
              className="text-sm w-6" title="Animate 24 h sun cycle">
              {sunPlaying ? '⏸' : '▶'}
            </button>
            <span className="text-xs text-slate-400">☀ {String(Math.floor(sunHour)).padStart(2, '0')}:{String(Math.round((sunHour % 1) * 60)).padStart(2, '0')}</span>
            <input type="range" min={0} max={23.75} step={0.25} value={sunHour % 24}
              onChange={e => setSunHour(+e.target.value)}
              className="w-40 accent-yellow-400" />
            <span className="text-[10px] text-slate-500">shading follows the sun</span>
          </div>
        )}
        {picked && (
          <div className="absolute top-14 right-[356px] z-10 panel p-3 w-56 pointer-events-auto">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs uppercase text-slate-400">{picked.kind}</span>
              <button onClick={() => setPicked(null)} className="text-slate-500 text-xs">✕</button>
            </div>
            <div className="text-sm font-semibold text-white mb-1">{picked.id}</div>
            {picked.lines.map(l => (
              <div key={l.k} className="flex justify-between gap-2 text-xs py-0.5">
                <span className="text-slate-500">{l.k}</span>
                <span className="text-slate-200 text-right">{l.v}</span>
              </div>
            ))}
          </div>
        )}
        {/* legend — collapsible, bottom-left, clear of top buttons */}
        {design && (
          <div className={`absolute bottom-14 z-10 panel px-2.5 py-1.5 text-[10px] pointer-events-auto transition-all duration-300 ${leftOpen ? 'left-[308px]' : 'left-10'}`}>
            <button onClick={e => (e.currentTarget.parentElement!.querySelector('.lg-body') as HTMLElement)?.classList.toggle('hidden')}
              className="uppercase text-slate-400 w-full text-left hover:text-slate-200">Legend ▾</button>
            <div className="lg-body space-y-0.5 mt-1">
            {[
              ['#3b82f6', 'PV table'],
              ['#22c55e', 'Suitable'],
              ['#ef4444', 'Exclusion'],
              ['#eab308', 'Cables'],
              ['#f97316', 'Inverter'],
              ['#a855f7', 'Transformer'],
              ['#22d3ee', 'Boundary'],
            ].map(([c, l]) => (
              <div key={l} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />
                <span className="text-slate-300">{l}</span>
              </div>
            ))}
            </div>
          </div>
        )}
        {error && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-red-900/90 border border-red-600 text-red-100 text-sm rounded px-3 py-2 z-10">
            {error}
          </div>
        )}
        {drawMode !== 'none' && (
          <div className="absolute bottom-16 left-1/2 -translate-x-1/2 mapbtn text-xs text-slate-200 px-3 py-1.5 z-10">
            Click the map to add {drawMode === 'boundary' ? 'boundary' : 'exclusion'} points · “Finish shape” when done
          </div>
        )}
      </div>
      )}

      {/* start screen — sits over everything until a choice is made */}
      {!started && (
        <StartScreen
          busy={generating}
          onPick={(lon, lat) => {
            setStarted(true)
            setTimeout(() => flyTo(viewerRef.current, lon, lat, 12000), 50)
          }}
          onDemo={() => { setStarted(true); runDemo() }}
        />
      )}
    </div>
  )
}
