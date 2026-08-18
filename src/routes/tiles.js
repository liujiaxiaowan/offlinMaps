const express = require('express');

function createTilesRouter(mbtilesManager) {
  const router = express.Router({ mergeParams: true });

  router.get('/:z/:x/:y.:format', (req, res) => {
    const { mapId, z, x, y } = req.params;
    const result = mbtilesManager.getTile(mapId, z, x, y);

    if (result.status !== 200) {
      return res.status(result.status).json({
        success: false,
        error: result.error
      });
    }

    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(result.data);
  });

  router.get('/:z/:x/:y', (req, res) => {
    const { mapId, z, x, y } = req.params;
    const result = mbtilesManager.getTile(mapId, z, x, y);

    if (result.status !== 200) {
      return res.status(result.status).json({
        success: false,
        error: result.error
      });
    }

    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(result.data);
  });

  return router;
}

module.exports = createTilesRouter;
