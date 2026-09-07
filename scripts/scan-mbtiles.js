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
 *
 * id 生成规则（避免短哈希）：
 *   - 短哈希定义：哈希部分长度 < 8 位的 id（如 "map-abc123" 中哈希部分仅 6 位）
 *   - 优先使用文件名 slugify 结果（可读性高）
 *   - 中文等非 ASCII 文件名回退到 `map-<md5前12位>`（哈希长度 12，满足 ≥8 要求）
 *   - 所有生成的 id 必须通过 isShortHashId() 校验，否则追加后缀重生成
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SCAN_ROOT = process.env.SCAN_ROOT || 'D:/SGDownload'
const CONFIG_PATH = process.env.MAPS_CONFIG || path.join(__dirname, '../config/maps.json')

// 短哈希判定阈值：哈希部分长度小于此值视为短哈希
const MIN_HASH_LENGTH = 8
// 哈希回退时截取的长度（≥ MIN_HASH_LENGTH）
const HASH_FALLBACK_LENGTH = 12

// 递归收集目录下所有 .mbtiles 文件
function walk(dir, results = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results // 目录不存在或无权限，跳过
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, results)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mbtiles')) {
      results.push(full)
    }
  }
  return results
}

// 统一路径格式为正斜杠绝对路径，便于比对（兼容配置中 D:/... 写法）
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, '/')
}

// 由文件名生成 URL 友好的 ASCII id；非 ASCII（如中文）回退为长哈希
function slugify(stem) {
  const base = stem.replace(/_MBLites$/i, '')
  return base
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/**
 * 判断 id 是否为短哈希格式
 * 短哈希定义：id 形如 "<prefix>-<hash>"，其中 hash 部分长度 < MIN_HASH_LENGTH
 * 例如 "map-67f403" 的 hash 部分 "67f403" 长度为 6 < 8，属于短哈希
 * @param {string} id
 * @returns {boolean}
 */
function isShortHashId(id) {
  if (!id) return true
  // 匹配 "<prefix>-<hex>" 格式，prefix 至少 2 个字母
  const m = id.match(/^([a-zA-Z]{2,})-([0-9a-fA-F]+)$/)
  if (!m) return false
  const hashPart = m[2]
  return hashPart.length < MIN_HASH_LENGTH
}

/**
 * 生成长度达标的稳定哈希 id
 * 使用文件路径的 md5 前 HASH_FALLBACK_LENGTH 位作为哈希部分
 * @param {string} filePath 文件绝对路径（作为哈希输入，保证稳定性）
 * @returns {string} 形如 "map-<12位hex>"
 */
function generateLongHashId(filePath) {
  const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, HASH_FALLBACK_LENGTH)
  return `map-${hash}`
}

/**
 * 为 mbtiles 文件生成符合规则的 id
 * 规则：
 *   1. 优先 slugify(文件名)（可读性最佳）
 *   2. slugify 结果为空（中文文件名等）→ 使用长哈希
 *   3. slugify 结果是短哈希格式（意外命中 hex 模式）→ 使用长哈希覆盖
 *   4. 通过 existingIds 去重，冲突时追加 -2、-3
 * @param {string} stem 文件名（不含扩展名）
 * @param {string} filePath 文件绝对路径
 * @param {Set<string>} existingIds 已存在的 id 集合
 * @returns {string}
 */
function makeId(stem, filePath, existingIds) {
  let id = slugify(stem)
  // slugify 为空 或 slugify 结果是短哈希格式 → 回退到长哈希
  if (!id || isShortHashId(id)) {
    id = generateLongHashId(filePath)
  }
  // 最终安全校验：若仍为短哈希（理论不会发生），强制延长
  if (isShortHashId(id)) {
    id = generateLongHashId(filePath)
  }
  // 去重：同名时追加 -2、-3
  let final = id
  let n = 2
  while (existingIds.has(final)) {
    final = `${id}-${n++}`
  }
  return final
}

function main() {
  const prune = process.argv.includes('--prune')
  const dryRun = process.argv.includes('--dry-run')

  // 读取现有配置
  let config = { maps: [] }
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  }
  if (!Array.isArray(config.maps)) config.maps = []

  const existingByPath = new Map()
  const existingIds = new Set()
  for (const m of config.maps) {
    existingByPath.set(normalizePath(m.path), m)
    if (m.id) existingIds.add(m.id)
  }

  // 检测并修复已存在的短哈希 id（仅修复，不改变其他字段）
  let fixedCount = 0
  for (const m of config.maps) {
    if (isShortHashId(m.id)) {
      const oldId = m.id
      // 先从 existingIds 移除旧 id，避免 makeId 去重时误判
      existingIds.delete(oldId)
      const newId = generateLongHashId(normalizePath(m.path))
      // 去重处理
      let final = newId
      let n = 2
      while (existingIds.has(final)) {
        final = `${newId}-${n++}`
      }
      m.id = final
      existingIds.add(final)
      console.log(`  ⚠ 修复短哈希 id: "${oldId}" -> "${final}"  (${m.name})`)
      fixedCount++
    }
  }

  // 扫描
  const found = walk(SCAN_ROOT).map(normalizePath)
  const foundSet = new Set(found)

  // 检测新增
  const newMaps = []
  for (const fp of found) {
    if (existingByPath.has(fp)) continue
    const stem = path.basename(fp, '.mbtiles')
    const id = makeId(stem, fp, existingIds)
    existingIds.add(id)
    newMaps.push({
      id,
      name: stem.replace(/_MBLites$/i, ''),
      path: fp,
      description: '水经注下载 - 离线地图（自动扫描）'
    })
  }

  // 检测缺失（文件已不存在）
  const missing = []
  if (prune) {
    config.maps = config.maps.filter((m) => {
      const ok = foundSet.has(normalizePath(m.path))
      if (!ok) missing.push(m)
      return ok
    })
  } else {
    for (const m of config.maps) {
      if (!foundSet.has(normalizePath(m.path))) missing.push(m)
    }
  }

  // 合并新增
  config.maps = config.maps.concat(newMaps)

  // 输出报告
  console.log(`扫描根目录 : ${SCAN_ROOT}`)
  console.log(`发现 .mbtiles 文件 : ${found.length}`)
  console.log(`配置已有 : ${existingByPath.size}`)
  if (fixedCount > 0) {
    console.log(`修复短哈希 id : ${fixedCount}`)
  }
  console.log(`新增 : ${newMaps.length}`)
  newMaps.forEach((m) => console.log(`  + [${m.id}] ${m.name}\n      -> ${m.path}`))
  console.log(`缺失(文件不存在) : ${missing.length}`)
  missing.forEach((m) => console.log(`  - [${m.id}] ${m.path}` + (prune ? '  (已移除)' : '  (使用 --prune 移除)')))

  if (dryRun) {
    console.log('\n--dry-run 模式，未写入文件')
    return
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  console.log(`\n已更新配置 : ${CONFIG_PATH}`)
}

main()
