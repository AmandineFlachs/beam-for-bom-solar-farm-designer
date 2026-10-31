import * as Cesium from 'cesium'

const TILE_URL = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
const TILE_SIZE = 256 // decode at reduced res for speed

/**
 * Terrarium-encoded terrain provider (Mapterhorn, no API key).
 * height = R*256 + G + B/256 - 32768
 * Falls back gracefully: constructor never throws; failed tiles return 0 m.
 */
export class TerrariumTerrainProvider implements Cesium.TerrainProvider {
  readonly tilingScheme = new Cesium.WebMercatorTilingScheme()
  readonly credit = new Cesium.Credit('Terrain © Mapterhorn / source DEM', true)
  readonly errorEvent = new Cesium.Event()
  readonly hasWaterMask = false
  readonly hasVertexNormals = false
  readonly availability: any = undefined // undefined → all tiles considered available
  ready = true
  readyPromise = Promise.resolve(true)

  getLevelMaximumGeometricError(level: number): number {
    return this.tilingScheme.getNumberOfYTilesAtLevel(level) * 45
  }

  getTileDataAvailable(): boolean | undefined {
    return true
  }

  loadTileDataAvailability(): undefined {
    return undefined
  }

  requestTileGeometry(x: number, y: number, level: number): Promise<Cesium.TerrainData> | undefined {
    if (level > 15) return undefined
    const url = TILE_URL.replace('{z}', String(level)).replace('{x}', String(x)).replace('{y}', String(y))
    return this._load(url, level)
  }

  private async _load(url: string, level: number): Promise<Cesium.TerrainData> {
    const zero = () => new Cesium.HeightmapTerrainData({
      buffer: new Float32Array(TILE_SIZE * TILE_SIZE),
      width: TILE_SIZE, height: TILE_SIZE,
      childTileMask: level < 15 ? 15 : 0,
    })
    try {
      const img = await this._fetchImage(url)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = TILE_SIZE
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE)
      const px = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
      const heights = new Float32Array(TILE_SIZE * TILE_SIZE)
      for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        heights[j] = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768
      }
      return new Cesium.HeightmapTerrainData({
        buffer: heights, width: TILE_SIZE, height: TILE_SIZE,
        childTileMask: level < 15 ? 15 : 0,
      })
    } catch {
      return zero()
    }
  }

  private _fetchImage(url: string): Promise<HTMLImageElement | ImageBitmap> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = url
    })
  }
}

/** Sample terrain heights for a set of Cartographic positions. */
export async function sampleHeights(
  provider: Cesium.TerrainProvider,
  positions: { lon: number; lat: number }[],
): Promise<number[]> {
  const zeros = positions.map(() => 0)
  try {
    const cartos = positions.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat))
    // sampleTerrainMostDetailed can hang against minimal custom providers —
    // race it against a timeout so rendering is never blocked.
    const sampled = await Promise.race([
      Cesium.sampleTerrainMostDetailed(provider, cartos),
      new Promise<null>(res => setTimeout(() => res(null), 8000)),
    ])
    return sampled ? sampled.map(c => c.height) : zeros
  } catch {
    return zeros
  }
}
