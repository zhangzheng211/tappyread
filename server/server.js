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
  try {
    const keys = await listCosKeys(`${COS_JSON_DIR}/`);
    const safeUsername = sanitizeUsername(username).replace(/_+$/g, '') || 'guest';
    const directKey = `${COS_JSON_DIR}/${safeUsername}.json`;
    const exactMatch = keys.includes(directKey) ? directKey : null;
    const legacyMatches = keys.filter(key => {
      const fileName = key.split('/').pop() || '';
      const baseName = fileName.replace(/\.json$/i, '');
      return baseName === safeUsername || baseName.startsWith(`${safeUsername}_绘本目录`);
    });
    const preferred = exactMatch || legacyMatches[0] || null;
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

/** 删除 COS 对象（可批量） */
function deleteCosObjects(keys) {
  return new Promise((resolve, reject) => {
    cosClient.deleteMultipleObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Objects: keys.map(Key => ({ Key }))
    }, (err, data) => err ? reject(err) : resolve(data));
  });
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

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, passwordHash]
    );
    const token = await issueSession(result.insertId, res);
    res.status(201).json({ token, userId: result.insertId, username });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '用户名已存在，请修改用户名重试！' });
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
    res.clearCookie('tappyread_session');
    res.json({ ok: true });
  } catch (error) {
    sendDatabaseError(res, error);
  }
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

    const key = `${COS_IMG_DIR}/u${req.user.id}_${Date.now()}_${sanitizeFileName(fileName)}`;
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
    const userPrefix = `u${req.user.id}_`;
    const safeKeys = keys
      .map(k => String(k || '').trim())
      .filter(k => {
        const imgPrefix = `${COS_IMG_DIR}/${userPrefix}`;
        const htmlPrefix = `${COS_HTML_DIR}/${userPrefix}`;
        return k.startsWith(imgPrefix) || k.startsWith(htmlPrefix);
      })
      .slice(0, 200);
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