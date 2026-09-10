import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import COS from 'cos-nodejs-sdk-v5';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionDays = Number(process.env.SESSION_DAYS || 7);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poolConfig = {
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'tappyread',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};
const caPath = process.env.MYSQL_SSL_CA || '/etc/ssl/cert.pem';
if (process.env.MYSQL_SSL_CA && fs.existsSync(caPath)) {
  poolConfig.ssl = { ca: fs.readFileSync(caPath) };
} else {
  poolConfig.ssl = { rejectUnauthorized: false };
}
const pool = mysql.createPool(poolConfig);

/* =====================================================================
   腾讯云 COS 配置：绘本图片统一存储桶
   存储桶：tappyreadjpeg-1325106148（ap-guangzhou）
   图片目录：jpeg/
   每个用户上传的对象键带 u{userId}_ 前缀，删除时校验前缀防止越权删除他人图片
   ===================================================================== */
const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/`;

const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured
  ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })
  : null;

function sendCosConfigError(res) {
  return res.status(503).json({
    error: 'COS 未配置：请在 .env 中填写 COS_SECRET_ID 与 COS_SECRET_KEY（腾讯云控制台 → 访问管理 → API 密钥管理），然后重启服务'
  });
}

/** 清洗文件名，保留安全字符 */
function sanitizeFileName(name) {
  const base = String(name || 'image').split(/[\\/]/).pop();
  return base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'image';
}

/** 🆕 绘本名称 → COS 文件夹名清洗：不能用 split('/').pop()（那是给文件名用的，
 *  遇到标题本身带斜杠会被截断丢字），而是把 / \ 等非法字符统一替换成下划线，
 *  保留标题整体作为一个文件夹名。 */
function sanitizeStoryFolderName(name) {
  const raw = String(name || '').trim();
  const safe = raw.replace(/[\\/]/g, '_').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
  return safe || 'untitled';
}

/** 🆕 判断 key 是否属于当前用户在 dir 目录下的对象。
 *  兼容两种结构：
 *    旧的扁平结构：  {dir}/u{userId}_...
 *    新的分文件夹结构：{dir}/{绘本名称}/u{userId}_...（只允许恰好一层文件夹）
 */
function keyMatchesUserPrefix(key, dir, userId) {
  const userToken = `u${userId}_`;
  if (key.startsWith(`${dir}/${userToken}`)) return true;
  const dirPrefix = `${dir}/`;
  if (!key.startsWith(dirPrefix)) return false;
  const rest = key.slice(dirPrefix.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return false;
  const afterFolder = rest.slice(slashIdx + 1);
  return afterFolder.startsWith(userToken);
}

function sanitizeUsername(name) {
  return String(name || '').trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'guest';
}

function getLibrarySnapshotFilename(username) {
  return getCanonicalLibraryFilename(username);
}

function getCanonicalLibraryFilename(username) {
  const safeUsername = sanitizeUsername(username).replace(/_+$/g, '');
  return `${safeUsername || 'guest'}.json`;
}

function getLibraryKeyCandidates(username) {
  const raw = String(username || '').trim();
  const variants = new Set();

  if (raw) {
    variants.add(raw);
    variants.add(raw.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/_+/g, '_'));
  }

  const safeUsername = sanitizeUsername(username).replace(/_+$/g, '');
  if (safeUsername) {
    variants.add(safeUsername);
  }

  const directNames = Array.from(variants)
    .filter(Boolean)
    .map(item => `${sanitizeUsername(item).replace(/_+$/g, '') || 'guest'}.json`);

  const legacyNames = [];
  for (const variant of variants) {
    const base = sanitizeUsername(variant).replace(/_+$/g, '') || 'guest';
    legacyNames.push(`${base}_绘本目录.json`);
    legacyNames.push(`${base}_绘本目录_${new Date(0).toISOString()}.json`);
  }

  return Array.from(new Set([
    ...directNames,
    ...legacyNames,
    ...directNames.map(name => `${COS_JSON_DIR}/${name}`),
    ...legacyNames.map(name => `${COS_JSON_DIR}/${name}`)
  ].filter(Boolean).map(name => `${COS_JSON_DIR}/${name}`.replace(/\/+/g, '/'))));
}

function getLegacyLibraryKeysForUsername(username, keys = []) {
  const baseNames = new Set();
  const raw = String(username || '').trim();
  const sanitized = sanitizeUsername(username).replace(/_+$/g, '') || 'guest';
  baseNames.add(sanitized);
  if (raw) {
    baseNames.add(raw.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/_+/g, '_').replace(/_+$/g, '') || 'guest');
  }

  return (Array.isArray(keys) ? keys : []).filter(key => {
    const fileName = (key.split('/').pop() || '').replace(/\.json$/i, '');
    return Array.from(baseNames).some(base => {
      const normalized = (base || 'guest').replace(/_+$/g, '');
      return fileName === normalized || fileName.startsWith(`${normalized}_绘本目录`);
    });
  });
}

function listCosKeys(prefix) {
  return new Promise((resolve, reject) => {
    cosClient.getBucket({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Prefix: prefix,
      MaxKeys: 1000
    }, (err, data) => {
      if (err) {
        if (err.code === 'NoSuchBucket' || err.code === 'NoSuchKey' || err.statusCode === 404) return resolve([]);
        return reject(err);
      }
      const contents = Array.isArray(data?.Contents) ? data.Contents : [];
      resolve(contents.map(item => item.Key).filter(Boolean));
    });
  });
}

async function readCosJsonFile(key) {
  if (!key || !cosClient) return null;
  return new Promise((resolve) => {
    cosClient.getObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key
    }, (err, data) => {
      if (err) {
        if (err.code === 'NoSuchKey' || err.statusCode === 404) return resolve(null);
        console.warn('读取 COS 绘本目录异常:', err);
        return resolve(null);
      }
      try {
        const body = data && data.Body ? Buffer.from(data.Body) : Buffer.alloc(0);
        const text = body.toString('utf8');
        return resolve(text ? JSON.parse(text) : null);
      } catch (error) {
        console.warn('解析 COS 绘本目录失败:', error);
        return resolve(null);
      }
    });
  });
}

async function getLatestLibraryFromCos(username) {
  if (!cosConfigured || !username) return null;
  const safeUsername = sanitizeUsername(username).replace(/_+$/g, '') || 'guest';
  const directKey = `${COS_JSON_DIR}/${safeUsername}.json`;

  // 快速路径：直接读取标准位置的文件，找不到（404）才退回到列出整个 json/
  // 目录去匹配旧文件名，避免每次都做"先 list 再 get"两次串行请求
  const direct = await readCosJsonFile(directKey);
  if (direct) return direct;

  try {
    const keys = await listCosKeys(`${COS_JSON_DIR}/`);
    const legacyMatches = keys.filter(key => {
      const fileName = key.split('/').pop() || '';
      const baseName = fileName.replace(/\.json$/i, '');
      return baseName === safeUsername || baseName.startsWith(`${safeUsername}_绘本目录`);
    });
    const preferred = legacyMatches[0] || null;
    if (!preferred) return null;
    return await readCosJsonFile(preferred);
  } catch (error) {
    console.warn('获取最新用户绘本目录失败:', error);
    return null;
  }
}

async function syncLibraryToCos(username, snapshot) {
  if (!cosConfigured || !username) return null;
  try {
    const safeUsername = sanitizeUsername(username).replace(/_+$/g, '') || 'guest';
    const canonicalKey = `${COS_JSON_DIR}/${safeUsername}.json`;
    const payload = {
      username,
      updatedAt: new Date().toISOString(),
      tree: Array.isArray(snapshot?.tree) ? snapshot.tree : [],
      collapsed: Array.isArray(snapshot?.collapsed) ? snapshot.collapsed : [],
      selectedFolderId: snapshot?.selectedFolderId || null,
      currentStoryId: snapshot?.currentStoryId || null
    };

    await putCosTextObject(canonicalKey, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8');

    const allKeys = await listCosKeys(`${COS_JSON_DIR}/`);
    const staleKeys = getLegacyLibraryKeysForUsername(username, allKeys).filter(key => key !== canonicalKey);
    if (staleKeys.length) {
      await deleteCosObjects(staleKeys.slice(0, 50));
    }

    return { key: canonicalKey, url: COS_BASE_URL + canonicalKey };
  } catch (error) {
    console.warn('同步用户绘本目录到 COS 失败:', error);
    return null;
  }
}

/** 上传单张图片到 COS，对象键：jpeg/u{userId}_{时间戳}_{文件名} */
function putCosObject(key, buffer) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: buffer
    }, (err, data) => err ? reject(err) : resolve(data));
  });
}

/** 上传 HTML 原文件到 COS，对象键：html/u{userId}_{时间戳}_{文件名} */
function putCosTextObject(key, text, contentType = 'text/html; charset=utf-8') {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: Buffer.from(text, 'utf8'),
      ContentType: contentType
    }, (err, data) => err ? reject(err) : resolve(data));
  });
}

/** 删除 COS 对象（可批量）。腾讯云 deleteMultipleObject 单次最多支持 1000 个
 *  对象，这里按 900 一批切分请求，避免绘本页数很多时一次删不干净。 */
async function deleteCosObjects(keys) {
  const chunkSize = 900;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    await new Promise((resolve, reject) => {
      cosClient.deleteMultipleObject({
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Objects: chunk.map(Key => ({ Key }))
      }, (err, data) => err ? reject(err) : resolve(data));
    });
  }
}

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(cookieParser());
app.use(express.static(rootDir, { index: 'index.html' }));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sendDatabaseError(res, error) {
  console.error(error);
  return res.status(500).json({ error: '数据库操作失败，请检查云数据库配置' });
}

async function authenticate(req, res, next) {
  try {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : req.cookies.tappyread_session;
    if (!token) return res.status(401).json({ error: '未登录' });
    const [rows] = await pool.execute(
      `SELECT u.id, u.username FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > NOW()`,
      [hashToken(token)]
    );
    if (!rows.length) return res.status(401).json({ error: '登录已过期，请重新登录' });
    req.user = rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    sendDatabaseError(res, error);
  }
}

async function issueSession(userId, res) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + sessionDays * 86400000);
  await pool.execute(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), userId, expiresAt]
  );
  res.cookie('tappyread_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionDays * 86400000
  });
  return token;
}

/* =====================================================================
   登录日志（loginlog）：记录注册 / 登录行为，字段包括用户名、操作时间、
   在线时长、IP 归属地（省市）。
   ===================================================================== */
let loginLogTableReady = false;
async function ensureLoginLogTable() {
  if (loginLogTableReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS loginlog (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL COMMENT '用户名',
      action VARCHAR(20) NOT NULL COMMENT '行为类型：register 注册 / login 登录',
      action_time DATETIME NOT NULL COMMENT '操作时间',
      duration_seconds INT UNSIGNED NULL COMMENT '本次登录在线时长（秒），退出登录时回填',
      ip VARCHAR(64) NULL COMMENT '客户端 IP',
      ip_region VARCHAR(100) NULL COMMENT 'IP 归属地（省市）',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_username (username),
      KEY idx_action_time (action_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  loginLogTableReady = true;
}

/** 取客户端真实 IP（优先取反向代理传入的 X-Forwarded-For 第一个地址） */
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || '';
}

/** IP → 省市归属地。使用 ip-api.com 免费查询接口，2 秒超时，查询失败不影响主流程 */
async function lookupIpRegion(ip) {
  if (!ip) return null;
  const bare = ip.replace(/^::ffff:/, '');
  if (bare === '127.0.0.1' || bare === '::1' || bare.startsWith('192.168.') || bare.startsWith('10.') || bare.startsWith('172.')) {
    return '本地/内网';
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(bare)}?lang=zh-CN&fields=status,regionName,city`, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'success') return null;
    return [data.regionName, data.city].filter(Boolean).join(' ') || null;
  } catch (error) {
    return null;
  }
}

/** 写入一条登录日志（注册/登录），失败只打日志、不影响注册或登录本身 */
async function writeLoginLog(username, action, req) {
  try {
    await ensureLoginLogTable();
    const ip = getClientIp(req);
    const ipRegion = await lookupIpRegion(ip);
    await pool.execute(
      'INSERT INTO loginlog (username, action, action_time, ip, ip_region) VALUES (?, ?, NOW(), ?, ?)',
      [username, action, ip || null, ipRegion || null]
    );
  } catch (error) {
    console.warn('写入登录日志失败（不影响注册/登录）:', error.message);
  }
}

/** 退出登录时，把这次会话的在线时长回填到最近一条未回填的日志记录里 */
async function fillLoginLogDuration(username) {
  try {
    await ensureLoginLogTable();
    await pool.execute(
      `UPDATE loginlog
       SET duration_seconds = TIMESTAMPDIFF(SECOND, action_time, NOW())
       WHERE username = ? AND duration_seconds IS NULL
       ORDER BY action_time DESC LIMIT 1`,
      [username]
    );
  } catch (error) {
    console.warn('回填登录日志在线时长失败（不影响退出登录）:', error.message);
  }
}

/* =====================================================================
   新注册用户默认绘本目录：从 COS 模板 json/start.json 拉取一份默认绘本目录，
   写入这个新用户自己的 json/{username}.json，保证新用户登录后自带该绘本。
   ===================================================================== */

// 🔧 修复：之前这里用不带身份认证的公网 fetch() 直接请求 json/start.json，
// 而 json/ 目录跟 jpeg/ 不一样，项目里所有读取它的地方（比如上面读用户绘本库
// 用的 cosClient.getObject）全部走的是带密钥认证的 COS SDK，说明这个目录
// 大概率从没开过公有读权限——公网直接 fetch 大概率会被 COS 返回 403 拒绝
// 访问，resp.ok 为 false，函数直接返回 null，表现为"注册成功但没有默认绘本"。
// 现在改成跟读用户绘本库完全一样的方式：用带密钥认证的 COS SDK 直接读，
// 不再依赖 json/ 目录的公有读设置，从根上排除这一类权限问题。
function fetchStartTemplate() {
  return new Promise((resolve) => {
    if (!cosConfigured) return resolve(null);
    const key = `${COS_JSON_DIR}/start.json`;
    const timer = setTimeout(() => resolve(null), 8000);
    cosClient.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, data) => {
      clearTimeout(timer);
      if (err) {
        console.warn('获取默认绘本模板 start.json 失败（不影响注册）:', err.message);
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(data.Body.toString('utf8'));
        if (!parsed || !Array.isArray(parsed.tree)) return resolve(null);
        resolve(parsed);
      } catch (parseErr) {
        console.warn('默认绘本模板 start.json 内容不是合法JSON（不影响注册）:', parseErr.message);
        resolve(null);
      }
    });
  });
}

/** 新用户注册成功后，初始化默认绘本目录（失败不影响注册本身） */
async function initDefaultLibraryForNewUser(username) {
  try {
    const template = await fetchStartTemplate();
    if (!template) return;
    await syncLibraryToCos(username, {
      tree: template.tree,
      collapsed: Array.isArray(template.collapsed) ? template.collapsed : [],
      selectedFolderId: template.selectedFolderId || null,
      currentStoryId: template.currentStoryId || null
    });
  } catch (error) {
    console.warn('初始化新用户默认绘本目录失败（不影响注册）:', error.message);
  }
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const [rows] = await pool.execute(
      'SELECT id, username, password FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    if (!rows.length) return res.status(401).json({ error: '用户名或密码错误，请重试' });

    const storedPassword = String(rows[0].password || '');
    const isValid = storedPassword.startsWith('$2')
      ? await bcrypt.compare(password, storedPassword)
      : storedPassword === password;

    if (!isValid) return res.status(401).json({ error: '用户名或密码错误，请重试' });

    const token = await issueSession(rows[0].id, res);
    // 登录日志：不阻塞响应，失败也不影响登录本身
    writeLoginLog(rows[0].username, 'login', req);
    res.json({ token, userId: rows[0].id, username: rows[0].username });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

    // 🔧 修复：注册前先显式校验用户名是否已存在，而不是仅仅依赖数据库唯一索引
    // 抛出的 ER_DUP_ENTRY 错误——如果 users 表当初建表时没有对 username 加
    // UNIQUE 约束，重复用户名会被直接插入成功，校验形同虚设。
    const [existing] = await pool.execute('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (existing.length) return res.status(409).json({ error: '用户名已存在，请修改后重试!' });

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, passwordHash]
    );
    const token = await issueSession(result.insertId, res);

    // 新用户初始化默认绘本目录（从 COS 模板 jpeg/start.json 拉取），失败不影响注册本身
    await initDefaultLibraryForNewUser(username);
    // 注册日志：不阻塞响应，失败也不影响注册本身
    writeLoginLog(username, 'register', req);

    res.status(201).json({ token, userId: result.insertId, username });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '用户名已存在，请修改后重试!' });
    sendDatabaseError(res, error);
  }
});

/* 当前登录用户信息（前端用于用户级数据隔离与登录守卫） */
app.get('/api/auth/me', authenticate, async (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(req.sessionToken)]);
    // 回填这次会话的在线时长到登录日志，不阻塞响应、失败也不影响退出登录
    fillLoginLogDuration(req.user.username);
    res.clearCookie('tappyread_session');
    res.json({ ok: true });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

/* =====================================================================
   前端直传 COS 支持（终极上传方案）：
   文件体不经过后端，浏览器通过 cos-js-sdk-v5 直连 COS。
   后端只提供两个轻量接口：配置（不含密钥）+ 按请求实时签名。
   密钥始终留在服务端，安全性等同后端中转，但大文件不再受
   Vercel Serverless 4.5MB 请求体上限与函数时长限制。
   ===================================================================== */

/* 直传配置：桶名/地域/当前用户目录 JSON 键（不含任何密钥） */
app.get('/api/cos/config', authenticate, (req, res) => {
  const safeUsername = sanitizeUsername(req.user.username).replace(/_+$/g, '') || 'guest';
  res.json({
    enabled: cosConfigured,
    bucket: COS_BUCKET,
    region: COS_REGION,
    userId: req.user.id,
    username: req.user.username,
    jsonKey: `${COS_JSON_DIR}/${safeUsername}.json`,
    imgDir: COS_IMG_DIR,
    htmlDir: COS_HTML_DIR
  });
});

/* 实时签名：仅允许当前用户自己的对象键，防越权 */
app.get('/api/cos/auth', authenticate, (req, res) => {
  if (!cosConfigured) return sendCosConfigError(res);
  const method = String(req.query.method || 'get').toUpperCase();
  const key = String(req.query.key || '').trim();
  if (!key) return res.status(400).json({ error: '缺少 key 参数' });

  const safeUsername = sanitizeUsername(req.user.username).replace(/_+$/g, '') || 'guest';
  // 🆕 图片路径现在可能带"绘本名称文件夹"这一层（jpeg/{绘本名}/u{id}_...），
  // 用 keyMatchesUserPrefix 同时兼容新旧两种结构
  const allowed =
    keyMatchesUserPrefix(key, COS_IMG_DIR, req.user.id) ||
    keyMatchesUserPrefix(key, COS_HTML_DIR, req.user.id) ||
    key === `${COS_JSON_DIR}/${safeUsername}.json`;
  if (!allowed) return res.status(403).json({ error: '无权访问该 COS 路径' });

  let query;
  let headers;
  try { query = req.query.query ? JSON.parse(req.query.query) : undefined; } catch (e) { query = undefined; }
  try { headers = req.query.headers ? JSON.parse(req.query.headers) : undefined; } catch (e) { headers = undefined; }

  const authorization = cosClient.getAuth({
    Bucket: COS_BUCKET,
    Region: COS_REGION,
    Method: method,
    Key: key,
    Expires: 600,
    Query: query,
    Headers: headers
  });
  res.json({ Authorization: authorization });
});

app.get('/api/library', authenticate, async (req, res) => {
  try {
    if (!cosConfigured) return res.json({ tree: [], collapsed: [], selectedFolderId: null, currentStoryId: null });
    const cosSnapshot = await getLatestLibraryFromCos(req.user.username);
    if (cosSnapshot && Array.isArray(cosSnapshot.tree)) {
      return res.json({
        tree: cosSnapshot.tree,
        collapsed: Array.isArray(cosSnapshot.collapsed) ? cosSnapshot.collapsed : [],
        selectedFolderId: cosSnapshot.selectedFolderId || null,
        currentStoryId: cosSnapshot.currentStoryId || null
      });
    }
    return res.json({ tree: [], collapsed: [], selectedFolderId: null, currentStoryId: null });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.put('/api/library', authenticate, async (req, res) => {
  try {
    if (!cosConfigured) return sendCosConfigError(res);
    const { tree, collapsed } = req.body;
    if (!Array.isArray(tree) || !Array.isArray(collapsed)) return res.status(400).json({ error: '目录数据格式错误' });
    const result = await syncLibraryToCos(req.user.username, {
      tree,
      collapsed,
      selectedFolderId: req.body.selectedFolderId || null,
      currentStoryId: req.body.currentStoryId || null
    });
    if (!result) return res.status(500).json({ error: '同步用户绘本目录到 COS 失败' });
    res.json({ ok: true, key: result.key, url: result.url });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

/* 前端直传完成后的轻量收尾：清理该用户旧版命名的目录文件（不携带目录数据） */
app.post('/api/library', authenticate, async (req, res) => {
  try {
    if (!cosConfigured) return res.json({ ok: true, note: 'COS 未配置，跳过清理' });
    const allKeys = await listCosKeys(`${COS_JSON_DIR}/`);
    const staleKeys = getLegacyLibraryKeysForUsername(req.user.username, allKeys)
      .filter(key => key !== `${COS_JSON_DIR}/${sanitizeUsername(req.user.username).replace(/_+$/g, '') || 'guest'}.json`);
    if (staleKeys.length) await deleteCosObjects(staleKeys.slice(0, 50));
    res.json({ ok: true, cleaned: staleKeys.length });
  } catch (error) {
    console.warn('清理旧版绘本目录文件失败（不影响直传结果）:', error);
    res.json({ ok: true, cleaned: 0 });
  }
});

/* =====================================================================
   COS 图片上传：仅登录用户，图片进入统一目录 jpeg/，
   对象键带 u{userId}_ 前缀实现按用户隔离
   ===================================================================== */
app.post('/api/upload/image', authenticate, async (req, res) => {
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const fileName = String(req.body.fileName || 'image');
    const dataUrl = String(req.body.dataUrl || '');
    const match = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: '图片数据格式错误（需要 base64 dataURL）' });
    const mime = match[1];
    if (!/^image\//i.test(mime)) return res.status(400).json({ error: '仅支持上传图片文件' });
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) return res.status(400).json({ error: '图片内容为空' });

    // 对象键带 u{userId}_ 前缀，实现用户间隔离；
    // 🆕 新增"绘本名称文件夹"层级：传了 storyName 时，图片存到 jpeg/{绘本名}/ 子目录下
    const storyFolder = req.body.storyName ? sanitizeStoryFolderName(req.body.storyName) + '/' : '';
    const key = `${COS_IMG_DIR}/${storyFolder}u${req.user.id}_${Date.now()}_${sanitizeFileName(fileName)}`;
    await putCosObject(key, buffer);
    res.json({ ok: true, key, url: COS_BASE_URL + key });
  } catch (error) {
    console.error('COS 上传失败:', error);
    res.status(500).json({ error: '图片上传失败：' + (error.message || '未知错误') });
  }
});

/** HTML 一键生成：上传原始 HTML 到 COS html/ 目录，按用户隔离并供后续读取/裁剪 */
app.post('/api/upload/html', authenticate, async (req, res) => {
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const fileName = String(req.body.fileName || 'page.html');
    const source = String(req.body.source || req.body.html || '');
    if (!source.trim()) return res.status(400).json({ error: 'HTML 内容为空' });

    const key = `${COS_HTML_DIR}/u${req.user.id}_${Date.now()}_${sanitizeFileName(fileName)}`;
    await putCosTextObject(key, source, 'text/html; charset=utf-8');
    res.json({ ok: true, key, url: COS_BASE_URL + key });
  } catch (error) {
    console.error('COS HTML 上传失败:', error);
    res.status(500).json({ error: 'HTML 上传失败：' + (error.message || '未知错误') });
  }
});

/* =====================================================================
   COS 图片删除：删除绘本时清理云端图片。
   仅允许删除当前用户上传的（u{userId}_ 前缀）对象，防止越权删除
   ===================================================================== */
app.post('/api/images/delete', authenticate, async (req, res) => {
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
    // 仅允许删除当前用户上传的对象，防止越权删除。
    // 🆕 图片路径现在可能带"绘本名称文件夹"这一层（jpeg/{绘本名}/u{id}_...），
    // 用 keyMatchesUserPrefix 同时兼容新旧两种结构，否则按绘本名分文件夹后，
    // 删除绘本时这里的前缀过滤会把新结构的 key 全部误判为"越权"而拒绝删除。
    // 单次最多接受 2000 个 key（覆盖绝大多数绘本的图片数量）；之前的 200 上限
    // 对页数较多的绘本明显不够，会导致删不干净、COS 里残留部分对象。
    const safeKeys = keys
      .map(k => String(k || '').trim())
      .filter(k => keyMatchesUserPrefix(k, COS_IMG_DIR, req.user.id) || keyMatchesUserPrefix(k, COS_HTML_DIR, req.user.id))
      .slice(0, 2000);
    if (!safeKeys.length) return res.json({ ok: true, deleted: 0, skipped: keys.length });
    await deleteCosObjects(safeKeys);
    res.json({ ok: true, deleted: safeKeys.length, skipped: keys.length - safeKeys.length });
  } catch (error) {
    console.error('COS 删除失败:', error);
    res.status(500).json({ error: '图片删除失败：' + (error.message || '未知错误') });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.listen(port, () => console.log(`TappyRead server listening on http://localhost:${port}`));