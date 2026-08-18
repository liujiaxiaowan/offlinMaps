const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

class MBTilesManager {
  constructor(configPath) {
    this.configPath = configPath
    this.maps = new Map()
  }

  load() {
    const config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'))
    const errors = []

    for (const mapConfig of config.maps) {
      try {
        this.registerMap(mapConfig)
      } catch (error) {
        errors.push({ id: mapConfig.id, error: error.message })
      }
    }

    return {
      loaded: this.maps.size,
      errors
    }
  }

  registerMap(mapConfig) {
    const { id, name, path: filePath, description } = mapConfig

    if (!id || !filePath) {
      throw new Error('地图配置缺少 id 或 path 字段')
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`MBTiles 文件不存在: ${filePath}`)
    }

    const db = new Database(filePath, { readonly: true, fileMustExist: true })
    const metadata = this.readMetadata(db)
    const zoomRange = db.prepare('SELECT MIN(zoom_level) AS minZoom, MAX(zoom_level) AS maxZoom FROM tiles').get()

    this.maps.set(id, {
      id,
      name: name || metadata.name || id,
      description: description || metadata.description || '',
      filePath,
      db,
      metadata,
      format: metadata.format || 'png',
      bounds: this.parseBounds(metadata.bounds),
      center: this.parseCenter(metadata.center),
      minZoom: zoomRange?.minZoom ?? 0,
      maxZoom: zoomRange?.maxZoom ?? 18,
      tileCount: db.prepare('SELECT COUNT(*) AS count FROM tiles').get()?.count ?? 0
    })
  }

  readMetadata(db) {
    const rows = db.prepare('SELECT name, value FROM metadata').all()
    return rows.reduce((acc, row) => {
      acc[row.name] = row.value
      return acc
    }, {})
  }

  parseBounds(boundsStr) {
    if (!boundsStr) return null
    const [west, south, east, north] = boundsStr.split(',').map(Number)
    if ([west, south, east, north].some(Number.isNaN)) return null
    return { west, south, east, north }
  }

  parseCenter(centerStr) {
    if (!centerStr) return null
    const [lon, lat, zoom] = centerStr.split(',').map(Number)
    if ([lon, lat].some(Number.isNaN)) return null
    return { lon, lat, zoom: Number.isNaN(zoom) ? undefined : zoom }
  }

  listMaps() {
    return Array.from(this.maps.values()).map((map) => this.toPublicMeta(map))
  }

  getMap(mapId) {
    const map = this.maps.get(mapId)
    if (!map) return null
    return this.toPublicMeta(map)
  }

  toPublicMeta(map) {
    return {
      id: map.id,
      name: map.name,
      description: map.description,
      format: map.format,
      bounds: map.bounds,
      center: map.center,
      minZoom: map.minZoom,
      maxZoom: map.maxZoom,
      tileCount: map.tileCount,
      tileUrl: `/api/maps/${map.id}/tiles/{z}/{x}/{y}.${map.format}`,
      wmtsUrl: `/wmts/${map.id}`,
      metadata: map.metadata
    }
  }

  getTile(mapId, z, x, y) {
    const map = this.maps.get(mapId)
    if (!map) {
      return { status: 404, error: `地图 "${mapId}" 不存在` }
    }

    const zoom = Number(z)
    const column = Number(x)
    const row = Number(y)

    if (!Number.isInteger(zoom) || !Number.isInteger(column) || !Number.isInteger(row)) {
      return { status: 400, error: '瓦片坐标必须为整数' }
    }

    if (zoom < map.minZoom || zoom > map.maxZoom) {
      return { status: 404, error: '请求的缩放级别超出范围' }
    }

    const maxIndex = Math.pow(2, zoom)
    if (column < 0 || column >= maxIndex || row < 0 || row >= maxIndex) {
      return { status: 404, error: '瓦片坐标超出范围' }
    }

    const tmsRow = maxIndex - 1 - row
    const tile = map.db
      .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
      .get(zoom, column, tmsRow)

    if (!tile) {
      return { status: 404, error: '瓦片不存在' }
    }

    return {
      status: 200,
      data: tile.tile_data,
      contentType: this.getContentType(map.format)
    }
  }

  /**
   * 将 XYZ 瓦片坐标转换为瓦片中心的经纬度（WGS84）
   * @param {number} z 缩放级别
   * @param {number} x 横向瓦片索引（XYZ 方案）
   * @param {number} y 纵向瓦片索引（XYZ 方案）
   * @returns {{lon: number, lat: number}}
   */
  tileToLatLng(z, x, y) {
    const n = Math.pow(2, z)
    const lon = (x + 0.5) / n * 360 - 180
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180) / Math.PI
    return { lon, lat }
  }

  /**
   * 判断经纬度点是否在地图边界内
   */
  isPointInBounds(map, lon, lat) {
    if (!map.bounds) return false
    const { west, south, east, north } = map.bounds
    return lon >= west && lon <= east && lat >= south && lat <= north
  }

  /**
   * 统一瓦片接口：根据 (z, x, y) 自动判断所属地理区域并返回最详细的瓦片数据
   * - 按 maxZoom 降序遍历包含该点的地图，优先使用精度最高的数据源
   * - 当请求 z 超过地图 maxZoom 时，使用 overzoom 策略回退到 maxZoom 处的父瓦片
   * - 找不到匹配数据时返回 404
   * @param {string|number} z
   * @param {string|number} x
   * @param {string|number} y
   */
  getTileAuto(z, x, y) {
    const zoom = Number(z)
    const column = Number(x)
    const row = Number(y)

    if (!Number.isInteger(zoom) || !Number.isInteger(column) || !Number.isInteger(row)) {
      return { status: 400, error: '瓦片坐标必须为整数' }
    }
    if (zoom < 0) {
      return { status: 400, error: '缩放级别不能为负数' }
    }

    const maxIndex = Math.pow(2, zoom)
    if (column < 0 || column >= maxIndex || row < 0 || row >= maxIndex) {
      return { status: 404, error: '瓦片坐标超出范围' }
    }

    // 计算瓦片中心经纬度，用于区域检测
    const { lon, lat } = this.tileToLatLng(zoom, column, row)

    // 收集所有包含该点的地图，按 maxZoom 降序（优先高精度数据源）
    const candidates = []
    for (const map of this.maps.values()) {
      if (this.isPointInBounds(map, lon, lat)) {
        candidates.push(map)
      }
    }
    candidates.sort((a, b) => b.maxZoom - a.maxZoom)

    let lastError = '该区域无瓦片数据'
    for (const map of candidates) {
      // z 低于地图最小级别，跳过（不支持 underzoom）
      if (zoom < map.minZoom) continue

      let fetchZ, fetchX, fetchY, overzoom = false
      if (zoom <= map.maxZoom) {
        // 直接命中
        fetchZ = zoom
        fetchX = column
        fetchY = row
      } else {
        // overzoom：回退到该地图 maxZoom 处的父瓦片
        const dz = zoom - map.maxZoom
        const scale = Math.pow(2, dz)
        fetchZ = map.maxZoom
        fetchX = Math.floor(column / scale)
        fetchY = Math.floor(row / scale)
        overzoom = true
      }

      const tmsRow = Math.pow(2, fetchZ) - 1 - fetchY
      const tile = map.db
        .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
        .get(fetchZ, fetchX, tmsRow)

      if (tile) {
        return {
          status: 200,
          data: tile.tile_data,
          contentType: this.getContentType(map.format),
          source: {
            mapId: map.id,
            mapName: map.name,
            z: fetchZ,
            x: fetchX,
            y: fetchY,
            overzoom
          }
        }
      }
      lastError = `瓦片不存在于地图 "${map.name}"`
    }

    return { status: 404, error: lastError }
  }

  getContentType(format) {
    const types = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      pbf: 'application/x-protobuf',
      mvt: 'application/vnd.mapbox-vector-tile'
    }
    return types[format?.toLowerCase()] || 'application/octet-stream'
  }

  reload() {
    for (const map of this.maps.values()) {
      map.db.close()
    }
    this.maps.clear()
    return this.load()
  }

  close() {
    for (const map of this.maps.values()) {
      map.db.close()
    }
    this.maps.clear()
  }
}

module.exports = MBTilesManager
