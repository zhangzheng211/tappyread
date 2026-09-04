import COS from 'cos-nodejs-sdk-v5';
import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured
  ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })
  : null;

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

function sendCosConfigError(res) {
  return sendJson(res, 503, {
    error: 'COS 未配置：请在 Vercel 项目的 Environment Variables 中填写 COS_SECRET_ID 与 COS_SECRET_KEY，然后重新部署（Redeploy）'
  });
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
    if (!cosConfigured) return sendCosConfigError(res);

    const method = String(req.query.method || 'get').toUpperCase();
    const key = String(req.query.key || '').trim();
    if (!key) return sendJson(res, 400, { error: '缺少 key 参数' });

    // 仅允许当前用户自己的对象键：图片/HTML 前缀 + 本人目录 JSON，防越权
    const safeUsername = sanitizeUsername(user.username).replace(/_+$/g, '') || 'guest';
    const allowed =
      key.startsWith(`${COS_IMG_DIR}/u${user.id}_`) ||
      key.startsWith(`${COS_HTML_DIR}/u${user.id}_`) ||
      key === `${COS_JSON_DIR}/${safeUsername}.json`;
    if (!allowed) return sendJson(res, 403, { error: '无权访问该 COS 路径' });

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
    return sendJson(res, 200, { Authorization: authorization });
  } catch (error) {
    console.error('Vercel cos/auth error:', error);
    return sendJson(res, 500, { error: '签名服务暂时不可用' });
  }
}
