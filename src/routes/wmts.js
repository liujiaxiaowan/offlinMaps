const express = require('express');

function createWmtsRouter(mbtilesManager, baseUrl) {
  const router = express.Router();

  router.get('/:mapId', (req, res) => {
    const { mapId } = req.params;
    const map = mbtilesManager.getMap(mapId);

    if (!map) {
      res.status(404).type('text/xml').send(buildExceptionReport('InvalidParameterValue', `Layer ${mapId} not found`));
      return;
    }

    const service = req.query.service || req.query.SERVICE;
    const requestType = req.query.request || req.query.REQUEST;

    if (service && service.toUpperCase() !== 'WMTS') {
      res.status(400).type('text/xml').send(buildExceptionReport('InvalidParameterValue', 'Unsupported service'));
      return;
    }

    if (!requestType || requestType.toUpperCase() === 'GETCAPABILITIES') {
      res.type('text/xml').send(buildCapabilitiesXml(map, baseUrl));
      return;
    }

    if (requestType.toUpperCase() === 'GETTILE') {
      const layer = req.query.layer || req.query.LAYER;
      const tileMatrix = req.query.tilematrix || req.query.TILEMATRIX;
      const tileRow = req.query.tilerow || req.query.TILEROW;
      const tileCol = req.query.tilecol || req.query.TILECOL;

      if (layer !== mapId) {
        res.status(400).type('text/xml').send(buildExceptionReport('InvalidParameterValue', 'Invalid layer'));
        return;
      }

      const result = mbtilesManager.getTile(mapId, tileMatrix, tileCol, tileRow);
      if (result.status !== 200) {
        res.status(result.status).type('text/xml').send(buildExceptionReport('NoSuchTile', result.error));
        return;
      }

      res.set('Content-Type', result.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(result.data);
      return;
    }

    res.status(400).type('text/xml').send(buildExceptionReport('InvalidParameterValue', 'Unsupported request'));
  });

  return router;
}

function buildCapabilitiesXml(map, baseUrl) {
  const tileMatrixSet = buildTileMatrixSet(map);
  const format = map.format === 'png' ? 'image/png' : `image/${map.format}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0"
  xmlns:ows="http://www.opengis.net/ows/1.1"
  version="1.0.0">
  <ows:ServiceIdentification>
    <ows:Title>Offline MBTiles WMTS - ${escapeXml(map.name)}</ows:Title>
    <ows:ServiceType>OGC WMTS</ows:ServiceType>
    <ows:ServiceTypeVersion>1.0.0</ows:ServiceTypeVersion>
  </ows:ServiceIdentification>
  <Contents>
    <Layer>
      <ows:Title>${escapeXml(map.name)}</ows:Title>
      <ows:Identifier>${escapeXml(map.id)}</ows:Identifier>
      <ows:Abstract>${escapeXml(map.description || map.name)}</ows:Abstract>
      <ows:WGS84BoundingBox>
        <ows:LowerCorner>${map.bounds?.west ?? -180} ${map.bounds?.south ?? -85.0511}</ows:LowerCorner>
        <ows:UpperCorner>${map.bounds?.east ?? 180} ${map.bounds?.north ?? 85.0511}</ows:UpperCorner>
      </ows:WGS84BoundingBox>
      <Style isDefault="true">
        <ows:Identifier>default</ows:Identifier>
      </Style>
      <Format>${format}</Format>
      <TileMatrixSetLink>
        <TileMatrixSet>EPSG3857</TileMatrixSet>
      </TileMatrixSetLink>
      <ResourceURL format="${format}" resourceType="tile"
        template="${baseUrl}/wmts/${map.id}?service=WMTS&amp;request=GetTile&amp;version=1.0.0&amp;layer=${map.id}&amp;style=default&amp;tilematrixset=EPSG3857&amp;tilematrix={TileMatrix}&amp;tilerow={TileRow}&amp;tilecol={TileCol}"/>
    </Layer>
    ${tileMatrixSet}
  </Contents>
</Capabilities>`;
}

function buildTileMatrixSet(map) {
  const matrices = [];
  for (let z = map.minZoom; z <= map.maxZoom; z += 1) {
    const scaleDenominator = Math.round(559082264.0287178 / Math.pow(2, z));
    matrices.push(`
    <TileMatrix>
      <ows:Identifier>${z}</ows:Identifier>
      <ScaleDenominator>${scaleDenominator}</ScaleDenominator>
      <TopLeftCorner>-20037508.342789 20037508.342789</TopLeftCorner>
      <TileWidth>256</TileWidth>
      <TileHeight>256</TileHeight>
      <MatrixWidth>${Math.pow(2, z)}</MatrixWidth>
      <MatrixHeight>${Math.pow(2, z)}</MatrixHeight>
    </TileMatrix>`);
  }

  return `
    <TileMatrixSet>
      <ows:Identifier>EPSG3857</ows:Identifier>
      <ows:SupportedCRS>EPSG:3857</ows:SupportedCRS>
      ${matrices.join('')}
    </TileMatrixSet>`;
}

function buildExceptionReport(code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ExceptionReport version="1.1.0" xmlns="http://www.opengis.net/ows/1.1">
  <Exception exceptionCode="${escapeXml(code)}">
    <ExceptionText>${escapeXml(message)}</ExceptionText>
  </Exception>
</ExceptionReport>`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = createWmtsRouter;
