import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { Design, Exclusion } from './api'
import { TerrariumTerrainProvider } from './terrain'

export type DrawMode = 'none' | 'boundary' | 'exclusion'
export interface PickedInfo {
  kind: string; id: string; lines: { k: string; v: string }[]
}

interface Props {
  drawMode: DrawMode
  boundary: number[][]
  parcels?: number[][][]   // additional finished boundary rings (multi-parcel sites)
  exclusions: Exclusion[]
  design: Design | null
  view3d: boolean
  tiltDeg: number
  sunHour: number            // 6..20, drives lighting + shadows
  onBoundaryPoint: (lonLat: number[]) => void
  onExclusionPoint: (lonLat: number[]) => void
  onPick: (info: PickedInfo | null) => void
  viewerRef: React.MutableRefObject<Cesium.Viewer | null>
}

const BLUE = Cesium.Color.fromCssColorString('#1e40af')
const RED = Cesium.Color.fromCssColorString('#ef4444')
const ORANGE = Cesium.Color.fromCssColorString('#f97316')
const PURPLE = Cesium.Color.fromCssColorString('#a855f7')
const GREEN = Cesium.Color.fromCssColorString('#22c55e')
const YELLOW = Cesium.Color.fromCssColorString('#eab308')
const BRICK = Cesium.Color.fromCssColorString('#8a6f5c')

const BASE_H = 0.7 // panel leading-edge clearance, m
const PHOTO_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

export const terrainProvider = new TerrariumTerrainProvider()

/** Bilinear elevation sampler over the suitability grid — fallback when
 * tileset height-sampling isn't available. */
function elevSampler(grid: any[] | undefined) {
  const pts = (grid ?? []).map((c: any) => ({ lat: c.lat, lon: c.lon, h: c.elevation_m }))
  const lats = [...new Set(pts.map(p => p.lat))].sort((a, b) => a - b)
  const lons = [...new Set(pts.map(p => p.lon))].sort((a, b) => a - b)
  const idx = new Map(pts.map(p => [`${p.lon}|${p.lat}`, p.h]))
  return (lon: number, lat: number) => {
    if (lats.length < 2 || lons.length < 2) return 0
    const cl = (v: number, a: number[]) => Math.min(Math.max(v, a[0]), a[a.length - 1])
    const lo = cl(lon, lons), la = cl(lat, lats)
    let i = lons.findIndex(v => v > lo); i = Math.max((i < 0 ? lons.length - 1 : i) - 1, 0)
    let j = lats.findIndex(v => v > la); j = Math.max((j < 0 ? lats.length - 1 : j) - 1, 0)
    const x0 = lons[i], x1 = lons[i + 1], y0 = lats[j], y1 = lats[j + 1]
    const fx = (lo - x0) / (x1 - x0 || 1), fy = (la - y0) / (y1 - y0 || 1)
    const h = (a: number, b: number) => idx.get(`${lons[a]}|${lats[b]}`) ?? 0
    return h(i, j) * (1 - fx) * (1 - fy) + h(i + 1, j) * fx * (1 - fy)
      + h(i, j + 1) * (1 - fx) * fy + h(i + 1, j + 1) * fx * fy
  }
}

/** PV panel texture — dark blue with module grid lines, generated once. */
let _panelTex: HTMLCanvasElement | null = null
function panelTexture(): HTMLCanvasElement {
  if (_panelTex) return _panelTex
  const c = document.createElement('canvas')
  c.width = 256; c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#12206b'; g.fillRect(0, 0, 256, 128)
  g.strokeStyle = '#2a44a8'; g.lineWidth = 2
  for (let x = 0; x <= 256; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke() }
  for (let y = 0; y <= 128; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke() }
  g.strokeStyle = '#060d30'; g.lineWidth = 8; g.strokeRect(0, 0, 256, 128)
  _panelTex = c
  return c
}

function treeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 64; c.height = 96
  const g = c.getContext('2d')!
  g.fillStyle = '#5d4037'; g.fillRect(28, 60, 8, 32)
  g.fillStyle = '#1b5e20'
  g.beginPath(); g.arc(32, 30, 24, 0, Math.PI * 2); g.fill()
  g.beginPath(); g.arc(20, 48, 16, 0, Math.PI * 2); g.fill()
  g.beginPath(); g.arc(44, 48, 16, 0, Math.PI * 2); g.fill()
  return c
}
let _treeTex: HTMLCanvasElement | null = null

export default function MapView({ drawMode, boundary, parcels = [], exclusions, design, view3d, tiltDeg, sunHour,
  onBoundaryPoint, onExclusionPoint, onPick, viewerRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const drawSource = useRef<Cesium.CustomDataSource | null>(null)
  const resultSource = useRef<Cesium.CustomDataSource | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const [tip, setTip] = useState<{ x: number; y: number; info: PickedInfo } | null>(null)
  const tilesetRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const esriTerrainRef = useRef<Cesium.TerrainProvider | null>(null)
  const [photoReady, setPhotoReady] = useState(false)
  const [terrainReady] = useState(false)

  // init viewer once (survives StrictMode double-mount); rebind listeners every run
  useEffect(() => {
    if (!containerRef.current) return
    const viewer = viewerRef.current ?? new Cesium.Viewer(containerRef.current, {
      baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        credit: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maximumLevel: 19,
      }), {}),
      baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false,
    })
    if (!viewerRef.current) {
      // one-time setup — skipped on the StrictMode remount
      // NOTE: globe stays on the default ellipsoid. Attaching the custom
      // terrarium provider crashes Cesium (imagery recursion), so instead the
      // map keeps a flat surface and entities are placed on it — satellite
      // imagery and entities then share one surface with no floating.
      viewer.scene.globe.enableLighting = true
      viewer.shadows = true
      // visual polish: sharper pixels + AA + bloom (fog stays off)
      viewer.resolutionScale = Math.min(window.devicePixelRatio, 2)
      try { viewer.scene.postProcessStages.fxaa.enabled = true } catch {}
      try {
        const bloom = (viewer.scene.postProcessStages as any).bloom
        if (bloom) { bloom.enabled = true; bloom.uniforms.glowOnly = false; bloom.uniforms.contrast = 118; bloom.uniforms.brightness = -0.3 }
      } catch {}
      try { viewer.scene.fog.enabled = false } catch {}
      const ctl = viewer.scene.screenSpaceCameraController
      ctl.minimumZoomDistance = 8
      ctl.maximumZoomDistance = 40_000_000
      // Trackpad-friendly scheme:
      //   one-finger drag grabs the globe (Cesium rotate — feels like pan) ·
      //   scroll/pinch zooms · two-finger-click drag pans · shift+drag tilts.
      ctl.rotateEventTypes = Cesium.CameraEventType.LEFT_DRAG
      ctl.translateEventTypes = Cesium.CameraEventType.RIGHT_DRAG
      ctl.tiltEventTypes = [
        Cesium.CameraEventType.MIDDLE_DRAG,
        { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.SHIFT },
      ]
      ctl.zoomEventTypes = Cesium.CameraEventType.PINCH  // touch pinch only; wheel handled manually below
      // park on the whole globe — the start screen zooms in when the
      // user picks a location or runs the demo
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(0, 30, 22_000_000),
      })
      drawSource.current = new Cesium.CustomDataSource('draw')
      resultSource.current = new Cesium.CustomDataSource('results')
      viewer.dataSources.add(drawSource.current)
      viewer.dataSources.add(resultSource.current)
      viewerRef.current = viewer
      ;(window as any).__viewer = viewer // debug hook
    }

    // Trackpad zoom — handled manually because macOS trackpads are flaky
    // through Cesium's event-type system:
    //   · two-finger scroll → plain wheel events
    //   · pinch            → wheel + ctrlKey (Chrome/Edge/Brave/Firefox)
    //   · pinch            → gesture* events (Safari)
    const canvas = viewer.scene.canvas
    const zoomBy = (amountM: number) =>
      amountM > 0 ? viewer.camera.zoomOut(amountM) : viewer.camera.zoomIn(-amountM)
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      const h = viewer.camera.positionCartographic.height
      zoomBy(ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0035) * h)
    }
    let gScale = 1
    const onGestureStart = (ev: Event) => { ev.preventDefault(); gScale = 1 }
    const onGestureChange = (ev: Event) => {
      ev.preventDefault()
      const scale = (ev as any).scale ?? 1
      const h = viewer.camera.positionCartographic.height
      zoomBy(scale > gScale ? -h * (scale - gScale) : h * (gScale - scale))
      gScale = scale
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('gesturestart', onGestureStart)
    canvas.addEventListener('gesturechange', onGestureChange)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('gesturestart', onGestureStart)
      canvas.removeEventListener('gesturechange', onGestureChange)
    }
  }, [])

  // photorealistic 3D tiles (Google) in 3D mode — real terrain/buildings,
  // one world shared by map and 3D so nothing can misalign. Falls back to
  // the flat globe when no key is configured.
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    const globe = v.scene.globe
    const base = v.imageryLayers.get(0)
    const flat = () => {
      if (tilesetRef.current) tilesetRef.current.show = false
      globe.show = true
      if (base) base.show = true
      v.terrainProvider = new Cesium.EllipsoidTerrainProvider()
    }
    if (!view3d || !PHOTO_KEY) { flat(); return }
    if (!tilesetRef.current) {
      ;(async () => {
        try {
          const ts = await Cesium.createGooglePhotorealistic3DTileset({ key: PHOTO_KEY })
          v.scene.primitives.add(ts)
          tilesetRef.current = ts
          globe.show = false
          if (base) base.show = false
          setPhotoReady(true)
        } catch (e) { console.warn('photoreal tiles', e); flat() }
      })()
      return
    }
    tilesetRef.current.show = true
    globe.show = false
    if (base) base.show = false
  }, [view3d])

  // sun position from slider
  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    // Show UK local clock time on a long June day; Cesium expects UTC.
    const utcHour = (sunHour - 1 + 24) % 24
    const t = Cesium.JulianDate.fromDate(new Date(Date.UTC(2025, 5, 15, Math.floor(utcHour), (utcHour % 1) * 60)))
    v.clock.currentTime = t
  }, [sunHour])

  // click handler: draw or inspect
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (drawMode !== 'none') {
        const cart = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid)
        if (!cart) return
        const carto = Cesium.Cartographic.fromCartesian(cart)
        const lonLat = [Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)]
        drawMode === 'boundary' ? onBoundaryPoint(lonLat) : onExclusionPoint(lonLat)
        return
      }
      const picked = viewer.scene.pick(e.position)
      const info = (picked?.id as any)?.beamInfo as PickedInfo | undefined
      onPick(info ?? null)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    // hover tooltips — show what the cursor is over and why a spot has no panel
    handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const picked = viewer.scene.pick(e.endPosition)
      const info = (picked?.id as any)?.beamInfo as PickedInfo | undefined
      setTip(info ? { x: e.endPosition.x, y: e.endPosition.y, info } : null)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    return () => handler.destroy()
  }, [drawMode, onBoundaryPoint, onExclusionPoint, onPick])

  // render boundary + exclusions (grounded; height-sampled when terrain active)
  useEffect(() => {
    const ds = drawSource.current
    if (!ds) return
    let cancelled = false
    ;(async () => {
      const bndRings = [
        ...parcels.map(p => [...p, p[0]]),
        ...(boundary.length >= 3 ? [[...boundary, boundary[0]]] : []),
      ]
      const rings = [
        ...bndRings,
        ...exclusions.map(ex => [...(ex.geometry as any).coordinates[0], (ex.geometry as any).coordinates[0][0]]),
      ]
      const allPos = rings.flatMap(r => r.map(([lon, lat]) => ({ lon, lat })))
      const bH = view3d && esriTerrainRef.current && terrainReady
        ? await Cesium.sampleTerrainMostDetailed(esriTerrainRef.current,
            allPos.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat)))
            .then(c => c.map(x => x.height ?? 0))
            .catch(() => allPos.map(() => 0))
        : allPos.map(() => 0)
      if (cancelled) return
      ds.entities.removeAll()
      let hi = 0
      const hh = (n: number) => { const s = bH.slice(hi, hi + n); hi += n; return s }
      const elevated = (ring: number[][]) =>
        Cesium.Cartesian3.fromDegreesArrayHeights(
          ring.flatMap(([lo, la], i) => [lo, la, hh(ring.length)[i]]))
      for (const ring of bndRings) {
        const positions = elevated(ring)
        ds.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions.slice(0, -1)),
            material: BLUE.withAlpha(0.2), perPositionHeight: true,
          } as any,
          polyline: { positions, width: 3, material: Cesium.Color.CYAN, clampToGround: !view3d },
        })
      }
      boundary.forEach(p => ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p[0], p[1]),
        point: { pixelSize: 7, color: Cesium.Color.CYAN, outlineColor: Cesium.Color.WHITE, outlineWidth: 1 },
      }))
      exclusions.forEach((ex, xi) => {
        const ring = (ex.geometry as any).coordinates[0]
        if (ring.length >= 3) {
          const positions = elevated([...ring, ring[0]])
          const ent = ds.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions.slice(0, -1)),
              material: RED.withAlpha(0.4), perPositionHeight: true,
            } as any,
            polyline: { positions, width: 2, material: RED, clampToGround: !view3d },
          })
          ;(ent as any).beamInfo = {
            kind: 'Exclusion zone', id: `exclusion-${xi}`,
            lines: [
              { k: 'Label', v: (ex as any).label || 'User-drawn' },
              { k: 'Effect', v: 'Kept clear of panels, with setback' },
            ],
          }
        }
      })
    })()
    return () => { cancelled = true }
  }, [boundary, parcels, exclusions, view3d, terrainReady])

  // ---- render design results (async: samples terrain heights) ----
  useEffect(() => {
    const ds = resultSource.current
    if (!ds) return
    timers.current.forEach(clearTimeout)
    timers.current = []
    ds.entities.removeAll()
    if (!design) return
    let cancelled = false

    ;(async () => {
      const t = design.terrain, l = design.layout, e = design.electrical
      const rise = Math.tan(Cesium.Math.toRadians(tiltDeg))
      const elevLL = elevSampler(t?.suitability_grid)
      const viewer = viewerRef.current
      // Ground heights: on photoreal tiles sample the real surface; on the
      // flat globe (no key / not loaded) keep everything at 0 so nothing floats.
      const sampleGround = async (positions: { lon: number; lat: number }[]) => {
        if (!view3d || !viewer) return positions.map(() => 0)
        const cartos = positions.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat))
        if (tilesetRef.current && photoReady) {
          try {
            const res: any = await (viewer.scene as any).sampleHeightMostDetailed?.(cartos)
            if (res?.length) return res.map((c: any, i: number) =>
              c?.height ?? elevLL(positions[i].lon, positions[i].lat))
          } catch {}
          return positions.map(p => elevLL(p.lon, p.lat))
        }
        return positions.map(() => 0)
      }

      // 0. batch-sample ground heights for every point entity (dots,
      // inverters, transformer, cable vertices) — one tileset/terrain fetch
      const cells = t?.suitability_grid ?? []
      const invs = e?.inverter_points ?? []
      const tx = e?.transformer_point
      const cables = e?.cable_routes ?? []
      const allPos = [
        ...cells.map((c: any) => ({ lon: c.lon, lat: c.lat })),
        ...invs.map((i: any) => ({ lon: i.lon, lat: i.lat })),
        ...(tx ? [{ lon: tx.lon, lat: tx.lat }] : []),
        ...cables.flatMap((r: any) => r.coordinates.map(([lo, la]: number[]) => ({ lon: lo, lat: la }))),
      ]
      const allH = await sampleGround(allPos)
      if (cancelled) return
      let hi = 0
      const cellH = allH.slice(hi, hi += cells.length)
      const invH = allH.slice(hi, hi += invs.length)
      const txH = tx ? allH[hi++] : 0
      const cableH = cables.map((r: any) => allH.slice(hi, hi += r.coordinates.length))

      // 1. suitability grid dots
      cells.forEach((c: any, ci: number) => {
        const color = c.suitability === 'suitable' ? GREEN
          : c.suitability === 'excluded' ? RED
          : c.suitability === 'too_steep' ? ORANGE : YELLOW
        const verdicts: Record<string, string> = {
          suitable: 'OK to build',
          excluded: 'Inside an exclusion zone — no panels',
          setback: 'Inside the boundary setback — no panels',
          too_steep: `Too steep (${c.slope_degrees}° > 8° limit) — no panels`,
        }
        const ent = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, cellH[ci] + 0.5),
          point: { pixelSize: 5, color: color.withAlpha(0.5), disableDepthTestDistance: 0 },
        })
        ;(ent as any).beamInfo = {
          kind: 'Terrain check', id: `cell-${ci}`,
          lines: [
            { k: 'Verdict', v: verdicts[c.suitability] ?? `Unsuitable (${c.suitability})` },
            { k: 'Slope', v: `${c.slope_degrees}°` },
            { k: 'Aspect', v: `${c.aspect_degrees}°` },
            { k: 'Elevation', v: `${Number(c.elevation_m).toFixed(1)} m` },
          ],
        }
      })

      // 2. suitable-area fill
      if (t?.suitable_polygon) {
        const sp = t.suitable_polygon
        const rings = sp.type === 'MultiPolygon' ? sp.coordinates.map((p: any) => p[0]) : [sp.coordinates[0]]
        for (const ring of rings) {
          if (ring?.length >= 3) ds.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flat())),
              material: GREEN.withAlpha(0.07),
            },
          })
        }
      }

      // 3. OSM features — buildings extruded in 3D, trees on woodland
      // heights: 0 on the flat globe, sampled real surface on photoreal tiles
      const allAutoF = t?.auto_exclusions ?? []
      const autoF = allAutoF.filter((f: any) =>
        f.geometry.type === 'Polygon' && f.geometry.coordinates[0]?.length >= 3)
      const bHeights = await sampleGround(autoF.map((f: any) => {
        const [lon, lat] = f.geometry.coordinates[0][0]
        return { lon, lat }
      }))
      if (cancelled) return
      autoF.forEach((f: any, fi: number) => {
        const g = f.geometry
        {
          const ground = bHeights[fi] ?? 0
          const kindLabels: Record<string, string> = {
            building: 'Building', wood: 'Woodland', water: 'Water body',
          }
          const osmColor = f.kind === 'water'
            ? Cesium.Color.fromCssColorString('#1682a4')
            : f.kind === 'wood' ? GREEN : BRICK
          const ent = ds.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(g.coordinates[0].flat())),
              material: view3d ? osmColor.withAlpha(0.88)
                : (f.kind === 'water' || f.kind === 'wood' ? osmColor.withAlpha(0.45) : RED.withAlpha(0.35)),
              height: view3d ? ground : 0,
              extrudedHeight: view3d ? ground + (f.kind === 'building' ? 7 : 0) : 0,
              shadows: view3d ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED,
            } as any,
          })
          ;(ent as any).beamInfo = {
            kind: kindLabels[f.kind] ?? 'Auto-exclusion', id: `osm-${f.kind}`,
            lines: [
              { k: 'Source', v: 'OpenStreetMap auto-detection' },
              { k: 'Effect', v: f.context
                ? 'Nearby site context; outside the project boundary'
                : 'Excluded from panels with a setback buffer' },
            ],
          }
          if (!view3d) ds.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray([...g.coordinates[0], g.coordinates[0][0]].flat()),
              width: 1.5, material: osmColor, clampToGround: true,
            },
          })
          // trees on woodland polygons (in 3D: billboards scattered inside)
          if (view3d && f.kind === 'wood' && g.coordinates[0].length >= 3) {
            const c = g.coordinates[0]
            for (let i = 0; i < Math.min(12, c.length * 3); i++) {
              const a = c[i % c.length], b = c[(i + 1) % c.length]
              const lon = a[0] + (b[0] - a[0]) * ((i * 37 % 100) / 100)
              const lat = a[1] + (b[1] - a[1]) * ((i * 53 % 100) / 100)
              ds.entities.add({
                position: Cesium.Cartesian3.fromDegrees(lon, lat, ground),
                billboard: { image: _treeTex ??= treeCanvas(), width: 28, height: 42, disableDepthTestDistance: 0 },
              })
            }
          }
        }
      })
      // Roads are LineStrings, not polygons. Keep them visible as explicit
      // OSM constraints instead of silently dropping them from the map.
      for (const f of allAutoF.filter((item: any) =>
        item.kind === 'road' && item.geometry.type === 'LineString')) {
        const coords: number[][] = f.geometry.coordinates
        const heights = view3d ? await sampleGround(coords.map(([lon, lat]) => ({ lon, lat }))) : []
        if (cancelled) return
        const positions = view3d
          ? Cesium.Cartesian3.fromDegreesArrayHeights(
              coords.flatMap(([lon, lat], i) => [lon, lat, (heights[i] ?? 0) + 0.35]))
          : Cesium.Cartesian3.fromDegreesArray(coords.flat())
        const ent = ds.entities.add({
          polyline: {
            positions, width: f.context ? 3 : 6,
            material: f.context ? Cesium.Color.fromCssColorString('#8a8175') :
              Cesium.Color.fromCssColorString('#ef6a45'),
            clampToGround: !view3d,
          },
        })
        ;(ent as any).beamInfo = {
          kind: 'Road constraint', id: f.id,
          lines: [
            { k: 'Source', v: 'OpenStreetMap' },
            { k: 'Effect', v: `No-panel setback · ${f.buffer_m ?? 6} m` },
          ],
        }
      }

      // 4. PV tables — sloped faces snapped to terrain, staggered reveal
      const tables: any[] = l?.tables ?? []
      const verts: { lon: number; lat: number }[] = []
      tables.forEach((tb: any) => tb.geometry.coordinates[0].forEach(([lon, lat]: number[]) => verts.push({ lon, lat })))
      const terrainH = await sampleGround(verts)
      if (cancelled) return

      let vi = 0
      tables.forEach((tb: any) => {
        const ring: number[][] = tb.geometry.coordinates[0]
        const entOpts = () => {
          if (view3d) {
            const proj = ring.map(([, lat]) => lat * 111320)
            const pMin = Math.min(...proj)
            const flat: number[] = []
            const vH: number[] = []
            ring.forEach(([lon, lat], i) => {
              vH.push(terrainH[vi] ?? 0)
              flat.push(lon, lat, vH[i] + BASE_H + (proj[i] - pMin) * rise)
              vi++
            })
            const posts: Cesium.Entity.ConstructorOptions[] = []
            // 2 posts under the front (lowest) corners of the sloped face
            const idx = ring.map((_, i) => i).sort((a, b) => proj[a] - proj[b]).slice(0, 2)
            for (const i of idx) {
              const g = vH[i]
              posts.push({
                position: Cesium.Cartesian3.fromDegrees(ring[i][0], ring[i][1], g + BASE_H / 2),
                box: {
                  dimensions: new Cesium.Cartesian3(0.12, 0.12, BASE_H),
                  material: Cesium.Color.fromCssColorString('#9aa5ad'),
                } as any,
              })
            }
            return {
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArrayHeights(flat)),
                perPositionHeight: true,
                material: new Cesium.ImageMaterialProperty({ image: panelTexture(), repeat: new Cesium.Cartesian2(6, 2) }),
                shadows: Cesium.ShadowMode.ENABLED,
              } as any,
              _posts: posts,
            }
          }
          vi += ring.length
          return {
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flat())),
              material: BLUE.withAlpha(0.55),
            },
          }
        }
        // no artificial stagger — render as soon as heights are sampled
        const delay = 0
        const add = () => {
          if (cancelled) return
          const opts: any = entOpts()
          const posts: Cesium.Entity.ConstructorOptions[] = opts._posts ?? []
          delete opts._posts
          const ent = ds.entities.add(opts)
          posts.forEach(p => ds.entities.add(p))
          ;(ent as any).beamInfo = {
            kind: 'PV table', id: tb.table_id,
            lines: [
              { k: 'Modules', v: String(tb.module_count) },
              { k: 'DC capacity', v: `${tb.dc_capacity_kwp} kWp` },
              { k: 'Strings', v: (tb.string_ids || []).join(', ') || '—' },
              { k: 'Centroid', v: `${tb.centroid.lat.toFixed(5)}, ${tb.centroid.lon.toFixed(5)}` },
            ],
          }
        }
        delay ? timers.current.push(setTimeout(add, delay)) : add()
      })

      // 4b. perimeter fence (3D): posts + top rail along the boundary
      if (view3d) {
        for (const bnd of [...parcels, ...(boundary.length >= 3 ? [boundary] : [])]) {
          const ring = [...bnd, bnd[0]]
          const fh = await sampleGround(ring.map(([lon, lat]) => ({ lon, lat })))
          if (cancelled) return
          ds.entities.add({
            wall: {
              positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
              minimumHeights: fh,
              maximumHeights: fh.map((h: number) => h + 1.6),
              material: Cesium.Color.fromCssColorString('#2f3b45').withAlpha(0.75),
            } as any,
          })
        }
      }

      // 5. cable routes, inverters, transformer
      cables.forEach((r: any, ri: number) => {
        const hh = cableH[ri]
        ds.entities.add({
          polyline: {
            positions: view3d
              ? Cesium.Cartesian3.fromDegreesArrayHeights(
                  r.coordinates.flatMap(([lo, la]: number[], i: number) => [lo, la, hh[i] + 0.4]))
              : Cesium.Cartesian3.fromDegreesArray(r.coordinates.flat()),
            width: 2, material: YELLOW, clampToGround: !view3d,
          },
        })
      })
      invs.forEach((ip: any, ii: number) => {
        const ent = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(ip.lon, ip.lat, invH[ii]),
          point: { pixelSize: 12, color: ORANGE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
          label: { text: ip.id, font: '10px sans-serif', fillColor: ORANGE, pixelOffset: new Cesium.Cartesian2(0, -18) },
          box: view3d ? { dimensions: new Cesium.Cartesian3(3, 2, 2.2), material: ORANGE.withAlpha(0.9), shadows: Cesium.ShadowMode.ENABLED } as any : undefined,
        })
        ;(ent as any).beamInfo = {
          kind: 'Inverter', id: ip.id,
          lines: [
            { k: 'Capacity', v: `${ip.capacity_kw} kW` },
            { k: 'Strings', v: String(ip.strings ?? '—') },
          ],
        }
      })
      if (e?.transformer_point) {
        const tp = e.transformer_point
        const ent = ds.entities.add({
          position: Cesium.Cartesian3.fromDegrees(tp.lon, tp.lat, txH),
          point: { pixelSize: 16, color: PURPLE, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
          label: { text: `TX ${e.transformer_kva} kVA`, font: '11px sans-serif', fillColor: PURPLE, pixelOffset: new Cesium.Cartesian2(0, -22) },
          box: view3d ? { dimensions: new Cesium.Cartesian3(5, 4, 5), material: PURPLE.withAlpha(0.9), shadows: Cesium.ShadowMode.ENABLED } as any : undefined,
        })
        ;(ent as any).beamInfo = {
          kind: 'Transformer', id: tp.id,
          lines: [
            { k: 'Rating', v: `${e.transformer_kva} kVA` },
            { k: 'Connection', v: e.grid_connection_recommendation },
            { k: 'Warning', v: 'DNO confirmation required' },
          ],
        }
      }
    })()

    return () => { cancelled = true }
  }, [design, view3d, tiltDeg, photoReady, terrainReady])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {tip && (
        <div
          className="absolute z-30 pointer-events-none bg-black/85 border border-[#2a3646] rounded px-2.5 py-1.5 text-[11px] max-w-60"
          style={{ left: tip.x + 14, top: tip.y + 14 }}
        >
          <div className="font-semibold text-slate-200 mb-0.5">{tip.info.kind}</div>
          {tip.info.lines.map((l, i) => (
            <div key={i} className="flex gap-1.5">
              <span className="text-slate-500 shrink-0">{l.k}:</span>
              <span className="text-slate-300">{l.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function flyTo(viewer: Cesium.Viewer | null, lon: number, lat: number, h = 3000) {
  viewer?.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
    duration: 2.5,
  })
}

export function view3dSite(viewer: Cesium.Viewer | null, lon: number, lat: number, offsetRightM = 0) {
  if (!viewer) return
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.0012, 420),
    orientation: { pitch: Cesium.Math.toRadians(-48) },
    duration: 2.5,
    // nudge the view right so the site centres in the space the right panel
    // doesn't cover
    complete: offsetRightM ? () => viewer.camera.moveRight(offsetRightM) : undefined,
  })
}

/** Frame the whole site in the angled 3D view: height scales to the boundary
 * span and the view is offset so panels sit in the visible centre-left area
 * (clear of both floating panels). */
export function frameSite3d(viewer: Cesium.Viewer | null, ring: number[][]) {
  if (!viewer || ring.length < 3) return
  const lons = ring.map(p => p[0]), lats = ring.map(p => p[1])
  const cLon = (Math.min(...lons) + Math.max(...lons)) / 2
  const cLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const mLon = 111320 * Math.cos(cLat * Math.PI / 180), mLat = 111320
  const spanM = Math.max(
    (Math.max(...lons) - Math.min(...lons)) * mLon,
    (Math.max(...lats) - Math.min(...lats)) * mLat,
    100,
  )
  const h = Math.min(Math.max(spanM * 1.7, 380), 20000)
  viewer.camera.flyTo({
    // aim well south of centre — the pitched view then places the site in
    // the upper half of the frame, clear of the bottom bar
    destination: Cesium.Cartesian3.fromDegrees(cLon, cLat - (h * 0.85) / mLat, h),
    orientation: { pitch: Cesium.Math.toRadians(-50) },
    duration: 2.8,
    complete: () => viewer.camera.moveRight(spanM * 0.12),
  })
}

export function viewTopDown(viewer: Cesium.Viewer | null, lon: number, lat: number) {
  if (!viewer) return
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1200),
    orientation: { pitch: Cesium.Math.toRadians(-90) },
    duration: 2,
  })
}

/** Ground-level walkthrough: enter at the gate, walk an aisle, end mid-site.
 * ~2 m eye height throughout — no swooping. */
export function flythrough(viewer: Cesium.Viewer | null, lon: number, lat: number, onDone?: () => void) {
  if (!viewer) return
  const cam = viewer.camera
  const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180)
  const pt = (dxM: number, dyM: number, h: number) =>
    Cesium.Cartesian3.fromDegrees(lon + dxM / mLon, lat + dyM / mLat, h)
  const leg = (dxM: number, dyM: number, dur: number, pitch: number, next?: () => void) =>
    cam.flyTo({
      destination: pt(dxM, dyM, 1.8),
      orientation: { heading: Cesium.Math.toRadians(0), pitch: Cesium.Math.toRadians(pitch), roll: 0 },
      duration: dur, complete: next,
    })
  // gate → down the aisle west→east → slight climb onto a table edge view
  leg(-60, -120, 4, -4, () =>
    leg(-40, -40, 5, -2, () =>
      leg(60, -20, 8, -3, () =>
        leg(120, 20, 6, -8, onDone))))
}
