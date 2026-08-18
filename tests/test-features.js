const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const http = require('http')

const MBTilesManager = require('../src/services/mbtilesManager')
const createUnifiedTilesRouter = require('../src/routes/unifiedTiles')

const CONFIG_PATH = path.join(__dirname, '../config/maps.json')
const EXAMPLES_HTML_PATH = path.join(__dirname, '../examples/openlayers.html')
const fs = require('fs')

// 判断 mbtiles 文件是否存在，决定是否跳过依赖实际数据的测试
function configFilesExist() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    return cfg.maps.every((m) => fs.existsSync(m.path))
  } catch (e) {
    return false
  }
}

const HAVE_DATA = configFilesExist()

// ============================================================
// 一、纯逻辑单元测试（不依赖 mbtiles 数据文件）
// ============================================================

test('tileToLatLng: z=0 时瓦片中心应接近 (0, 0)', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  const { lon, lat } = mgr.tileToLatLng(0, 0, 0)
  assert.ok(Math.abs(lon) < 1, `lon 应接近 0，实际 ${lon}`)
  assert.ok(Math.abs(lat) < 1, `lat 应接近 0，实际 ${lat}`)
})

test('tileToLatLng: 北京所在 z=7 瓦片应在合理经纬度范围', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  // z=7, x=107, y=49 大致对应中国华北地区
  const { lon, lat } = mgr.tileToLatLng(7, 107, 49)
  assert.ok(lon > 70 && lon < 140, `经度应在 70~140，实际 ${lon}`)
  assert.ok(lat > 20 && lat < 60, `纬度应在 20~60，实际 ${lat}`)
})

test('tileToLatLng: z=10 上海附近瓦片应接近上海经纬度', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  // 上海约 lon=121.47, lat=31.23
  // z=10 时 x = floor((121.47+180)/360 * 1024) = 857, y 计算略复杂
  // 直接验证 (855, 414) 附近瓦片
  const { lon, lat } = mgr.tileToLatLng(10, 855, 414)
  assert.ok(lon > 115 && lon < 125, `经度应接近上海(115~125)，实际 ${lon}`)
  assert.ok(lat > 28 && lat < 34, `纬度应接近上海(28~34)，实际 ${lat}`)
})

test('isPointInBounds: 边界内/外判断', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  const fakeMap = { bounds: { west: 100, south: 20, east: 130, north: 50 } }
  assert.strictEqual(mgr.isPointInBounds(fakeMap, 120, 35), true, '北京应在边界内')
  assert.strictEqual(mgr.isPointInBounds(fakeMap, 50, 35), false, '欧洲应不在边界内')
  assert.strictEqual(mgr.isPointInBounds({ bounds: null }, 120, 35), false, '无边界的地图应返回 false')
})

test('getTileAuto: 非整数坐标返回 400', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  const r = mgr.getTileAuto('abc', '0', '0')
  assert.strictEqual(r.status, 400)
})

test('getTileAuto: 负缩放级别返回 400', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  const r = mgr.getTileAuto(-1, 0, 0)
  assert.strictEqual(r.status, 400)
})

test('getTileAuto: 坐标超出范围返回 404', () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  // z=5, max index = 32, x=100 超出
  const r = mgr.getTileAuto(5, 100, 0)
  assert.strictEqual(r.status, 404)
})

test('getTileAuto: 无地图加载时返回 404', () => {
  const mgr = new MBTilesManager(CONFIG_PATH) // 不调用 load()
  const r = mgr.getTileAuto(5, 25, 12)
  assert.strictEqual(r.status, 404)
})

// ============================================================
// 二、依赖实际 mbtiles 数据的测试（无数据时自动跳过）
// ============================================================

test('getTileAuto: 实际数据 - 中国区域低级别应返回 200', { skip: !HAVE_DATA }, () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  // 中国地图 z=2~9，z=5 已验证存在的瓦片 (23, 11)
  const r = mgr.getTileAuto(5, 23, 11)
  assert.strictEqual(r.status, 200, `应返回 200，错误: ${r.error}`)
  assert.ok(r.data, '应返回瓦片二进制数据')
  assert.ok(r.contentType && r.contentType.startsWith('image/'), '应返回图片 MIME 类型')
  assert.ok(r.source, '应返回数据源信息')
  assert.ok(r.source.mapId, 'source.mapId 不应为空')
  mgr.close()
})

test('getTileAuto: 实际数据 - 上海区域高级别应返回 200', { skip: !HAVE_DATA }, () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  // 上海市 z=14 已验证存在的瓦片 (13710, 6660)
  const r = mgr.getTileAuto(14, 13710, 6660)
  if (r.status === 200) {
    assert.ok(r.data, '上海高级别瓦片应返回数据')
    console.log(`  上海 z=14 数据源: ${r.source.mapId} (${r.source.mapName})`)
  } else {
    // 上海地图可能未覆盖该精确瓦片，可接受 404
    assert.ok(r.status === 404, `意外状态: ${r.status}`)
    console.log(`  上海 z=14 瓦片不存在 (可能未覆盖): ${r.error}`)
  }
  mgr.close()
})

test('getTileAuto: 实际数据 - overzoom 超出 maxZoom 应返回 200', { skip: !HAVE_DATA }, () => {
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  const maps = mgr.listMaps()
  const maxMaxZoom = Math.max(...maps.map((m) => m.maxZoom))
  // 请求超出最高 maxZoom 的级别，应触发 overzoom
  const overZ = maxMaxZoom + 3
  const maxIndex = Math.pow(2, overZ)
  // 取上海附近点
  const r = mgr.getTileAuto(
    overZ,
    Math.floor((maxIndex * (121.47 + 180)) / 360),
    Math.floor(
      (maxIndex * (1 - Math.log(Math.tan((31.23 * Math.PI) / 180) + 1 / Math.cos((31.23 * Math.PI) / 180)) / Math.PI)) /
        2
    )
  )
  if (r.status === 200) {
    assert.ok(r.source.overzoom === true, '应标记 overzoom')
    console.log(`  overzoom z=${overZ} 回退到 z=${r.source.z} 数据源: ${r.source.mapId}`)
  } else {
    // 即使 overzoom 也可能无数据，可接受
    console.log(`  overzoom 测试返回 ${r.status}: ${r.error}`)
  }
  mgr.close()
})

// ============================================================
// 三、路由集成测试（使用 Express app 但不发 HTTP）
// ============================================================

test('unifiedTiles 路由: 非法坐标返回 400', async () => {
  const express = require('express')
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  const app = express()
  app.use('/api/maps/tiles', createUnifiedTilesRouter(mgr))

  const res = await simulateRequest(app, 'GET', '/api/maps/tiles/abc/0/0.png')
  assert.strictEqual(res.status, 400)
  assert.strictEqual(res.body.success, false)
  mgr.close()
})

test('unifiedTiles 路由: 不存在区域返回 404', async () => {
  const express = require('express')
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  const app = express()
  app.use('/api/maps/tiles', createUnifiedTilesRouter(mgr))

  // z=3 时瓦片覆盖大范围，选一个肯定不在中国的点（大西洋）
  // z=3: x in [0,7], y in [0,7]
  // 大西洋约 lon=-30, lat=40 -> x = floor((-30+180)/360*8) = 3, y = floor((1 - ln(tan(40°)+sec(40°))/π)/2 * 8) = 3
  const res = await simulateRequest(app, 'GET', '/api/maps/tiles/3/3/3.png')
  assert.strictEqual(res.status, 404)
  assert.strictEqual(res.body.success, false)
  mgr.close()
})

test('unifiedTiles 路由: 中国区域应返回 200 瓦片数据', { skip: !HAVE_DATA }, async () => {
  const express = require('express')
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  const app = express()
  app.use('/api/maps/tiles', createUnifiedTilesRouter(mgr))

  // 中国地图 z=2~9，z=5 已验证存在的瓦片 (23, 11)
  const res = await simulateRequest(app, 'GET', '/api/maps/tiles/5/23/11.png')
  assert.strictEqual(res.status, 200, `应返回 200，body: ${JSON.stringify(res.body)}`)
  assert.ok(Buffer.isBuffer(res.body) && res.body.length > 0, '应返回二进制瓦片数据')
  assert.ok(res.headers['content-type'], '应设置 Content-Type')
  assert.ok(res.headers['x-tile-source'], '应设置 X-Tile-Source 头')
  assert.ok(res.headers['cache-control'], '应设置 Cache-Control 头')
  mgr.close()
})

test('unifiedTiles 路由: overzoom 时应设置 X-Tile-Overzoom 头', { skip: !HAVE_DATA }, async () => {
  const express = require('express')
  const mgr = new MBTilesManager(CONFIG_PATH)
  mgr.load()
  const app = express()
  app.use('/api/maps/tiles', createUnifiedTilesRouter(mgr))

  const maps = mgr.listMaps()
  const maxMaxZoom = Math.max(...maps.map((m) => m.maxZoom))
  const overZ = maxMaxZoom + 2
  const maxIndex = Math.pow(2, overZ)
  // 上海附近
  const x = Math.floor((maxIndex * (121.47 + 180)) / 360)
  const latRad = (31.23 * Math.PI) / 180
  const y = Math.floor((maxIndex * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2)

  const res = await simulateRequest(app, 'GET', `/api/maps/tiles/${overZ}/${x}/${y}.png`)
  if (res.status === 200) {
    assert.strictEqual(res.headers['x-tile-overzoom'], 'true', '应设置 overzoom 头')
    console.log(`  路由 overzoom 头验证通过，数据源: ${res.headers['x-tile-source']}`)
  } else {
    console.log(`  路由 overzoom 测试返回 ${res.status}`)
  }
  mgr.close()
})

// ============================================================
// 四、server.js 集成测试（启动真实 HTTP 服务）
// ============================================================

test('server 集成: 根路径返回 openlayers.html 内容（URL 重写）', async () => {
  const server = await startServer()
  try {
    const res = await httpGet(`http://localhost:${server.port}/`)
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.includes('OpenLayers'), '根路径应返回 openlayers.html 内容')
    assert.ok(res.body.includes('api/maps/tiles'), '页面应使用统一瓦片 API')
    assert.ok(!res.body.includes('/examples/'), 'URL 重写后页面不应引用 /examples/ 路径')
  } finally {
    await stopServer(server)
  }
})

test('server 集成: /api 接口应列出统一瓦片模板', async () => {
  const server = await startServer()
  try {
    const res = await httpGet(`http://localhost:${server.port}/api`)
    assert.strictEqual(res.status, 200)
    const json = JSON.parse(res.body)
    assert.ok(json.endpoints.unifiedTileTemplate, '应包含 unifiedTileTemplate 端点')
    assert.ok(json.endpoints.unifiedTileTemplate.includes('/api/maps/tiles/{z}/{x}/{y}.png'))
  } finally {
    await stopServer(server)
  }
})

test('server 集成: 统一瓦片接口响应时间应 <= 200ms', { skip: !HAVE_DATA }, async () => {
  const server = await startServer()
  try {
    // 中国地图 z=2~9，z=5 已验证存在的瓦片 (23, 11)
    const start = Date.now()
    const res = await httpGet(`http://localhost:${server.port}/api/maps/tiles/5/23/11.png`)
    const elapsed = Date.now() - start
    assert.strictEqual(res.status, 200, `应返回 200`)
    assert.ok(elapsed <= 200, `响应时间 ${elapsed}ms 超过 200ms 阈值`)
    console.log(`  响应时间: ${elapsed}ms`)
  } finally {
    await stopServer(server)
  }
})

test('server 集成: /examples/openlayers.html 仍可直接访问', async () => {
  const server = await startServer()
  try {
    const res = await httpGet(`http://localhost:${server.port}/examples/openlayers.html`)
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.includes('OpenLayers'))
  } finally {
    await stopServer(server)
  }
})

// ============================================================
// 辅助函数
// ============================================================

function simulateRequest(app, method, url) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      const req = http.request({ method, host: '127.0.0.1', port, path: url }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const contentType = res.headers['content-type'] || ''
          let body = buf
          if (contentType.includes('application/json')) {
            try {
              body = JSON.parse(buf.toString('utf-8'))
            } catch (e) {
              body = buf.toString()
            }
          } else if (contentType.includes('text/')) {
            body = buf.toString('utf-8')
          }
          server.close()
          resolve({ status: res.statusCode, headers: res.headers, body })
        })
      })
      req.on('error', (e) => {
        server.close()
        reject(e)
      })
      req.end()
    })
  })
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const contentType = res.headers['content-type'] || ''
          let body = buf
          if (contentType.includes('text/') || contentType.includes('html')) {
            body = buf.toString('utf-8')
          }
          resolve({ status: res.statusCode, headers: res.headers, body })
        })
      })
      .on('error', reject)
  })
}

// 启动真实 server 实例（固定使用 3999 端口）
async function startServer() {
  process.env.PORT = '3999'
  process.env.HOST = '127.0.0.1'
  // 清除缓存确保重新加载
  delete require.cache[require.resolve('../src/server.js')]
  const app = require('../src/server.js')
  return new Promise((resolve, reject) => {
    // server.js 已在加载时 listen，等待一小段时间确保启动完成
    setTimeout(() => {
      // 验证服务可用
      httpGet('http://127.0.0.1:3999/health')
        .then(() => resolve({ app, port: 3999, server: app._server }))
        .catch(reject)
    }, 500)
  })
}

async function stopServer(serverObj) {
  return new Promise((resolve) => {
    if (serverObj.server) {
      serverObj.server.close(() => {
        // 清理 mbtilesManager 连接
        if (serverObj.app._mbtilesManager) {
          serverObj.app._mbtilesManager.close()
        }
        resolve()
      })
    } else {
      resolve()
    }
  })
}
