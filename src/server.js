require('dotenv').config()

const express = require('express')
const cors = require('cors')
const path = require('path')

const MBTilesManager = require('./services/mbtilesManager')
const createMapsRouter = require('./routes/maps')
const createTilesRouter = require('./routes/tiles')
const createWmtsRouter = require('./routes/wmts')
const createUnifiedTilesRouter = require('./routes/unifiedTiles')

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const CONFIG_PATH = process.env.MAPS_CONFIG || path.join(__dirname, '../config/maps.json')

const app = express()
const mbtilesManager = new MBTilesManager(CONFIG_PATH)

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
)

app.use(express.json())

// 简易请求日志中间件
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const elapsed = Date.now() - start
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${elapsed}ms)`)
  })
  next()
})

app.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'offline-mbtiles-server',
    maps: mbtilesManager.listMaps().length
  })
})

// 根路径 URL 重写：访问 / 时直接返回 openlayers.html 内容，
// 浏览器地址栏保持 http://localhost:3000/ 不变
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.sendFile(path.join(__dirname, '../examples/openlayers.html'))
})

app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'Offline MBTiles Map Server',
    endpoints: {
      health: '/health',
      maps: '/api/maps',
      unifiedTileTemplate: '/api/maps/tiles/{z}/{x}/{y}.png',
      tileTemplate: '/api/maps/{mapId}/tiles/{z}/{x}/{y}.{format}',
      wmtsCapabilities: '/wmts/{mapId}?service=WMTS&request=GetCapabilities',
      wmtsTile:
        '/wmts/{mapId}?service=WMTS&request=GetTile&layer={mapId}&style=default&tilematrixset=EPSG3857&tilematrix={z}&tilerow={y}&tilecol={x}',
      examples: '/examples/'
    }
  })
})

// 统一瓦片接口（不含 mapId，自动区域判断）必须先于 /api/maps 注册
app.use('/api/maps/tiles', createUnifiedTilesRouter(mbtilesManager))
app.use('/api/maps', createMapsRouter(mbtilesManager))
app.use('/api/maps/:mapId/tiles', createTilesRouter(mbtilesManager))

const getBaseUrl = (req) => {
  const protocol = req.protocol
  const host = req.get('host')
  return `${protocol}://${host}`
}

app.use('/wmts', (req, res, next) => {
  createWmtsRouter(mbtilesManager, getBaseUrl(req))(req, res, next)
})

app.use('/examples', express.static(path.join(__dirname, '../examples')))

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在'
  })
})

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({
    success: false,
    error: '服务器内部错误'
  })
})

const loadResult = mbtilesManager.load()
console.log(`已加载 ${loadResult.loaded} 个 MBTiles 地图`)
if (loadResult.errors.length > 0) {
  console.warn('部分地图加载失败:', loadResult.errors)
}

const server = app.listen(PORT, HOST, () => {
  console.log(`离线地图服务已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  console.log(`地图列表: http://localhost:${PORT}/api/maps`)
})

// 暴露 server 实例与 mbtilesManager，便于测试与外部调用
app._server = server
app._mbtilesManager = mbtilesManager

process.on('SIGINT', () => {
  mbtilesManager.close()
  server.close(() => process.exit(0))
})

process.on('SIGTERM', () => {
  mbtilesManager.close()
  server.close(() => process.exit(0))
})

module.exports = app
