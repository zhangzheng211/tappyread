import { authenticate, getPool } from './_mysql.js';
import COS from 'cos-nodejs-sdk-v5';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/`;
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY }) : null;

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

function sanitizeUsername(name) {
  return String(name || '').trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'guest';
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
  }

  return Array.from(new Set([
    ...directNames,
    ...legacyNames,
    ...directNames.map(name => `${COS_JSON_DIR}/${name}`),
    ...legacyNames.map(name => `${COS_JSON_DIR}/${name}`)
  ].filter(Boolean).map(name => `${COS_JSON_DIR}/${name}`.replace(/\/+/, '/'))));
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
    if (!cosClient) return resolve([]);
    cosClient.getBucket({ Bucket: COS_BUCKET, Region: COS_REGION, Prefix: prefix, MaxKeys: 1000 }, (err, data) => {
      if (err) {
        if (err.code === 'NoSuchBucket' || err.code === 'NoSuchKey' || err.statusCode === 404) return resolve([]);
        return reject(err);
      }
      const contents = Array.isArray(data?.Contents) ? data.Contents : [];
      resolve(contents.map(item => item.Key).filter(Boolean));
    });
  });
}

function readCosJsonFile(key) {
  if (!key || !cosClient) return Promise.resolve(null);
  return new Promise((resolve) => {
    cosClient.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, data) => {
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

export default async function handler(req, res) {
  try {
    const user = await authenticate(req);
    if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });

    if (req.method === 'GET') {
      if (!cosConfigured) return sendJson(res, 200, { tree: [], collapsed: [], selectedFolderId: null, currentStoryId: null });
      const snapshot = await getLatestLibraryFromCos(user.username);
      if (snapshot && Array.isArray(snapshot.tree)) {
        return sendJson(res, 200, {
          tree: snapshot.tree,
          collapsed: Array.isArray(snapshot.collapsed) ? snapshot.collapsed : [],
          selectedFolderId: snapshot.selectedFolderId || null,
          currentStoryId: snapshot.currentStoryId || null
        });
      }
      return sendJson(res, 200, { tree: [], collapsed: [], selectedFolderId: null, currentStoryId: null });
    }

    if (req.method === 'PUT') {
      const { tree, collapsed } = req.body || {};
      if (!Array.isArray(tree) || !Array.isArray(collapsed)) return sendJson(res, 400, { error: '目录数据格式错误' });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: '请求方法不允许' });
  } catch (error) {
    console.error('Vercel library error:', error);
    return sendJson(res, 500, { error: '绘本目录服务暂时不可用，请检查云数据库配置' });
  }
}
