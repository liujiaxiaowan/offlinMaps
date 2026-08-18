# 离线 MBTiles 地图发布服务

基于 Node.js 的统一 MBTiles 瓦片发布引擎，支持在同一服务地址下发布多个离线地图，并提供 RESTful API 与 WMTS 协议接口。

## 快速启动

```bash
npm install
npm start
```

服务默认地址：`http://localhost:3000`

## API 接口

| 接口 | 说明 |
|------|------|
| `GET /api/maps` | 获取已发布地图列表及元数据 |
| `GET /api/maps/:mapId` | 获取单个地图元数据 |
| `GET /api/maps/:mapId/tiles/:z/:x/:y.png` | 获取瓦片（XYZ 坐标系） |
| `GET /wmts/:mapId?service=WMTS&request=GetCapabilities` | WMTS 能力文档 |
| `GET /wmts/:mapId?service=WMTS&request=GetTile&...` | WMTS 瓦片请求 |

## 前端示例

- Leaflet: http://localhost:3000/examples/leaflet.html
- OpenLayers: http://localhost:3000/examples/openlayers.html

## 添加新地图

编辑 `config/maps.json`，增加一项配置后重启服务即可：

```json
{
  "id": "my-map",
  "name": "我的地图",
  "path": "D:/path/to/file.mbtiles",
  "description": "描述信息"
}
```
