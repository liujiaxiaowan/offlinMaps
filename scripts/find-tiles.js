const Database = require('better-sqlite3');

const db = new Database(
  'D:/SGDownload/澳门特别行政区/澳门特别行政区_MBLites/澳门特别行政区.mbtiles',
  { readonly: true }
);

const rows = db.prepare(
  'SELECT zoom_level, tile_column, tile_row FROM tiles WHERE zoom_level = 12 LIMIT 5'
).all();

for (const row of rows) {
  const y = Math.pow(2, row.zoom_level) - 1 - row.tile_row;
  console.log(`z=${row.zoom_level} x=${row.tile_column} y=${y}`);
}

db.close();
