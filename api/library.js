import { authenticate, getPool } from './_mysql.js';
import COS from 'cos-nodejs-sdk-v5';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/`;
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured
  ? new COS({
      SecretId: process.env.COS_SECRET_ID,
      SecretKey: process.env.COS_SECRET_KEY,
      // Vercel 函数默认可能跑在美国区域，到广州 COS 一次往返都要 200~400ms，
      // 一旦网络抖动（跨太平洋链路很常见），SDK 默认的重试机制会让请求越等越久。
      // 这里给单次请求设置 8 秒硬超时，超时就直接失败，交给上层做快速降级，
      // 而不是让整个 /api/library 请求被拖到几十秒甚至更久。
      Timeout: 8000
    })
  : null;

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
  const safeUsername = sanitizeUsername(username).replace(/_+$/g, '') || 'guest';
  const directKey = `${COS_JSON_DIR}/${safeUsername}.json`;

  // 快速路径：绝大多数情况下，文件就在标准的 json/{username}.json 位置（保存时
  // 就是写到这里的），直接 getObject 一次就能拿到，不需要先 getBucket 列出整个
  // json/ 目录再匹配文件名——这一步以前是"先 list 再 get"两次串行的 COS 请求，
  // 在跨区域网络较慢时会明显拖慢首屏加载速度，这里改成"先直接 get，找不到才
  // 退回到 list 兼容旧文件名"，常见情况下能省下一次往返。
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

function sendCosConfigError(res) {
  return sendJson(res, 503, {
    error: 'COS 未配置：请在 Vercel 项目的 Environment Variables 中填写 COS_SECRET_ID 与 COS_SECRET_KEY，然后重新部署（Redeploy）'
  });
}

function putCosTextObject(key, text, contentType = 'application/json; charset=utf-8') {
  return new Promise((resolve, reject) => {
    if (!cosClient) return reject(new Error('COS 未配置'));
    cosClient.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: Buffer.from(text, 'utf8'),
      ContentType: contentType
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function deleteCosObjects(keys) {
  return new Promise((resolve, reject) => {
    if (!cosClient || !keys.length) return resolve(null);
    cosClient.deleteMultipleObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Objects: keys.map(Key => ({ Key }))
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// 把当前用户的绘本目录写入腾讯云 COS 的 json/{username}.json（此前这里只做了参数
// 校验就直接返回 { ok:true }，并没有真正调用 COS 的 putObject，导致本地 Express
// 服务器（server/server.js）保存正常，但部署到 Vercel 后台目录数据其实从未被写入
// COS，只是接口“假装”成功了。现在补上和 server/server.js 完全一致的真实上传逻辑。
async function syncLibraryToCos(username, snapshot) {
  if (!cosConfigured || !username) return null;
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

  // 顺手清理掉这个用户名下的旧版/重复命名文件，避免 json/ 目录越堆越多
  try {
    const allKeys = await listCosKeys(`${COS_JSON_DIR}/`);
    const staleKeys = getLegacyLibraryKeysForUsername(username, allKeys).filter(key => key !== canonicalKey);
    if (staleKeys.length) await deleteCosObjects(staleKeys.slice(0, 50));
  } catch (cleanupError) {
    console.warn('清理旧版绘本目录文件失败（不影响本次保存）:', cleanupError);
  }

  return { key: canonicalKey, url: COS_BASE_URL + canonicalKey };
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
      if (!cosConfigured) return sendCosConfigError(res);
      const { tree, collapsed } = req.body || {};
      if (!Array.isArray(tree) || !Array.isArray(collapsed)) return sendJson(res, 400, { error: '目录数据格式错误' });
      const result = await syncLibraryToCos(user.username, {
        tree,
        collapsed,
        selectedFolderId: req.body.selectedFolderId || null,
        currentStoryId: req.body.currentStoryId || null
      });
      if (!result) return sendJson(res, 500, { error: '同步用户绘本目录到 COS 失败' });
      return sendJson(res, 200, { ok: true, key: result.key, url: result.url });
    }
    return sendJson(res, 405, { error: '请求方法不允许' });
  } catch (error) {
    console.error('Vercel library error:', error);
    return sendJson(res, 500, { error: '绘本目录服务暂时不可用，请检查云数据库配置' });
  }
}
