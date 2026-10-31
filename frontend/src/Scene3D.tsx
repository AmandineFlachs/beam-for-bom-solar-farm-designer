import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Design } from './api'
import { outerRings } from './api'

interface Props {
  design: Design
  tiltDeg: number
  azimuthDeg: number
  onClose: () => void
}

// Cinematic grade: vignette + subtle grain + gentle warm lift
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.28 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float vig = 1.0 - uVignette * dot(d, d) * 1.6;
      c.rgb *= vig;
      c.rgb += (rand(vUv * 800.0) - 0.5) * 0.008;            // film grain
      c.rgb = mix(c.rgb, c.rgb * vec3(1.03, 1.0, 0.97), 0.5); // warm lift
      gl_FragColor = c;
    }`,
}

/** Photoreal 3D preview of the designed farm, built entirely from our own
 * design data: heightfield from terrain grid, tilted panels, OSM buildings,
 * trees, fence, equipment, neighbouring field parcels. All local metres. */
export default function Scene3D({ design, tiltDeg, azimuthDeg, onClose }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [sunHour, setSunHour] = useState(9.5)
  const api_ = useRef<{ setSun: (h: number) => void; enter: () => void } | null>(null)
  const [locked, setLocked] = useState(false)
  const [insp, setInsp] = useState<{ label: string; sub?: string } | null>(null)
  const inspRef = useRef(insp)
  inspRef.current = insp
  // real DEM heightfield — Mapterhorn terrarium tiles at z15 (~4.8 m/px) over
  // the site + padding; decoded to a height grid, sampled bilinearly.
  // undefined = still loading (scene waits), {fail} = fell back to the
  // sparse suitability grid.
  const [dem, setDem] = useState<any>(undefined)
  useEffect(() => {
    const site = design.site
    if (!site?.boundary || !outerRings(site.boundary).length) { setDem({ fail: true }); return }
    let dead = false
    const guard = setTimeout(() => { if (!dead) setDem((d: any) => d === undefined ? { fail: true } : d) }, 6000)
    ;(async () => {
      try {
        const c0 = site.centroid
        const cosLat = Math.cos(c0.lat * Math.PI / 180)
        const ring = outerRings(site.boundary).flat() as [number, number][]
        const Z = 15, T = 256, N = 2 ** Z
        const wX = (lon: number) => (lon + 180) / 360 * N * T
        const wY = (lat: number) => {
          const r = lat * Math.PI / 180
          return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N * T
        }
        const lons = ring.map(p => p[0]), lats = ring.map(p => p[1])
        const padLon = 240 / (111320 * cosLat), padLat = 240 / 111320
        const px0 = wX(Math.min(...lons) - padLon), px1 = wX(Math.max(...lons) + padLon)
        const py0 = wY(Math.max(...lats) + padLat), py1 = wY(Math.min(...lats) - padLat)
        const ox = Math.floor(px0), oy = Math.floor(py0)
        const cv = document.createElement('canvas')
        cv.width = Math.ceil(px1) - ox; cv.height = Math.ceil(py1) - oy
        const ctx = cv.getContext('2d', { willReadFrequently: true })!
        const jobs: Promise<void>[] = []
        for (let tx = Math.floor(px0 / T); tx <= Math.floor(px1 / T); tx++)
          for (let ty = Math.floor(py0 / T); ty <= Math.floor(py1 / T); ty++)
            jobs.push(new Promise(res => {
              const img = new Image(); img.crossOrigin = 'anonymous'
              img.onload = () => { ctx.drawImage(img, tx * T - ox, ty * T - oy); res() }
              img.onerror = () => res()
              img.src = `https://tiles.mapterhorn.com/${Z}/${tx}/${ty}.webp`
            }))
        await Promise.all(jobs)
        const px = ctx.getImageData(0, 0, cv.width, cv.height).data
        const data = new Float32Array(cv.width * cv.height)
        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
          const h = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768
          // failed/missing tiles decode to -32768 → pits with cliff walls
          data[j] = (h > -500 && h < 9000) ? h : NaN
        }
        // fill holes from their mean neighbourhood (few passes)
        const W = cv.width, H = cv.height
        for (let pass = 0; pass < 40; pass++) {
          let holes = 0
          for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
            const j = y * W + x
            if (Number.isFinite(data[j])) continue
            let s = 0, n = 0
            for (const o of [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1]) {
              const v = data[j + o]
              if (Number.isFinite(v)) { s += v; n++ }
            }
            if (n) { data[j] = s / n } else holes++
          }
          if (!holes) break
        }
        // any remaining hole → grid mean
        let s = 0, n = 0
        for (const v of data) if (Number.isFinite(v)) { s += v; n++ }
        const mean = n ? s / n : 0
        for (let j = 0; j < data.length; j++) if (!Number.isFinite(data[j])) data[j] = mean
        if (!dead) setDem((d: any) => d === undefined ? { ox, oy, w: cv.width, h: cv.height, data, wX, wY } : d)
      } catch { if (!dead) setDem((d: any) => d === undefined ? { fail: true } : d) }
    })()
    return () => { dead = true; clearTimeout(guard) }
  }, [design])

  useEffect(() => {
    if (dem === undefined) return   // wait for the DEM before building once
    const mount = mountRef.current!
    const t = design.terrain, l = design.layout, e = design.electrical, site = design.site

    // ---- local coordinate frame (metres), origin = site centroid ----
    const c0 = site.centroid
    const cosLat = Math.cos(c0.lat * Math.PI / 180)
    const toXY = (lon: number, lat: number): [number, number] =>
      [(lon - c0.lon) * 111320 * cosLat, (lat - c0.lat) * 111320]

    // ---- scene / renderer ----
    const scene = new THREE.Scene()
    scene.fog = null
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.82
    mount.appendChild(renderer.domElement)

    const bnds = outerRings(site.boundary).map(r =>
      (r as [number, number][]).map(([lo, la]) => toXY(lo, la)))
    const xs = bnds.flat().map(p => p[0]), zs = bnds.flat().map(p => p[1])
    const pad = 160
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad
    const minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad
    const span = Math.max(maxX - minX, maxZ - minZ)

    // ---- first-person controls ----
    // Spawn at the access point (or south edge) at eye height, facing the
    // array. Pointer lock gives mouse-look; WASD/arrows walk, shift sprints,
    // space jumps. Movement is clamped to the scene bounds and the eye
    // height follows the terrain.
    const camera = new THREE.PerspectiveCamera(70, mount.clientWidth / mount.clientHeight, 0.3, 9000)
    const controls = new PointerLockControls(camera, renderer.domElement)
    controls.addEventListener('lock', () => setLocked(true))
    controls.addEventListener('unlock', () => setLocked(false))

    const EYE = 1.7
    const spawn = ((): [number, number] => {
      if (e?.transformer_point) {
        // stand ~10 m from the kiosk toward the site centre — spawning ON the
        // transformer point puts the camera inside the equipment
        const [tx, tz] = toXY(e.transformer_point.lon, e.transformer_point.lat)
        const d = Math.hypot(tx, tz) || 1
        return [tx - (tx / d) * 10, tz - (tz / d) * 10]
      }
      return [(minX + maxX) / 2, minZ + 15]
    })()
    const keys = new Set<string>()
    let vel = new THREE.Vector3(), vy = 0, airborne = false
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code === 'Escape') return
      keys.add(ev.code)
      if (ev.code === 'Space' && !airborne) { vy = 5.5; airborne = true }
    }
    const onKeyUp = (ev: KeyboardEvent) => keys.delete(ev.code)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    // drag-look fallback when pointer lock is unavailable/denied
    let dragLook = false, lastMX = 0, lastMY = 0, yaw = 0, pitch = 0
    const onMDown = (e: MouseEvent) => { if (!controls.isLocked) { dragLook = true; lastMX = e.clientX; lastMY = e.clientY } }
    const onMMove = (e: MouseEvent) => {
      if (!dragLook || controls.isLocked) return
      yaw -= (e.clientX - lastMX) * 0.003; pitch -= (e.clientY - lastMY) * 0.003
      pitch = Math.max(-1.4, Math.min(1.4, pitch))
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'))
      lastMX = e.clientX; lastMY = e.clientY
    }
    const onMUp = () => { dragLook = false }
    renderer.domElement.addEventListener('mousedown', onMDown)
    window.addEventListener('mousemove', onMMove)
    window.addEventListener('mouseup', onMUp)

    // ---- composer: render → bloom → tonemap/sRGB → grade ----
    const rt = new THREE.WebGLRenderTarget(mount.clientWidth, mount.clientHeight,
      { samples: 2, type: THREE.HalfFloatType })
    const composer = new EffectComposer(renderer, rt)
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.09, 0.5, 0.94)
    composer.addPass(bloom)
    composer.addPass(new OutputPass())
    const grade = new ShaderPass(GradeShader)
    composer.addPass(grade)

    // ---- sky + lights ----
    // The old `Sky` shader dome was the "fog" — bright mie haze near the
    // horizon veiled the whole frame. Replaced by a clean gradient sky plus a
    // real environment map so PBR materials (water, panels) actually reflect.
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    const skyCv = document.createElement('canvas'); skyCv.width = 16; skyCv.height = 256
    const sg = skyCv.getContext('2d')!
    const grad = sg.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#3f6ea6')
    grad.addColorStop(0.55, '#8ab1d4')
    grad.addColorStop(0.78, '#ccd9e4')
    grad.addColorStop(1, '#e9edf0')
    sg.fillStyle = grad; sg.fillRect(0, 0, 16, 256)
    const skyTex = new THREE.CanvasTexture(skyCv)
    skyTex.mapping = THREE.EquirectangularReflectionMapping
    skyTex.colorSpace = THREE.SRGBColorSpace
    scene.background = skyTex
    scene.backgroundIntensity = 0.95

    const sun = new THREE.DirectionalLight(0xfff4e0, 3)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const S = Math.max(200, span * 0.65)
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 2200 })
    sun.shadow.bias = -0.0002
    sun.shadow.normalBias = 0.06
    scene.add(sun, sun.target)
    const hemi = new THREE.HemisphereLight(0xbdd6f0, 0x54643f, 0.55)
    scene.add(hemi)
    const amb = new THREE.AmbientLight(0x404860, 0.25)
    scene.add(amb)

    const setSun = (h: number) => {
      const frac = (h - 6) / 15
      const elev = Math.max(Math.sin(frac * Math.PI), 0.02)
      const azim = Math.PI * (0.15 + 0.7 * frac)
      sun.position.setFromSphericalCoords(900, Math.PI / 2 - Math.asin(elev), azim + Math.PI)
      sun.intensity = h < 6.5 || h > 20 ? 0.15 : 2.0 + elev * 1.2
      hemi.intensity = h < 6.5 || h > 20 ? 0.12 : 0.55
      amb.intensity = h < 6.5 || h > 20 ? 0.1 : 0.25
      sun.color.set(h < 8 || h > 17 ? 0xffd2a0 : 0xfff4e0)
      bloom.strength = h < 7 || h > 18.5 ? 0.18 : 0.08
    }
    setSun(sunHour)

    // ---- procedural textures ----
    const grassTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 512
      const g = c.getContext('2d')!
      g.fillStyle = '#5b7a3c'; g.fillRect(0, 0, 512, 512)
      for (let i = 0; i < 26000; i++) {
        const v = Math.random()
        g.fillStyle = v < 0.45 ? '#536f34' : v < 0.8 ? '#668a45' : '#48612c'
        g.fillRect(Math.random() * 512, Math.random() * 512, 2, 3 + Math.random() * 2)
      }
      // faint mowing stripes
      g.globalAlpha = 0.05
      for (let y = 0; y < 512; y += 34) { g.fillStyle = '#2e4218'; g.fillRect(0, y, 512, 15) }
      g.globalAlpha = 1
      const tex = new THREE.CanvasTexture(c)
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(28, 28)
      tex.anisotropy = 16
      return tex
    })()
    const panelTex = (() => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 256
      const g = c.getContext('2d')!
      g.fillStyle = '#0e1a4e'; g.fillRect(0, 0, 512, 256)
      g.strokeStyle = '#26397f'; g.lineWidth = 3
      for (let x = 0; x <= 512; x += 42) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke() }
      for (let y = 0; y <= 256; y += 42) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke() }
      g.strokeStyle = '#33489e'; g.lineWidth = 1.5
      for (let x = 14; x <= 512; x += 42) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke() }
      // specular streak
      const grad = g.createLinearGradient(0, 0, 512, 256)
      grad.addColorStop(0.35, 'rgba(255,255,255,0)')
      grad.addColorStop(0.5, 'rgba(255,255,255,0.08)')
      grad.addColorStop(0.65, 'rgba(255,255,255,0)')
      g.fillStyle = grad; g.fillRect(0, 0, 512, 256)
      const tex = new THREE.CanvasTexture(c)
      tex.anisotropy = 8
      return tex
    })()

    // ---- elevation lookup ----
    const grid = (t?.suitability_grid ?? []) as any[]
    const elevGrid = grid.map((c: any) => { const [x, z] = toXY(c.lon, c.lat); return { x, z, h: c.elevation_m } })
    // Bilinear interpolation on the (nearly regular) suitability grid —
    // nearest-neighbour produced blocky steps. Outside the grid the edge
    // value is held so padded ground stays level instead of sloping off.
    const gxs = [...new Set(elevGrid.map((c: any) => +c.x.toFixed(1)))].sort((a, b) => a - b)
    const gzs = [...new Set(elevGrid.map((c: any) => +c.z.toFixed(1)))].sort((a, b) => a - b)
    const hIdx = new Map(elevGrid.map((c: any) => [`${+c.x.toFixed(1)}|${+c.z.toFixed(1)}`, c.h]))
    const regular = gxs.length > 1 && gzs.length > 1 && gxs.length * gzs.length === elevGrid.length
    const lower = (arr: number[], v: number) => {
      let i = 0; while (i < arr.length - 1 && arr[i + 1] <= v) i++
      return Math.min(i, arr.length - 2)
    }
    const nearest = (x: number, z: number) => {
      let best = Infinity, h = 0
      for (const c of elevGrid) {
        const d = (c.x - x) ** 2 + (c.z - z) ** 2
        if (d < best) { best = d; h = c.h }
      }
      return Number.isFinite(h) ? h : 0
    }
    // ---- impostor textures (Grand-Teton-style billboards) ----
    // Procedural tree sprites with alpha — far better than icosahedron blobs
    // and still honest (shape/colour are stylised, position+density are data).
    const treeTexs = [0, 1, 2].map(variant => {
      const c = document.createElement('canvas'); c.width = c.height = 256
      const g = c.getContext('2d')!
      let seed = variant * 7919 + 13
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      // trunk
      g.fillStyle = '#4a3a28'
      g.fillRect(120 + rnd() * 8, 190, 14, 66)
      // canopy: broad rounded crown centred high on the trunk
      const greens = ['#2e4d21', '#3d6129', '#4a7031', '#567c38']
      const cx0 = 128, cy0 = 92
      for (let i = 0; i < 90; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 66
        const x = cx0 + Math.cos(a) * r * 1.15, y = cy0 + Math.sin(a) * r * 0.85
        g.fillStyle = greens[Math.floor(rnd() * (1.5 + r / 66))]
        g.beginPath(); g.arc(x, y, 12 + rnd() * 15, 0, Math.PI * 2); g.fill()
      }
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      return tex
    })
    // grass tuft: a few tapered blades
    const grassSpriteTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128
      const g = c.getContext('2d')!
      for (let i = 0; i < 18; i++) {
        const x = 14 + Math.random() * 100, h = 40 + Math.random() * 60
        const lean = (Math.random() - 0.5) * 24
        g.strokeStyle = ['#5a7434', '#6b8a3f', '#4c632b'][i % 3]
        g.lineWidth = 3.5; g.lineCap = 'round'
        g.beginPath(); g.moveTo(x, 128)
        g.quadraticCurveTo(x + lean * 0.4, 128 - h * 0.6, x + lean, 128 - h)
        g.stroke()
      }
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    })()
    // soft cloud blob
    const cloudTex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 128
      const g = c.getContext('2d')!
      for (let i = 0; i < 9; i++) {
        const x = 50 + Math.random() * 156, y = 55 + Math.random() * 35, r = 22 + Math.random() * 30
        const gr = g.createRadialGradient(x, y, 0, x, y, r)
        gr.addColorStop(0, 'rgba(255,255,255,0.55)')
        gr.addColorStop(1, 'rgba(255,255,255,0)')
        g.fillStyle = gr
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
      }
      const tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    })()

    let elevAt = (x: number, z: number) => {
      // prefer the real DEM (bilinear over decoded terrarium pixels)
      if (dem && !dem.fail) {
        const lon = c0.lon + x / (111320 * cosLat)
        const lat = c0.lat + z / 111320
        const gx = dem.wX(lon) - dem.ox, gy = dem.wY(lat) - dem.oy
        if (gx >= 0 && gy >= 0 && gx < dem.w - 1 && gy < dem.h - 1) {
          const i = Math.floor(gx), j = Math.floor(gy)
          const fx = gx - i, fz = gy - j, d = dem.data, w = dem.w
          const h = d[j * w + i] * (1 - fx) * (1 - fz) + d[j * w + i + 1] * fx * (1 - fz)
            + d[(j + 1) * w + i] * (1 - fx) * fz + d[(j + 1) * w + i + 1] * fx * fz
          if (Number.isFinite(h)) return h
        }
      }
      if (!regular) return nearest(x, z)
      const i = lower(gxs, x), j = lower(gzs, z)
      const x0 = gxs[i], x1 = gxs[i + 1], z0 = gzs[j], z1 = gzs[j + 1]
      const fx = Math.min(Math.max((x - x0) / (x1 - x0), 0), 1)
      const fz = Math.min(Math.max((z - z0) / (z1 - z0), 0), 1)
      const h00 = hIdx.get(`${gxs[i]}|${gzs[j]}`), h10 = hIdx.get(`${gxs[i + 1]}|${gzs[j]}`)
      const h01 = hIdx.get(`${gxs[i]}|${gzs[j + 1]}`), h11 = hIdx.get(`${gxs[i + 1]}|${gzs[j + 1]}`)
      if (h00 == null || h10 == null || h01 == null || h11 == null) return nearest(x, z)
      const h = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
      return Number.isFinite(h) ? h : nearest(x, z)
    }
    const elevRaw = elevAt
    // base elevation: first finite sample near the centre — if the grid/DEM is
    // broken there may be no finite value at all; fall back to 0
    let baseElev0 = 0
    for (let r = 0; r <= 60 && !Number.isFinite(baseElev0); r += 10) {
      const h = elevRaw(r, 0)
      if (Number.isFinite(h)) baseElev0 = h
    }
    if (!Number.isFinite(baseElev0)) baseElev0 = 0
    // clamp to the site's real measured range (+margin): anything outside is
    // junk data (DEM miss / sparse-grid hole) and renders as a spike
    let loH = baseElev0, hiH = baseElev0
    for (const c of elevGrid) if (Number.isFinite(c.h)) { loH = Math.min(loH, c.h); hiH = Math.max(hiH, c.h) }
    loH -= 15; hiH += 15
    elevAt = (x: number, z: number) => {
      const h = elevRaw(x, z)
      return Number.isFinite(h) && h >= loH && h <= hiH ? h : baseElev0
    }
    const baseElev = baseElev0

    // ---- PV tables: terrain-following racking ----
    // Ground is NOT edited (grading created terraced cliffs on steep sites).
    // Each slab is raised until its lowest corner clears the terrain, and the
    // posts extend to whatever the ground is under each leg — how real
    // fixed-tilt racks handle slopes.
    const tilt = THREE.MathUtils.degToRad(tiltDeg)
    const azRot = THREE.MathUtils.degToRad(180 - azimuthDeg)
    const rotY = (x: number, z: number) => [x * Math.cos(azRot) + z * Math.sin(azRot),
                                           -x * Math.sin(azRot) + z * Math.cos(azRot)]
    const tables = (l?.tables ?? []).map((tb: any) => {
      const ring = tb.geometry.coordinates[0]
      const pts: [number, number][] = ring.map(([lo, la]: number[]) => toXY(lo, la))
      const minx = Math.min(...pts.map(p => p[0])), maxx = Math.max(...pts.map(p => p[0]))
      const minz = Math.min(...pts.map(p => p[1])), maxz = Math.max(...pts.map(p => p[1]))
      return { cx: (minx + maxx) / 2, cz: (minz + maxz) / 2, w: maxx - minx, d: maxz - minz }
    })
    const pads = tables.map((tb: { cx: number; cz: number; w: number; d: number }) => {
      // fit a slope plane under the footprint in table-local coords — the
      // slab then pitches/rolls WITH the terrain (terrain-following racking,
      // clamped like real racks) instead of levitating above its worst bump
      let sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0, sh = 0, n = 0
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const lx = i * tb.w / 4, lz = j * tb.d / 4
        const [ox, oz] = rotY(lx, lz)
        const h = elevAt(tb.cx + ox, tb.cz + oz)
        sxx += lx * lx; szz += lz * lz; sxz += lx * lz; sxh += lx * h; szh += lz * h; sh += h; n++
      }
      const mh = sh / n, det = sxx * szz - sxz * sxz || 1
      let a = (sxh * szz - szh * sxz) / det   // dh/dlx (roll direction)
      let b = (szh * sxx - sxh * sxz) / det   // dh/dlz (pitch direction)
      const mag = Math.hypot(a, b)
      if (mag > 0.18) { a *= 0.18 / mag; b *= 0.18 / mag }   // racks follow ~10° max
      const roll = Math.atan(a), pitch = -tilt - Math.atan(b)
      // centre height: rotate the slab by (pitch, roll) — its height at local
      // (lx,lz) is g - lz·sin(pitch) + lx·sin(roll); require ≥ terrain + margin
      const sp = Math.sin(pitch), sr = Math.sin(roll)
      const need: number[] = []
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const lx = i * tb.w / 4, lz = j * tb.d / 4
        const [ox, oz] = rotY(lx, lz)
        const h = elevAt(tb.cx + ox, tb.cz + oz)
        need.push(h + lz * sp - lx * sr)
      }
      // 85th percentile + margin — a single junk DEM pixel can't lift the table
      need.sort((x, y) => x - y)
      const g = need[Math.floor(need.length * 0.85)] + 0.5
      return { ...tb, g: Math.max(g, mh + 0.7), roll, pitch }
    })

    // deterministic RNG — same site, same scene every load
    let rngS = 1234567
    const rng = () => (rngS = (rngS * 16807) % 2147483647) / 2147483647

    // ---- ground heightfield ----
    const SEG = 110
    const groundMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, metalness: 0 })
    // slope blend: steep faces tint toward rock/scree (Terrain Studio's
    // slope-driven biome shading) — object-space normal +z is world up
    groundMat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjNrm;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvObjNrm = normal;')
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjNrm;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float slope = 1.0 - clamp(vObjNrm.z, 0.0, 1.0);
          vec3 rock = vec3(0.42, 0.39, 0.34);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock * (0.85 + 0.3 * diffuseColor.g),
                                 smoothstep(0.25, 0.6, slope));`)
    }
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, SEG, SEG),
      groundMat)
    ground.rotation.x = -Math.PI / 2
    ground.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2)
    const gp = ground.geometry.attributes.position
    for (let i = 0; i < gp.count; i++) {
      const wx = ground.position.x + gp.getX(i)
      const wz = ground.position.z - gp.getY(i)
      gp.setZ(i, elevAt(wx, wz) - baseElev)
    }
    // spike removal: any vertex >6 m above its 4-neighbour median is junk
    // DEM data — pull it back down (2 passes so clustered spikes also die)
    for (let pass = 0; pass < 2; pass++) {
      const W = SEG + 1
      const src = new Float32Array(gp.count)
      for (let i = 0; i < gp.count; i++) src[i] = gp.getZ(i)
      for (let j = 1; j < SEG; j++) for (let i = 1; i < SEG; i++) {
        const k = j * W + i
        const nb = [src[k - 1], src[k + 1], src[k - W], src[k + W]].sort((a, b) => a - b)
        const med = (nb[1] + nb[2]) / 2
        if (src[k] - med > 6) gp.setZ(k, med)
      }
    }
    ground.geometry.computeVertexNormals()
    ground.receiveShadow = true
    // skirt: drop a vertical ribbon off each edge so the slab reads as solid
    // earth instead of a floating surface (Terrain Studio's chunk skirts)
    {
      const gw = ground.geometry.attributes.position
      const W = SEG + 1, DRO = 45
      const skirt: number[] = []
      const pushEdge = (rowCol: (k: number) => number) => {
        for (let k = 0; k < SEG; k++) {
          const a = rowCol(k), b = rowCol(k + 1)
          const ax = ground.position.x + gw.getX(a), az = ground.position.z - gw.getY(a)
          const bx = ground.position.x + gw.getX(b), bz = ground.position.z - gw.getY(b)
          const ay = gw.getZ(a), by = gw.getZ(b)
          skirt.push(ax, ay, az, bx, by, bz, ax, ay - DRO, az,
                     bx, by, bz, bx, by - DRO, bz, ax, ay - DRO, az)
        }
      }
      pushEdge(k => k)                    // top edge (v=0 → north)
      pushEdge(k => (SEG) * W + k)        // bottom edge
      pushEdge(k => k * W)                // left edge
      pushEdge(k => k * W + SEG)          // right edge
      const sg = new THREE.BufferGeometry()
      sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirt), 3))
      sg.computeVertexNormals()
      const sk = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x3a3f35, roughness: 1, side: THREE.DoubleSide }))
      scene.add(sk)
    }
    scene.add(ground)

    try {
    // ---- satellite imagery draped on the heightfield: the preview shows the
    // actual site parcel, same Esri tiles as the 2D map. Async — swaps in over
    // the grass texture when tiles finish stitching. ----
    const latOf = (z: number) => c0.lat + z / 111320
    const lonOf = (x: number) => c0.lon + x / (111320 * cosLat)
    const Z = 18, T = 256, N = 2 ** Z
    const wX = (lon: number) => (lon + 180) / 360 * N * T
    const wY = (lat: number) => {
      const r = lat * Math.PI / 180
      return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N * T
    }
    const px0 = wX(lonOf(minX)), px1 = wX(lonOf(maxX))
    const py0 = wY(latOf(maxZ)), py1 = wY(latOf(minZ)) // north (maxZ) → top
    const ox = Math.floor(px0), oy = Math.floor(py0)
    const cv = document.createElement('canvas')
    cv.width = Math.ceil(px1) - ox; cv.height = Math.ceil(py1) - oy
    const g2 = cv.getContext('2d')!
    g2.fillStyle = '#3d4a2f'; g2.fillRect(0, 0, cv.width, cv.height)
    let pending = 0
    const apply = () => {
      if (pending > 0) return
      const tex = new THREE.CanvasTexture(cv)
      tex.flipY = false   // canvas row 0 is north; plane v=1 is the south
                         // edge — default flipY mirrored the imagery N–S
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
      tex.colorSpace = THREE.SRGBColorSpace
      const m = ground.material as THREE.MeshStandardMaterial
      m.map = tex; m.needsUpdate = true
    }
    for (let tx = Math.floor(px0 / T); tx <= Math.floor(px1 / T); tx++)
      for (let ty = Math.floor(py0 / T); ty <= Math.floor(py1 / T); ty++) {
        pending++
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => { g2.drawImage(img, tx * T - ox, ty * T - oy); pending--; apply() }
        img.onerror = () => { pending--; apply() }
        img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${ty}/${tx}`
      }
    apply()
    } catch (e) { console.warn('imagery', e) }

    // (no invented hedgerow — the satellite imagery shows the real boundaries)

    try {
    // ---- boundary fence ----
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x4a4d50, roughness: 0.6, metalness: 0.5 })
    const postGeo = new THREE.BoxGeometry(0.09, 1.7, 0.09)
    const MAX_POSTS = 220 * bnds.length
    const posts = new THREE.InstancedMesh(postGeo, fenceMat, MAX_POSTS)
    let pi = 0
    const dummy = new THREE.Object3D()
    for (const bnd of bnds)
    for (let i = 0; i < bnd.length - 1 && pi < MAX_POSTS; i++) {
      const [x1, z1] = bnd[i], [x2, z2] = bnd[i + 1]
      const len = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.round(len / 8))
      for (let k = 0; k <= n && pi < MAX_POSTS; k++, pi++) {
        const fx = x1 + (x2 - x1) * k / n, fz = z1 + (z2 - z1) * k / n
        dummy.position.set(fx, elevAt(fx, fz) - baseElev + 0.85, fz)
        dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1)
        dummy.updateMatrix()
        posts.setMatrixAt(pi, dummy.matrix)
      }
      if (len > 1) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), fenceMat)
        rail.position.set((x1 + x2) / 2, elevAt((x1 + x2) / 2, (z1 + z2) / 2) - baseElev + 1.5, (z1 + z2) / 2)
        rail.rotation.y = -Math.atan2(z2 - z1, x2 - x1)
        scene.add(rail)
      }
    }
    posts.count = pi
    posts.castShadow = true
    scene.add(posts)
    // glowing boundary ring (digital-twin accent)
    for (const bnd of bnds) {
      const ring = new THREE.BufferGeometry().setFromPoints(
        bnd.map(([x, z]) => new THREE.Vector3(x, elevAt(x, z) - baseElev + 0.15, z)))
      scene.add(new THREE.Line(ring, new THREE.LineBasicMaterial({ color: 0xd9822b })))
    }
    } catch (e) { console.warn('fence', e) }

    // ---- painted zone labels flat on the ground ----
    const labelTex = (txt: string) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128
      const g = c.getContext('2d')!
      g.font = 'bold 64px monospace'; g.fillStyle = 'rgba(255,255,255,0.75)'
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText(txt, 256, 64)
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8
      return t
    }
    const groundLabel = (txt: string, x: number, z: number, w: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4),
        new THREE.MeshBasicMaterial({ map: labelTex(txt), transparent: true, opacity: 0.8 }))
      m.rotation.x = -Math.PI / 2
      m.position.set(x, elevAt(x, z) - baseElev + 0.12, z)
      scene.add(m)
    }
    try {
      const ac = pads.reduce((s: number[], t: { cx: number; cz: number }) => [s[0] + t.cx, s[1] + t.cz], [0, 0])
      groundLabel('PV ARRAY', ac[0] / Math.max(pads.length, 1), ac[1] / Math.max(pads.length, 1), Math.min(60, span * 0.2))
      if (e?.transformer_point) {
        const [tx, tz] = toXY(e.transformer_point.lon, e.transformer_point.lat)
        groundLabel('SUBSTATION', tx, tz + 8, 26)
      }
    } catch { /* labels optional */ }

    // ---- floating KPI chips (digital-twin dashboard cards) ----
    const chips: { pos: THREE.Vector3; el: HTMLDivElement }[] = []
    const chip = (pos: THREE.Vector3, title: string, value: string, sub?: string) => {
      const el = document.createElement('div')
      el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);pointer-events:none;'
        + 'background:rgba(10,14,20,.85);border:1px solid rgba(255,255,255,.14);border-radius:8px;'
        + 'padding:7px 12px;font-family:monospace;backdrop-filter:blur(4px)'
      el.innerHTML = `<div style="font-size:9px;color:#8b95a5;letter-spacing:.08em">${title}</div>`
        + `<div style="font-size:15px;font-weight:700;color:#fff;line-height:1.1">${value}</div>`
        + (sub ? `<div style="font-size:9px;color:#d9822b">${sub}</div>` : '')
      mount.appendChild(el)
      chips.push({ pos, el })
    }
    try {
      const l = design.layout, y0 = (design as any).yield
      chip(new THREE.Vector3(0, Math.max(...pads.map((t: { g: number }) => t.g)) - baseElev + 3.5, 0),
        'DC CAPACITY', `${((l?.dc_capacity_kwp ?? 0) / 1000).toFixed(2)} MWp`, `${l?.table_count ?? 0} tables`)
      if (e?.transformer_point) {
        const [tx, tz] = toXY(e.transformer_point.lon, e.transformer_point.lat)
        chip(new THREE.Vector3(tx, elevAt(tx, tz) - baseElev + 5.5, tz),
          'GRID EXPORT', `${e.transformer_kva ?? '—'} kVA`, e.ac_cable_spec ?? '')
      }
      if (e?.inverter_points?.[0]) {
        const [ix, iz] = toXY(e.inverter_points[0].lon, e.inverter_points[0].lat)
        chip(new THREE.Vector3(ix, elevAt(ix, iz) - baseElev + 4, iz),
          'INVERTERS', `${e.inverter_count ?? e.inverter_points.length}× ${e.inverter_points[0].capacity_kw ?? 250} kW`)
      }
      if (y0?.annual_energy_mwh)
        chip(new THREE.Vector3(spawn[0], elevAt(spawn[0], spawn[1]) - baseElev + 6, spawn[1]),
          'ANNUAL YIELD', `${Math.round(y0.annual_energy_mwh)} MWh`, `${y0.capacity_factor_percent ?? ''}% CF`)
    } catch { /* chips optional */ }
    const projV = new THREE.Vector3()
    const updateChips = () => {
      for (const { pos, el } of chips) {
        projV.copy(pos).project(camera)
        const vis = projV.z < 1 && Math.abs(projV.x) < 1.1 && Math.abs(projV.y) < 1.1
        el.style.display = vis ? 'block' : 'none'
        if (vis) {
          el.style.left = `${(projV.x * 0.5 + 0.5) * mount.clientWidth}px`
          el.style.top = `${(-projV.y * 0.5 + 0.5) * mount.clientHeight}px`
        }
      }
    }

    // ---- inspection registry: crosshair raycast → HUD label ----
    const inspectables: THREE.Object3D[] = []
    const tags = new Map<THREE.Object3D, { label: string; sub?: string; instId?: (i: number) => { label: string; sub?: string } }>()
    const tag = (o: THREE.Object3D, label: string, sub?: string,
                 instId?: (i: number) => { label: string; sub?: string }) => {
      tags.set(o, { label, sub, instId }); inspectables.push(o)
    }

    try {
    // ---- PV tables as InstancedMesh: slab / 2 rails / tall+short posts ----
    const panelMat = new THREE.MeshPhysicalMaterial({
      map: panelTex, roughness: 0.18, metalness: 0.55,
      clearcoat: 0.7, clearcoatRoughness: 0.25 })
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.45, metalness: 0.85 })
    const postMat = new THREE.MeshStandardMaterial({ color: 0x707478, roughness: 0.55, metalness: 0.75 })

    const n = pads.length
    const dummy = new THREE.Object3D()
    dummy.rotation.order = 'YXZ'

    const slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.07, 1), panelMat, n)
    const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.09, 0.14), frameMat, n * 2)
    const postsT = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 1, 0.14), postMat, n * 2)
    const postsS = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 1, 0.14), postMat, n * 2)

    pads.forEach((tb: { cx: number; cz: number; w: number; d: number; g: number;
                        roll: number; pitch: number }, i: number) => {
      const g = tb.g - baseElev   // centre height that clears the terrain
      const { cx, cz, w, d, roll, pitch } = tb
      const qSlab = new THREE.Euler(pitch, azRot, roll, 'YXZ')
      const sp = Math.sin(pitch), sr = Math.sin(roll)
      const hAt = (lx: number, lz: number) => g - lz * sp + lx * sr   // slab height under local point
      // slab
      dummy.position.set(cx, g, cz)
      dummy.rotation.copy(qSlab)
      dummy.scale.set(w, 1, d)
      dummy.updateMatrix()
      slabs.setMatrixAt(i, dummy.matrix)
      const v = 0.88 + rng() * 0.2   // slight per-table albedo variation
      slabs.setColorAt(i, new THREE.Color(v, v, v))
      // rails under both long edges
      for (const side of [-1, 1]) {
        const edgeZ = side * d / 2
        const [ox, oz] = rotY(0, edgeZ)
        dummy.position.set(cx + ox, hAt(0, edgeZ) - 0.08, cz + oz)
        dummy.rotation.copy(qSlab)
        dummy.scale.set(w, 1, 1)
        dummy.updateMatrix()
        rails.setMatrixAt(i * 2 + (side + 1) / 2, dummy.matrix)
      }
      // posts: extend each leg from its underside point down into the terrain —
      // on slopes the downhill legs are visibly longer, like real racking
      for (const [j, sx] of [-w / 2 + 0.4, w / 2 - 0.4].entries()) {
        for (const [mesh, lz] of [[postsT, d / 2 - 0.25], [postsS, -d / 2 + 0.25]] as const) {
          const [ox, oz] = rotY(sx, lz)
          const px = cx + ox, pz = cz + oz
          const top = hAt(sx, lz) - 0.1
          const bottom = elevAt(px, pz) - baseElev - 0.3
          const hgt = Math.max(top - bottom, 0.2)
          dummy.rotation.set(0, azRot, 0)
          dummy.position.set(px, bottom + hgt / 2, pz)
          dummy.scale.set(1, hgt, 1)
          dummy.updateMatrix()
          mesh.setMatrixAt(i * 2 + j, dummy.matrix)
        }
      }
    })
    postsT.count = postsS.count = n * 2
    slabs.castShadow = slabs.receiveShadow = true
    rails.castShadow = postsT.castShadow = postsS.castShadow = true
    scene.add(slabs, rails, postsT, postsS)
    tag(slabs, 'PV table', '', i => ({
      label: (l?.tables ?? [])[i]?.id ?? `T-${String(i + 1).padStart(2, '0')}`,
      sub: `PV table · tilt ${tiltDeg}° · az ${azimuthDeg}°` }))
    } catch (e) { console.warn('tables', e) }

    // ---- colliders for first-person movement ----
    // circles (trees) + rotated rects (PV tables) — aisles stay walkable
    const colliders: { x: number; z: number; r: number }[] = []
    const rects = pads.map((p: { cx: number; cz: number; w: number; d: number }) => ({ cx: p.cx, cz: p.cz, w: p.w + 0.5, d: p.d + 0.5 }))
    const resolveColliders = (p: THREE.Vector3) => {
      for (const c of colliders) {
        const dx = p.x - c.x, dz = p.z - c.z
        const d2 = dx * dx + dz * dz
        if (d2 < c.r * c.r && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          p.x = c.x + dx / d * c.r; p.z = c.z + dz / d * c.r
        }
      }
      const R = 0.5   // player radius
      for (const r of rects) {
        const dx = p.x - r.cx, dz = p.z - r.cz
        // to table-local frame
        const lx = dx * Math.cos(azRot) - dz * Math.sin(azRot)
        const lz = dx * Math.sin(azRot) + dz * Math.cos(azRot)
        const qx = Math.max(Math.abs(lx) - r.w / 2, 0), qz = Math.max(Math.abs(lz) - r.d / 2, 0)
        const dist = Math.hypot(qx, qz)
        if (dist < R) {
          // push out along the shallower axis
          const pushX = (r.w / 2 + R - Math.abs(lx)), pushZ = (r.d / 2 + R - Math.abs(lz))
          let nlx = lx, nlz = lz
          if (dist > 0) { // outside rect but within radius: push along normal
            nlx = lx + (qx / dist) * (R - dist) * Math.sign(lx)
            nlz = lz + (qz / dist) * (R - dist) * Math.sign(lz)
          } else if (pushX < pushZ) nlx = Math.sign(lx) * (r.w / 2 + R)
          else nlz = Math.sign(lz) * (r.d / 2 + R)
          p.x = r.cx + nlx * Math.cos(azRot) + nlz * Math.sin(azRot)
          p.z = r.cz - nlx * Math.sin(azRot) + nlz * Math.cos(azRot)
        }
      }
    }

    // tree sprites shared by OSM woodland + user-drawn copse
    const treeMats = treeTexs.map(t => new THREE.SpriteMaterial({
      map: t, alphaTest: 0.45, transparent: false }))
    const shadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    try {
    // ---- OSM buildings (pitched-roof) + woodland trees ----
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xcfc4b4, roughness: 0.9 })
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x6e4a38, roughness: 0.8 })
    const wallCtx = new THREE.MeshStandardMaterial({ color: 0xb5ab9c, roughness: 0.95 })
    const roofCtx = new THREE.MeshStandardMaterial({ color: 0x7a6a58, roughness: 0.9 })
    for (const f of t?.auto_exclusions ?? []) {
      const g = f.geometry
      if (g.type !== 'Polygon') continue
      const pts: THREE.Vector2[] = g.coordinates[0].map(([lo, la]: number[]) => new THREE.Vector2(...toXY(lo, la) as [number, number]))
      const minx = Math.min(...pts.map(p => p.x)), maxx = Math.max(...pts.map(p => p.x))
      const miny = Math.min(...pts.map(p => p.y)), maxy = Math.max(...pts.map(p => p.y))
      if (f.kind === 'building') {
        const shape = new THREE.Shape(pts)
        const wallH = f.context ? 3.2 : 3.6
        const walls = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: wallH, bevelEnabled: false }),
          f.context ? wallCtx : wallMat)
        walls.rotation.x = Math.PI / 2
        const cg = elevAt(pts[0].x, pts[0].y) - baseElev
        walls.position.y = cg
        walls.castShadow = true; walls.receiveShadow = true
        scene.add(walls)
        // gable roof over the footprint bbox
        const bw = maxx - minx, bd = maxy - miny
        const roofH = Math.min(bw, bd) * 0.35 + 0.6
        const tri = new THREE.Shape([new THREE.Vector2(-bw / 2, 0), new THREE.Vector2(bw / 2, 0), new THREE.Vector2(0, roofH)])
        const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: bd, bevelEnabled: false }),
          f.context ? roofCtx : roofMat)
        roof.rotation.x = Math.PI / 2
        roof.position.set((minx + maxx) / 2, cg + wallH, maxy)
        roof.castShadow = true
        scene.add(roof)
        colliders.push({ x: (minx + maxx) / 2, z: (miny + maxy) / 2, r: Math.hypot(bw, bd) / 2 * 0.8 })
      } else if (f.kind === 'wood') {
        scatterTrees(pts, 60, 70)
      } else if (f.kind === 'road') {
        const shape = new THREE.Shape(pts)
        const road = new THREE.Mesh(new THREE.ShapeGeometry(shape),
          new THREE.MeshStandardMaterial({ color: 0x6b6b6b, roughness: 1, side: THREE.DoubleSide }))
        road.rotation.x = Math.PI / 2
        const cg = elevAt(pts[0].x, pts[0].y) - baseElev
        road.position.y = cg + 0.05
        road.receiveShadow = true
        scene.add(road)
      }
    }
    } catch (e) { console.warn('osm', e) }

    try {
    // ---- dirt access track: transformer → array centre ----
    if (e?.transformer_point) {
      const [tx, tz] = toXY(e.transformer_point.lon, e.transformer_point.lat)
      // terrain-draped ribbon — a flat quad at one height lifts into a "ramp"
      // on slopes; a strip sampled along the ground stays walkable
      const len = Math.hypot(tx, tz) || 10, W = 1.6
      const segs = Math.max(4, Math.round(len / 2))   // denser → hugs terrain
      const ux = tx / len, uz = tz / len, px = -uz, pz = ux
      const pos: number[] = [], uv: number[] = [], idx: number[] = []
      for (let i = 0; i <= segs; i++) {
        const x = tx * i / segs, z = tz * i / segs
        for (const s of [-1, 1]) {
          const vx = x + px * s * W, vz = z + pz * s * W
          pos.push(vx, elevAt(vx, vz) - baseElev + 0.07, vz)
          uv.push(i / segs, (s + 1) / 2)
        }
        if (i < segs) {
          const a = i * 2
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
      }
      const tg = new THREE.BufferGeometry()
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
      tg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
      tg.setIndex(idx)
      tg.computeVertexNormals()
      const track = new THREE.Mesh(tg,
        new THREE.MeshStandardMaterial({ color: 0x8a7557, roughness: 1, side: THREE.DoubleSide }))
      track.receiveShadow = true
      scene.add(track)
    }
    } catch (e) { console.warn('track', e) }

    try {
    // ---- equipment: gravel pads + inverter/transformer kiosks ----
    const invMat = new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.35, metalness: 0.5 })
    const txMat = new THREE.MeshStandardMaterial({ color: 0x5e35a8, roughness: 0.45, metalness: 0.35 })
    const gravelMat = new THREE.MeshStandardMaterial({ color: 0x9b968c, roughness: 1 })
    const postMat2 = new THREE.MeshStandardMaterial({ color: 0x707478, roughness: 0.55, metalness: 0.75 })
    const pad = (x: number, z: number, r: number) => {
      const p = new THREE.Mesh(new THREE.CircleGeometry(r, 20), gravelMat)
      p.rotation.x = -Math.PI / 2
      p.position.set(x, elevAt(x, z) - baseElev + 0.08, z)
      p.receiveShadow = true
      scene.add(p)
    }
    for (const ip of e?.inverter_points ?? []) {
      const [x, z] = toXY(ip.lon, ip.lat)
      pad(x, z, 2.6)
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.7, 0.9), invMat)
      box.position.set(x, elevAt(x, z) - baseElev + 0.95, z)
      box.castShadow = true
      scene.add(box)
      tag(box, ip.id ?? 'INV', `${ip.capacity_kw ?? ''} kW string inverter`)
      colliders.push({ x, z, r: 1.9 })
    }
    if (e?.transformer_point) {
      const [x, z] = toXY(e.transformer_point.lon, e.transformer_point.lat)
      pad(x, z, 4)
      const kiosk = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3.6, 3), txMat)
      kiosk.position.set(x, elevAt(x, z) - baseElev + 1.9, z)
      kiosk.castShadow = true
      scene.add(kiosk)
      tag(kiosk, 'TX-01', `${e.transformer_kva ?? '?'} kVA transformer · ${e.connection_voltage ?? 'MV'} export`)
      colliders.push({ x, z, r: 3.2 })
      // HV warning sign on the pad edge
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.65),
        new THREE.MeshBasicMaterial({ color: 0xf5c518, side: THREE.DoubleSide }))
      sign.position.set(x + 3.4, elevAt(x + 3.4, z) - baseElev + 1.1, z)
      scene.add(sign)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), postMat2)
      pole.position.set(x + 3.4, elevAt(x + 3.4, z) - baseElev + 0.5, z)
      scene.add(pole)
      // weather station mast beside the substation (real farms monitor
      // irradiance/temp at one point on site)
      const [mx, mz] = [x + 7, z + 2]
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.2, 8), postMat2)
      mast.position.set(mx, elevAt(mx, mz) - baseElev + 2.1, mz)
      scene.add(mast)
      const vane = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.12), postMat2)
      vane.position.set(mx, elevAt(mx, mz) - baseElev + 4.1, mz)
      scene.add(vane)
      const sensor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28),
        new THREE.MeshStandardMaterial({ color: 0xd8dadd, roughness: 0.5 }))
      sensor.position.set(mx, elevAt(mx, mz) - baseElev + 3.6, mz)
      scene.add(sensor)
      tag(sensor, 'MET-01', 'Weather station · irradiance + module temp')
      colliders.push({ x: mx, z: mz, r: 0.5 })
      // gate on the fence line where the track enters (between TX and array)
      const gdx = -x / (Math.hypot(x, z) || 1), gdz = -z / (Math.hypot(x, z) || 1)
      const gx = x + gdx * 4, gz = z + gdz * 4
      const gpx = -gdz, gpz = gdx   // perpendicular
      for (const s of [-1, 1]) {
        const gp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.8, 0.14), postMat2)
        gp.position.set(gx + gpx * s * 2.2, elevAt(gx, gz) - baseElev + 0.9, gz + gpz * s * 2.2)
        scene.add(gp)
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.08, 0.08), postMat2)
      bar.position.set(gx, elevAt(gx, gz) - baseElev + 1.75, gz)
      bar.rotation.y = Math.atan2(gdz, gdx) + Math.PI / 2
      scene.add(bar)

      // real props: NVIDIA SimReady GLBs (CC-BY-4.0, codepawl/simready-glb)
      // barrier fences around the substation pad + the site gate
      const gltf = new GLTFLoader()
      const place = (url: string, x: number, z: number, ry: number, targetH: number, label?: [string, string]) => {
        gltf.load(url, g => {
          const obj = g.scene
          obj.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true } })
          const bb = new THREE.Box3().setFromObject(obj)
          const sz = bb.getSize(new THREE.Vector3())
          const s = targetH / (sz.y || 1)
          obj.scale.setScalar(s)
          const bb2 = new THREE.Box3().setFromObject(obj)
          obj.position.set(x - (bb2.min.x + bb2.max.x) / 2,
            elevAt(x, z) - baseElev - bb2.min.y, z - (bb2.min.z + bb2.max.z) / 2)
          obj.rotation.y = ry
          scene.add(obj)
          if (label) tag(obj, label[0], label[1])
          colliders.push({ x, z, r: Math.max(sz.x, sz.z) * s * 0.6 })
        }, undefined, () => { /* prop optional — boxes still render */ })
      }
      place('/assets/barrier_gate.glb', gx, gz, Math.atan2(gdz, gdx) + Math.PI / 2, 1.9,
        ['GATE-01', 'Site access gate'])
      for (const s of [-1, 1])
        place('/assets/barrier_fence.glb', x + gpx * s * 4.5, z + gpz * s * 4.5,
          Math.atan2(gdz, gdx), 1.8)
    }
    } catch (e) { console.warn('equipment', e) }

    try {
    // ---- cable trenches: flat ground-hugging strips inverter → transformer
    // (same right-angle routes the 2D map draws) + marker posts ----
    const trenchMat = new THREE.MeshStandardMaterial({ color: 0x4a3d2a, roughness: 1, side: THREE.DoubleSide })
    const markerMat = new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.6 })
    const markerGeo = new THREE.BoxGeometry(0.12, 0.9, 0.12)
    const strip = (a: number[], b: number[], W: number) => {
      const [x1, z1] = a, [x2, z2] = b
      const len = Math.hypot(x2 - x1, z2 - z1)
      if (len < 0.5) return
      const ux = (x2 - x1) / len, uz = (z2 - z1) / len, px = -uz, pz = ux
      const segs = Math.max(2, Math.round(len / 4))
      const pos: number[] = [], idx: number[] = []
      for (let i = 0; i <= segs; i++) {
        const x = x1 + ux * len * i / segs, z = z1 + uz * len * i / segs
        for (const s of [-1, 1]) {
          const vx = x + px * s * W / 2, vz = z + pz * s * W / 2
          pos.push(vx, elevAt(vx, vz) - baseElev + 0.06, vz)
        }
        if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2) }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
      g.setIndex(idx); g.computeVertexNormals()
      const m = new THREE.Mesh(g, trenchMat)
      m.receiveShadow = true
      scene.add(m)
      // marker posts every ~30 m along the leg
      for (let i = 0; i <= len; i += 30) {
        const mx = x1 + ux * i, mz = z1 + uz * i
        const mk = new THREE.Mesh(markerGeo, markerMat)
        mk.position.set(mx + px * 1.2, elevAt(mx + px * 1.2, mz + pz * 1.2) - baseElev + 0.45, mz + pz * 1.2)
        scene.add(mk)
      }
    }
    for (const r of e?.cable_routes ?? []) {
      const wps = r.coordinates.map(([lo, la]: number[]) => toXY(lo, la))
      for (let i = 0; i < wps.length - 1; i++) strip(wps[i], wps[i + 1], 0.8)
    }
    } catch (e) { console.warn('cables', e) }

    // ---- shared tree-scatter helper (user copse + OSM woodland) ----
    function scatterTrees(pts: THREE.Vector2[], density = 55, maxN = 80) {
      const inPolyF = (x: number, z: number) => {
        let inside = false
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          if ((pts[i].y > z) !== (pts[j].y > z) && x < (pts[j].x - pts[i].x) * (z - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside
        }
        return inside
      }
      const minx = Math.min(...pts.map(p => p.x)), maxx = Math.max(...pts.map(p => p.x))
      const miny = Math.min(...pts.map(p => p.y)), maxy = Math.max(...pts.map(p => p.y))
      const n = Math.min(maxN, Math.round((maxx - minx) * (maxy - miny) / density))
      for (let i = 0; i < n; i++) {
        const x = minx + rng() * (maxx - minx), z = miny + rng() * (maxy - miny)
        if (!inPolyF(x, z)) continue
        // skip anything past the ground plane — no terrain under it, and
        // out-of-bounds heights leave canopies floating in the sky
        if (x < minX || x > maxX || z < minZ || z > maxZ) continue
        const g0 = elevAt(x, z) - baseElev
        const h = 5 + rng() * 3.5
        // impostor sprite — always faces camera
        const spr = new THREE.Sprite(treeMats[Math.floor(rng() * treeMats.length)])
        spr.position.set(x, g0 + h / 2, z)
        spr.scale.set(h * 0.78, h, 1)
        scene.add(spr)
        // cheap grounding shadow disc (sprites can't cast real shadows)
        const shade = new THREE.Mesh(new THREE.CircleGeometry(h * 0.32, 14), shadeMat)
        shade.rotation.x = -Math.PI / 2
        shade.position.set(x + h * 0.08, g0 + 0.05, z + h * 0.05)
        scene.add(shade)
        colliders.push({ x, z, r: 0.6 })
      }
    }

    try {
    // ---- user-drawn exclusions rendered as real features ----
    for (const ex of site.exclusions ?? []) {
      const label = (ex.label || '').toLowerCase()
      const pts = ex.geometry.coordinates[0].map(([lo, la]: number[]) => toXY(lo, la)) as [number, number][]
      const v2 = pts.map(p => new THREE.Vector2(p[0], p[1]))
      // flat surfaces seat on the polygon's LOWEST edge so they don't float
      // or clip on slopes; water stays level by definition
      const g0 = Math.min(...pts.map(p => elevAt(p[0], p[1]))) - baseElev
      const shape = new THREE.Shape(v2)

      if (/(pond|water|lake)/.test(label)) {
        // reflective water surface + muddy rim — drawn at the EXACT exclusion
        // geometry; never rescale ShapeGeometry (scene-space verts would
        // shrink toward the origin and displace the pond off its real spot)
        const rim = new THREE.Mesh(new THREE.ShapeGeometry(shape),
          new THREE.MeshStandardMaterial({ color: 0x8a7557, roughness: 1, side: THREE.DoubleSide }))
        rim.rotation.x = Math.PI / 2
        rim.position.y = g0 + 0.04
        scene.add(rim)
        const water = new THREE.Mesh(new THREE.ShapeGeometry(shape),
          new THREE.MeshPhysicalMaterial({ color: 0x6db8d4, roughness: 0.1, metalness: 0.0,
            clearcoat: 0.5, clearcoatRoughness: 0.12, transparent: true, opacity: 0.8,
            side: THREE.DoubleSide,
            envMapIntensity: 1.3 }))
        water.rotation.x = Math.PI / 2
        water.position.y = g0 + 0.1
        scene.add(water)
      } else if (/(copse|wood|tree|forest|scrub)/.test(label)) {
        // trees only — the satellite imagery already shows the real canopy;
        // a flat floor disc seats badly on sloped ground and reads as a hole
        scatterTrees(v2, 45, 90)
      } else {
        // generic constraint: reddish tint
        const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({ color: 0xcc4444, transparent: true, opacity: 0.28, side: THREE.DoubleSide }))
        mesh.rotation.x = Math.PI / 2
        mesh.position.y = g0 + 0.08
        scene.add(mesh)
      }
    }
    } catch (e) { console.warn('exclusions', e) }

    try {
    // ---- grass: instanced crossed-quad tufts inside the boundary ----
    // (near-field detail layer à la explore-grand-teton's GroundCover)
    const inBnd = (x: number, z: number) => bnds.some(bnd => {
      let inside = false
      for (let i = 0, j = bnd.length - 1; i < bnd.length; j = i++)
        if ((bnd[i][1] > z) !== (bnd[j][1] > z) &&
            x < (bnd[j][0] - bnd[i][0]) * (z - bnd[i][1]) / (bnd[j][1] - bnd[i][1]) + bnd[i][0]) inside = !inside
      return inside
    })
    // two crossed quads per tuft
    const quad = new THREE.PlaneGeometry(1, 1)
    quad.translate(0, 0.5, 0)
    const gGeo = new THREE.BufferGeometry()
    {
      const q2 = quad.clone().rotateY(Math.PI / 2)
      const pos = new Float32Array([...quad.attributes.position.array, ...q2.attributes.position.array])
      const uv = new Float32Array([...quad.attributes.uv.array, ...q2.attributes.uv.array])
      const idx = [...quad.index!.array, ...q2.index!.array.map(i => i + 4)]
      gGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      gGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      gGeo.setIndex(idx)
      gGeo.computeVertexNormals()
    }
    const G = 3500
    const grass = new THREE.InstancedMesh(gGeo,
      new THREE.MeshStandardMaterial({ map: grassSpriteTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 1 }), G)
    const gd = new THREE.Object3D()
    let gi = 0
    for (let i = 0; i < G * 4 && gi < G; i++) {
      const x = minX + rng() * (maxX - minX), z = minZ + rng() * (maxZ - minZ)
      if (!inBnd(x, z)) continue
      gd.position.set(x, elevAt(x, z) - baseElev, z)
      gd.rotation.y = rng() * Math.PI
      const s = 0.35 + rng() * 0.55
      gd.scale.set(s, s * (0.7 + rng() * 0.6), s)
      gd.updateMatrix()
      grass.setMatrixAt(gi++, gd.matrix)
    }
    grass.count = gi
    scene.add(grass)
    } catch (e) { console.warn('grass', e) }

    // ---- drifting clouds ----
    const clouds: THREE.Sprite[] = []
    for (let i = 0; i < 7; i++) {
      const m = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.5 + rng() * 0.3, depthWrite: false })
      const s = new THREE.Sprite(m)
      s.position.set((rng() - 0.5) * span * 1.4, 120 + rng() * 140, (rng() - 0.5) * span * 1.4)
      const w = 120 + rng() * 220
      s.scale.set(w, w * 0.4, 1)
      clouds.push(s)
      scene.add(s)
    }

    // ---- spawn: stand at the access point, look at the array ----
    camera.position.set(spawn[0], elevAt(spawn[0], spawn[1]) - baseElev + EYE, spawn[1])
    camera.lookAt(0, camera.position.y, 0)
    yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y
    const enter = () => { try { controls.lock() } catch { /* drag-look fallback */ } }
    api_.current = { setSun, enter }

    ;(window as any).__beamScene = scene
    // ---- loop ----
    let raf = 0, frame = 0
    const clock = new THREE.Clock()
    const ray = new THREE.Raycaster()
    const center2 = new THREE.Vector2(0, 0)
    const animate = () => {
      raf = requestAnimationFrame(animate)
      frame++
      const dt = Math.min(clock.getDelta(), 0.05)
      // ---- first-person movement ----
      const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight')
      const speed = sprint ? 22 : 8
      const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
      const str = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
      const dir = new THREE.Vector3(str, 0, -fwd).normalize()
      // move relative to camera yaw only (no pitch in walking)
      dir.applyEuler(new THREE.Euler(0, new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y, 0, 'YXZ'))
      vel.lerp(dir.multiplyScalar(speed), airborne ? 0.04 : 0.25)
      camera.position.addScaledVector(vel, dt)
      resolveColliders(camera.position)
      // sprint FOV kick — subtle speed cue
      const targetFov = sprint && vel.lengthSq() > 40 ? 78 : 70
      if (Math.abs(camera.fov - targetFov) > 0.1) {
        camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6)
        camera.updateProjectionMatrix()
      }
      // gravity + terrain-following eye height
      const groundY = elevAt(camera.position.x, camera.position.z) - baseElev + EYE
      if (airborne) {
        vy -= 14 * dt
        camera.position.y += vy * dt
        if (camera.position.y <= groundY) { camera.position.y = groundY; vy = 0; airborne = false }
      } else {
        // smooth follow so slopes don't feel like teleporting
        camera.position.y += (groundY - camera.position.y) * Math.min(1, dt * 12)
      }
      // head-bob while moving on the ground
      if (!airborne && vel.lengthSq() > 1)
        camera.position.y += Math.sin(clock.elapsedTime * (sprint ? 11 : 8)) * 0.035
      camera.position.x = Math.max(minX, Math.min(maxX, camera.position.x))
      camera.position.z = Math.max(minZ, Math.min(maxZ, camera.position.z))
      for (const c of clouds) {
        c.position.x += dt * 2.2
        if (c.position.x > span * 0.9) c.position.x = -span * 0.9
      }
      // ---- inspection raycast: what is the crosshair on? ----
      if ((frame & 7) === 0) {
        ray.setFromCamera(center2, camera)
        const hit = ray.intersectObjects(inspectables, false)[0]
        let next: { label: string; sub?: string } | null = null
        if (hit && hit.distance < 80) {
          const t = tags.get(hit.object)
          if (t) next = (t.instId && hit.instanceId != null) ? t.instId(hit.instanceId)
            : { label: t.label, sub: t.sub }
        }
        const cur = inspRef.current
        if ((next?.label ?? null) !== (cur?.label ?? null) || (next?.sub ?? null) !== (cur?.sub ?? null))
          setInsp(next)
      }
      grade.uniforms.uTime.value = clock.elapsedTime
      updateChips()
      composer.render()
    }
    animate()

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      composer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && !controls.isLocked && onClose()
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousemove', onMMove)
      window.removeEventListener('mouseup', onMUp)
      controls.dispose()
      composer.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      for (const { el } of chips) el.remove()
    }
  }, [design, dem])

  useEffect(() => { api_.current?.setSun(sunHour) }, [sunHour])

  return (
    <div className="absolute inset-0 z-20 bg-black pointer-events-auto">
      <div ref={mountRef} className="w-full h-full" />
      {dem === undefined && (
        <div className="absolute inset-0 grid place-items-center bg-black/80">
          <div className="text-center">
            <div className="microlabel text-[#d9822b] mb-2">LOADING TERRAIN</div>
            <div className="text-xs text-slate-500">fetching elevation + imagery for this site…</div>
          </div>
        </div>
      )}
      {/* click-to-enter prompt — pointer lock needs a user gesture.
          Kept low + compact so it doesn't block the view */}
      {dem !== undefined && !locked && (
        <button onClick={() => api_.current?.enter()}
          className="absolute bottom-20 inset-x-0 mx-auto w-fit panel px-4 py-2 flex items-center gap-3 hover:border-[#d9822b] transition-colors z-10">
          <span className="microlabel text-[#d9822b]">FPS</span>
          <span className="text-xs">Click to walk the site</span>
          <span className="text-[10px] text-slate-500">WASD · mouse · shift · space</span>
        </button>
      )}
      {/* crosshair + inspection label while locked */}
      {locked && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="w-1.5 h-1.5 rounded-full bg-white/70 shadow" />
          {insp && (
            <div className="absolute mt-14 panel px-3 py-1.5 text-center">
              <div className="text-xs font-semibold text-[#d9822b]">{insp.label}</div>
              {insp.sub && <div className="text-[10px] text-slate-400">{insp.sub}</div>}
            </div>
          )}
        </div>
      )}
      <div className="absolute top-3 right-3 flex gap-2">
        {!locked && (
          <button onClick={onClose}
            className="px-3 py-1.5 rounded text-xs bg-black/70 border border-[#2a3646] hover:bg-[#141a24]">
            ✕ Close (Esc)
          </button>
        )}
      </div>
      <div className="absolute bottom-4 left-3 panel px-3 py-2 flex items-center gap-2">
        <span className="text-xs text-slate-400">☀ {String(Math.floor(sunHour)).padStart(2, '0')}:{String(Math.round((sunHour % 1) * 60)).padStart(2, '0')}</span>
        <input type="range" min={5} max={21.5} step={0.25} value={sunHour}
          onChange={e => setSunHour(+e.target.value)} className="w-44 accent-yellow-400" />
        <span className="text-[10px] text-slate-500">drag — sun + shadows</span>
      </div>
      <div className="absolute bottom-4 right-3 text-[10px] text-slate-500 bg-black/60 rounded px-2 py-1">
        {locked ? 'esc — release mouse · wasd move · shift sprint · space jump' : 'click to enter · or drag to look'}
      </div>
    </div>
  )
}
