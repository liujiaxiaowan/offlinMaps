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

  /**
   * 注册地图：坐标数据（bounds/center/minZoom/maxZoom）支持配置显式覆盖。
   *
   * 优先级：config 显式声明 > mbtiles metadata。
   * - bounds/center 统一采用 WGS84 经纬度（west,south,east,north），与前端
   *   Web Mercator (EPSG:3857) 投影换算保持同一地理参考标准，保证跨层级位置一致性。
   * - 显式 bounds 用于人工校准行政区划精确范围（metadata 的下载框可能含缓冲区/海洋），
   *   直接决定 getTileAuto 的区域命中与层级动态切换（z≤5 全球 → z6-9 国家级 → z10+ 省市）。
   */
  registerMap(mapConfig) {
    const { id, name, path: filePath, description, bounds, center, minZoom, maxZoom, tileOffsetX } = mapConfig

    if (!id || !filePath) {
      throw new Error('地图配置缺少 id 或 path 字段')
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`MBTiles 文件不存在: ${filePath}`)
    }

    const db = new Database(filePath, { readonly: true, fileMustExist: true })
    const metadata = this.readMetadata(db)
    const tileCount = db.prepare('SELECT COUNT(*) AS count FROM tiles').get()?.count ?? 0
    // 空数据地图（tileCount=0）的 minZoom/maxZoom 置为 null，
    // 避免 getTileAuto 误判为覆盖全层级而阻断全球兜底，同时防止污染前端 maxDataZoom 计算
    let metaMinZoom = null
    let metaMaxZoom = null
    if (tileCount > 0) {
      const zoomRange = db.prepare('SELECT MIN(zoom_level) AS minZoom, MAX(zoom_level) AS maxZoom FROM tiles').get()
      metaMinZoom = zoomRange?.minZoom ?? null
      metaMaxZoom = zoomRange?.maxZoom ?? null
    }

    // 解析配置显式坐标（数组 [west,south,east,north] 或对象 {west,south,east,north}）
    const configBounds = this.parseBoundsConfig(bounds)
    const configCenter = this.parseCenterConfig(center)
    const configMinZoom = Number.isFinite(minZoom) ? minZoom : null
    const configMaxZoom = Number.isFinite(maxZoom) ? maxZoom : null
    // 瓦片内容 X 方向网格偏移矫正量（2026-09-04 中国地图实测）：
    // 部分下载工具生成的 mbtiles 瓦片内容相对标准 XYZ 网格整体错列存储——
    // 存储列 X 的瓦片图像实为标准网格列 X+tileOffsetX 的地理内容（y 方向无偏移）。
    // 读取时 fetchX = x - tileOffsetX 即可对齐标准网格。
    // 实测依据：中国地图存储 (z,X,Y) 与 江苏/全球 同源瓦片 (z,X+2,Y) 相关性高达
    // 0.995-1.000，且其内部 z↔z-1 父子象限匹配统一差 1 父列（=2 子列），全国范围一致。
    const offsetX = Number.isFinite(tileOffsetX) ? tileOffsetX : 0

    this.maps.set(id, {
      id,
      name: name || metadata.name || id,
      description: description || metadata.description || '',
      filePath,
      db,
      metadata,
      format: metadata.format || 'png',
      // 精确坐标数据：配置显式声明优先，其次 mbtiles metadata
      bounds: configBounds || this.parseBounds(metadata.bounds),
      center: configCenter || this.parseCenter(metadata.center),
      minZoom: configMinZoom !== null ? configMinZoom : metaMinZoom,
      maxZoom: configMaxZoom !== null ? configMaxZoom : metaMaxZoom,
      tileOffsetX: offsetX,
      tileCount,
      empty: tileCount === 0
    })
  }

  /**
   * 解析配置中的显式 bounds（精确行政区划坐标）。
   * 支持两种形式：
   *   数组：[west, south, east, north]（WGS84 经纬度）
   *   对象：{ west, south, east, north }
   */
  parseBoundsConfig(bounds) {
    if (!bounds) return null
    let west, south, east, north
    if (Array.isArray(bounds)) {
      ;[west, south, east, north] = bounds
    } else {
      ;({ west, south, east, north } = bounds)
    }
    const nums = [west, south, east, north].map(Number)
    if (nums.some((n) => !Number.isFinite(n))) return null
    if (nums[0] >= nums[2] || nums[1] >= nums[3]) return null // west<east、south<north 基本校验
    const [w, s, e, n] = nums
    return { west: w, south: s, east: e, north: n }
  }

  /**
   * 解析配置中的显式 center（WGS84 经纬度 + 可选初始层级）。
   * 支持：[lon, lat] / [lon, lat, zoom] / { lon, lat, zoom }
   */
  parseCenterConfig(center) {
    if (!center) return null
    let lon, lat, zoom
    if (Array.isArray(center)) {
      ;[lon, lat, zoom] = center
    } else {
      ;({ lon, lat, zoom } = center)
    }
    const lonN = Number(lon)
    const latN = Number(lat)
    if (!Number.isFinite(lonN) || !Number.isFinite(latN)) return null
    return { lon: lonN, lat: latN, zoom: Number.isFinite(Number(zoom)) ? Number(zoom) : undefined }
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
      empty: map.empty || false,
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
    if (map.tileCount === 0) {
      return { status: 404, error: '该地图无瓦片数据' }
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
    // 应用瓦片内容网格偏移矫正：存储列 X 的内容实为标准列 X+offsetX，读取需减去偏移量
    const fetchColumn = column - (map.tileOffsetX || 0)
    const tile =
      fetchColumn >= 0 && fetchColumn < maxIndex
        ? map.db
            .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
            .get(zoom, fetchColumn, tmsRow)
        : null

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
    const lon = ((x + 0.5) / n) * 360 - 180
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI
    return { lon, lat }
  }

  /**
   * 判断经纬度点是否在地图边界内
   * - 无 bounds 视为全球覆盖（用于全球底图兜底）
   */
  isPointInBounds(map, lon, lat) {
    if (!map.bounds) return true
    const { west, south, east, north } = map.bounds
    return lon >= west && lon <= east && lat >= south && lat <= north
  }

  /**
   * 判断地图是否为全球底图（bounds 为空或覆盖全球范围）
   */
  isGlobalMap(map) {
    if (!map.bounds) return true
    const { west, south, east, north } = map.bounds
    // 全球范围容差：经度跨 ≥ 350°、纬度跨 ≥ 170°
    return east - west >= 350 && north - south >= 170
  }

  /**
   * 获取已注册的全球地图（若有数据），否则返回 null
   * 空数据的全球地图不返回，避免兜底分支无意义命中
   */
  getGlobalMap() {
    for (const map of this.maps.values()) {
      if (this.isGlobalMap(map) && map.tileCount > 0) return map
    }
    return null
  }

  /**
   * 计算 bounds 覆盖面积（经度跨度 × 纬度跨度），无 bounds 视为无穷大（全球）
   */
  _boundsArea(bounds) {
    if (!bounds) return Infinity
    return (bounds.east - bounds.west) * (bounds.north - bounds.south)
  }

  /**
   * 判断瓦片矩形与地图 bounds 是否相交（WGS84）
   *
   * 用"矩形相交"而非"中心点命中"：低层级瓦片单格可达 2.8°×2°，省界/海岸线边缘瓦片
   * 常出现"瓦片覆盖交界陆地但中心点落在邻省 bounds 之外或海域"的情况（如 z7 沪苏交界的
   * 107/52 中心在 122.34°E 海域，超出上海/江苏 bounds），中心点判断会把这些瓦片从所有
   * 省级候选中排除，国家级地图又稀疏缺失 → 404 空白。矩形相交使它们进入候选回退链。
   */
  isTileIntersectsBounds(map, z, x, y) {
    if (!map.bounds) return true
    const n = Math.pow(2, z)
    const tileWest = (x / n) * 360 - 180
    const tileEast = ((x + 1) / n) * 360 - 180
    const tileNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    const tileSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
    const { west, south, east, north } = map.bounds
    return tileWest <= east && tileEast >= west && tileSouth <= north && tileNorth >= south
  }

  /**
   * 找出"国家级"概览地图：非全球、非空、覆盖范围最大的地图（如中国）。
   * 其 maxZoom 是"国家级概览"与"省级详情"之间的自然分界。
   * 结果缓存到 this._nationalMap（地图集合加载后不变）。
   */
  getNationalMap() {
    if (this._nationalMap !== undefined) return this._nationalMap
    let national = null
    let maxArea = -1
    for (const map of this.maps.values()) {
      if (this.isGlobalMap(map)) continue
      if (map.tileCount === 0) continue
      const area = this._boundsArea(map.bounds)
      if (area > maxArea) {
        maxArea = area
        national = map
      }
    }
    this._nationalMap = national
    return national
  }

  /**
   * 统一瓦片接口：根据 (z, x, y) 自动判断所属地理区域并返回最详细的瓦片数据
   *
   * 核心思路：建立清晰的缩放层级，避免"不同数据源在同一缩放级别混叠"导致双重图层/错位。
   *   - z ≤ globalMap.maxZoom（如 z≤5）：全球地图是完整、一致的数据源，直接返回全球瓦片（唯一数据源）
   *   - globalMap.maxZoom < z ≤ 国家级.maxZoom（如 z6-9）：优先国家级概览（覆盖最广，如中国）；
   *     国家级稀疏缺失的瓦片回退省市级直接命中候选（消除两省交界空白）
   *   - z > 国家级.maxZoom（如 z10+）：使用省级/市级地图，按 bounds 面积升序（更具体/内层优先），
   *     正确处理省际/市际边界——每个瓦片按其矩形与 bounds 的相交关系独立选择数据源
   *     （如上海 ⊂ 江苏 时上海内部用上海、外部用江苏；交界缓冲瓦片由首个命中来源衔接）
   *
   * 关键规则：
   *   - 直接命中(priority=0)候选按序逐一尝试：国家级地图优先，其次按 bounds 面积升序（更具体优先）
   *     国家级地图稀疏缺失的瓦片（如两省交界、省界缓冲区）由省市级候选无缝衔接，
   *     消除"临近两省交接处空白"；每个瓦片仅由首个命中来源提供，无同格双源混叠
   *   - underzoom(z<minZoom) 回退到该地图 minZoom 的祖先瓦片（一对多覆盖，无重复渲染）
   *   - z > map.maxZoom 时不做服务端 overzoom（同一父瓦片重复返回会导致重复渲染/错位），
   *     返回 404 由前端 OL 客户端放大当前图像兜底（"滚动只放大当前图片"）
   *   - 找不到匹配数据时返回 404
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

    // 第一步：全球地图（低层级唯一数据源）
    // z ≤ globalMap.maxZoom 时，全球地图覆盖完整（如 z1-5 全覆盖），直接返回，
    // 避免与区域地图（如中国 z1-9 稀疏瓦片）在同一 z 混叠产生"双层覆盖/错位"。
    const globalMap = this.getGlobalMap()
    if (globalMap && globalMap.maxZoom !== null && zoom <= globalMap.maxZoom) {
      return this._fetchTile(globalMap, zoom, column, row, { globalFallback: true })
    }

    // 第二步：收集所有与该瓦片矩形相交的"区域地图"（非全球、非空数据）
    // 空数据地图不参与候选，避免误判覆盖范围
    // 候选用"瓦片矩形与 bounds 相交"判定（而非中心点）：省界/海岸线边缘瓦片
    // 覆盖交界陆地但中心点可能落在邻省 bounds 外或海域，中心点判断会排除全部
    // 省级候选 → 国家级稀疏缺失时 404 → 两省交界空白。
    // 关键：z > map.maxZoom 的地图直接跳过（不做服务端 overzoom）。
    //   原因：服务端 overzoom 会把同一张父瓦片返回给多个子瓦片请求，
    //   OL 将整张父图绘制进每个子格子 → 同一图像被重复渲染/错位（"南京重复出现"）。
    //   正确做法是返回 404，由前端 OL 对"当前已显示的图像"做客户端放大（client-side overzoom），
    //   即"用户滚动只放大当前图片"，天然无重复、无错位、无黑块。
    const regionalCandidates = []
    for (const map of this.maps.values()) {
      if (this.isGlobalMap(map)) continue // 全球地图已在第一步处理
      if (map.tileCount === 0) continue // 空数据地图不参与候选
      if (!this.isTileIntersectsBounds(map, zoom, column, row)) continue
      if (zoom > map.maxZoom) continue // 超出该地图最大层级：不做服务端 overzoom，交由前端客户端放大
      // priority：0=直接命中(minZoom ≤ z ≤ maxZoom)，1=underzoom(z < minZoom)
      const priority = zoom < map.minZoom ? 1 : 0
      regionalCandidates.push({ map, priority })
    }

    // 候选筛选优先级（数值越小越优先）：
    // 0: 直接命中 (minZoom ≤ z ≤ maxZoom)
    // 1: underzoom (z < minZoom，回退到该地图 minZoom 的祖先瓦片，一对多覆盖，无重复渲染)
    // 排序：先按优先级升序；
    //   - priority=0（直接命中）时：
    //     1) "国家级"地图（覆盖最广，如中国）优先——仅在 z ≤ 其 maxZoom 时它才可能是 priority=0，
    //        保证 z6-9 优先由国家级概览提供，不与省级稀疏数据混叠
    //     2) 同为省级时按 bounds 面积升序（更具体/内层优先）——正确处理嵌套场景（上海 ⊂ 江苏），
    //        使省际/市际边界处各自命中各自的省份数据源
    //   - priority=1（underzoom）时按 maxZoom 降序：偏好更接近目标层级的地图。
    const nationalMap = this.getNationalMap()
    regionalCandidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      if (a.priority === 0) {
        const aNational = a.map === nationalMap
        const bNational = b.map === nationalMap
        if (aNational !== bNational) return aNational ? -1 : 1
        return this._boundsArea(a.map.bounds) - this._boundsArea(b.map.bounds)
      }
      return b.map.maxZoom - a.map.maxZoom
    })

    // 候选选择：所有 priority=0（直接命中）候选按序逐一尝试——国家级在前（z6-9 权威概览），
    // 其后省市按 bounds 面积升序（更具体/内层优先）。
    // 国家级地图是稀疏下载（如中国 z8 仅覆盖部分区域），其缺失瓦片（典型：两省交界缓冲区、
    // 省界外缘）由后续省市级候选无缝衔接，消除"临近两省交接处空白"；
    // 每个瓦片仅由首个命中来源提供，无同格双源混叠（当年"南京重复"根因是整张祖先瓦片
    // 返回给多个子格重复渲染，已由"禁止服务端 overzoom + 单来源逐候选回退"规避）。
    // 无 priority=0 候选时回退 underzoom 候选（祖先瓦片一对多覆盖，无重复渲染）。
    let tryList = regionalCandidates.filter((c) => c.priority === 0)
    if (tryList.length === 0) tryList = regionalCandidates
    for (const { map } of tryList) {
      const result = this._fetchTile(map, zoom, column, row)
      if (result) return result
    }

    return { status: 404, error: '该区域无瓦片数据' }
  }

  /**
   * 从指定地图获取瓦片，自动处理 direct/underzoom 回退
   * 注意：调用方（getTileAuto）已保证 zoom ≤ map.maxZoom，
   *       不做服务端 overzoom（避免同一父瓦片重复返回导致重复渲染）
   * @param {object} map 地图对象（含 db、minZoom、maxZoom、format 等）
   * @param {number} zoom 请求的缩放级别
   * @param {number} column 请求的瓦片列（XYZ）
   * @param {number} row 请求的瓦片行（XYZ）
   * @param {object} extra 附加到 source 的字段（如 globalFallback）
   * @returns {object|null} 命中返回 {status,data,contentType,source}，未命中返回 null
   */
  _fetchTile(map, zoom, column, row, extra = {}) {
    let fetchZ
    let fetchX
    let fetchY
    let underzoom = false

    if (zoom >= map.minZoom && zoom <= map.maxZoom) {
      // 直接命中
      fetchZ = zoom
      fetchX = column
      fetchY = row
    } else {
      // underzoom：回退到该地图 minZoom 处的祖先瓦片（一对多覆盖，无重复渲染）
      const dz = map.minZoom - zoom
      const scale = Math.pow(2, dz)
      fetchZ = map.minZoom
      fetchX = Math.floor(column * scale)
      fetchY = Math.floor(row * scale)
      underzoom = true
    }

    // 应用瓦片内容网格偏移矫正（direct 与 underzoom 祖先瓦片同样偏移）：
    // 存储列 X 的内容实为标准列 X+offsetX，读取需减去偏移量
    const offsetX = map.tileOffsetX || 0
    const fetchColumn = fetchX - offsetX
    const tmsRow = Math.pow(2, fetchZ) - 1 - fetchY
    const tile =
      fetchColumn >= 0 && fetchColumn < Math.pow(2, fetchZ)
        ? map.db
            .prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?')
            .get(fetchZ, fetchColumn, tmsRow)
        : null

    if (!tile) return null

    return {
      status: 200,
      data: tile.tile_data,
      contentType: this.getContentType(map.format),
      source: {
        mapId: map.id,
        mapName: map.name,
        z: fetchZ,
        x: fetchColumn,
        y: fetchY,
        overzoom: false,
        underzoom,
        ...extra
      }
    }
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
