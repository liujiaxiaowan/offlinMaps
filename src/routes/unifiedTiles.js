const express = require('express')

/**
 * 统一瓦片地图服务接口路由
 * 路由格式：GET /api/maps/tiles/:z/:x/:y.:format
 * 根据 (z, x, y) 自动判断所属地理区域，返回最匹配的瓦片数据
 */
function createUnifiedTilesRouter(mbtilesManager) {
  const router = express.Router()

  // 请求验证中间件：校验 z/x/y 为合法非负整数
  router.use('/:z/:x/:y.:format', (req, res, next) => {
    const { z, x, y } = req.params
    const zn = Number(z)
    const xn = Number(x)
    const yn = Number(y)

    if (!Number.isInteger(zn) || !Number.isInteger(xn) || !Number.isInteger(yn) || zn < 0 || xn < 0 || yn < 0) {
      return res.status(400).json({
        success: false,
        error: '瓦片坐标必须为非负整数',
        path: `${z}/${x}/${y}`
      })
    }
    next()
  })

  router.get('/:z/:x/:y.:format', (req, res) => {
    const start = Date.now()
    const { z, x, y } = req.params

    const result = mbtilesManager.getTileAuto(z, x, y)
    const elapsed = Date.now() - start

    if (result.status !== 200) {
      console.log(`[unified-tile] ${z}/${x}/${y} -> ${result.status} ${result.error} (${elapsed}ms)`)
      return res.status(result.status).json({
        success: false,
        error: result.error,
        z: Number(z),
        x: Number(x),
        y: Number(y)
      })
    }

    // 设置响应头：内容类型、缓存策略、数据来源信息
    res.set('Content-Type', result.contentType)
    // 统一接口同一 URL（z/x/y）返回内容会随服务端数据源选择逻辑变化，
    // 禁止长期缓存，避免修复地图混叠后浏览器仍命中旧瓦片（OL 自身有内存缓存兜底性能）
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.set('X-Tile-Source', result.source.mapId)
    res.set('X-Tile-Source-Name', encodeURIComponent(result.source.mapName))
    // 注：服务端已不做 overzoom（超出层级返回 404，由前端客户端放大当前图片），
    //     故不再有 X-Tile-Overzoom 头；underzoom（低于最小层级回退）仍可能存在
    if (result.source.underzoom) {
      res.set('X-Tile-Underzoom', 'true')
      res.set('X-Tile-Source-Z', String(result.source.z))
    }
    if (result.source.globalFallback) {
      res.set('X-Tile-Global-Fallback', 'true')
    }

    console.log(
      `[unified-tile] ${z}/${x}/${y} -> 200 from ${result.source.mapId}` +
        (result.source.underzoom ? ` (underzoom@z${result.source.z})` : '') +
        (result.source.globalFallback ? ` (global-fallback)` : '') +
        ` (${elapsed}ms)`
    )

    res.send(result.data)
  })

  // 兼容无扩展名请求
  router.get('/:z/:x/:y', (req, res) => {
    const start = Date.now()
    const { z, x, y } = req.params
    const result = mbtilesManager.getTileAuto(z, x, y)
    const elapsed = Date.now() - start

    if (result.status !== 200) {
      console.log(`[unified-tile] ${z}/${x}/${y} -> ${result.status} (${elapsed}ms)`)
      return res.status(result.status).json({
        success: false,
        error: result.error
      })
    }

    res.set('Content-Type', result.contentType)
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.set('X-Tile-Source', result.source.mapId)
    if (result.source.underzoom) res.set('X-Tile-Underzoom', 'true')
    if (result.source.globalFallback) res.set('X-Tile-Global-Fallback', 'true')
    res.send(result.data)
  })

  return router
}

module.exports = createUnifiedTilesRouter
