import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

function sanitizeUsername(name) {
  return String(name || '').trim()
    .replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'guest';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: '请求方法不允许' });
  try {
    const user = await authenticate(req);
    if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
    const safeUsername = sanitizeUsername(user.username).replace(/_+$/g, '') || 'guest';
    return sendJson(res, 200, {
      enabled: cosConfigured,
      bucket: COS_BUCKET,
      region: COS_REGION,
      userId: user.id,
      username: user.username,
      jsonKey: `${COS_JSON_DIR}/${safeUsername}.json`,
      imgDir: COS_IMG_DIR,
      htmlDir: COS_HTML_DIR
    });
  } catch (error) {
    console.error('Vercel cos/config error:', error);
    return sendJson(res, 500, { error: '服务暂时不可用' });
  }
}
