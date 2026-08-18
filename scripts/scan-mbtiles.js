/**
 * 自动扫描 MBTiles 文件并更新 config/maps.json 配置表
 *
 * 用法：
 *   node scripts/scan-mbtiles.js              # 扫描并写入新增项
 *   node scripts/scan-mbtiles.js --dry-run    # 仅预览，不写入
 *   node scripts/scan-mbtiles.js --prune      # 同时移除文件已不存在的配置项
 *
 * 可通过环境变量覆盖默认路径：
 *   SCAN_ROOT=D:/SGDownload  MAPS_CONFIG=./config/maps.json node scripts/scan-mbtiles.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCAN_ROOT = process.env.SCAN_ROOT || 'D:/SGDownload';
const CONFIG_PATH = process.env.MAPS_CONFIG || path.join(__dirname, '../config/maps.json');

// 递归收集目录下所有 .mbtiles 文件
function walk(dir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results; // 目录不存在或无权限，跳过
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mbtiles')) {
      results.push(full); 
    }
  }
  return results;
}

// 统一路径格式为正斜杠绝对路径，便于比对（兼容配置中 D:/... 写法）
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

// 由文件名生成 URL 友好的 ASCII id；非 ASCII（如中文）回退为短哈希
function slugify(stem) {
  const base = stem.replace(/_MBLites$/i, '');
  return base
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function makeId(stem, filePath, existingIds) {
  let id = slugify(stem);
  if (!id) {
    id = 'map-' + crypto.createHash('md5').update(filePath).digest('hex').slice(0, 6);
  }
  // 去重：同名时追加 -2、-3
  let final = id;
  let n = 2;
  while (existingIds.has(final)) {
    final = `${id}-${n++}`;
  }
  return final;
}

function main() {
  const prune = process.argv.includes('--prune');
  const dryRun = process.argv.includes('--dry-run');

  // 读取现有配置
  let config = { maps: [] };
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  if (!Array.isArray(config.maps)) config.maps = [];

  const existingByPath = new Map();
  const existingIds = new Set();
  for (const m of config.maps) {
    existingByPath.set(normalizePath(m.path), m);
    if (m.id) existingIds.add(m.id);
  }

  // 扫描
  const found = walk(SCAN_ROOT).map(normalizePath);
  const foundSet = new Set(found);

  // 检测新增
  const newMaps = [];
  for (const fp of found) {
    if (existingByPath.has(fp)) continue;
    const stem = path.basename(fp, '.mbtiles');
    const id = makeId(stem, fp, existingIds);
    existingIds.add(id);
    newMaps.push({
      id,
      name: stem.replace(/_MBLites$/i, ''),
      path: fp,
      description: '水经注下载 - 离线地图（自动扫描）'
    });
  }

  // 检测缺失（文件已不存在）
  const missing = [];
  if (prune) {
    config.maps = config.maps.filter((m) => {
      const ok = foundSet.has(normalizePath(m.path));
      if (!ok) missing.push(m);
      return ok;
    });
  } else {
    for (const m of config.maps) {
      if (!foundSet.has(normalizePath(m.path))) missing.push(m);
    }
  }

  // 合并新增
  config.maps = config.maps.concat(newMaps);

  // 输出报告
  console.log(`扫描根目录 : ${SCAN_ROOT}`);
  console.log(`发现 .mbtiles 文件 : ${found.length}`);
  console.log(`配置已有 : ${existingByPath.size}`);
  console.log(`新增 : ${newMaps.length}`);
  newMaps.forEach((m) => console.log(`  + [${m.id}] ${m.name}\n      -> ${m.path}`));
  console.log(`缺失(文件不存在) : ${missing.length}`);
  missing.forEach((m) =>
    console.log(`  - [${m.id}] ${m.path}` + (prune ? '  (已移除)' : '  (使用 --prune 移除)'))
  );

  if (dryRun) {
    console.log('\n--dry-run 模式，未写入文件');
    return;
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`\n已更新配置 : ${CONFIG_PATH}`);
  if (newMaps.length > 0) {
    console.log('提示：自动生成的 id 为短哈希，如需更友好的标识可手动修改 config/maps.json');
  }
}

main();
