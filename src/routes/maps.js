const express = require('express');

function createMapsRouter(mbtilesManager) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      success: true,
      count: mbtilesManager.listMaps().length,
      data: mbtilesManager.listMaps()
    });
  });

  router.get('/:mapId', (req, res) => {
    const map = mbtilesManager.getMap(req.params.mapId);
    if (!map) {
      return res.status(404).json({
        success: false,
        error: `地图 "${req.params.mapId}" 不存在`
      });
    }

    res.json({
      success: true,
      data: map
    });
  });

  return router;
}

module.exports = createMapsRouter;
