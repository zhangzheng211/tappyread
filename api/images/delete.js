import COS from 'cos-nodejs-sdk-v5';
import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured
  ? new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY })
  : null;

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

function sendCosConfigError(res) {
  return sendJson(res, 503, {
    error: 'COS 未配置：请在环境变量中填写 COS_SECRET_ID 与 COS_SECRET_KEY（腾讯云控制台 → 访问管理 → API 密钥管理）'
  });
}

/** 批量删除 COS 对象 */
function deleteCosObjects(keys) {
  return new Promise((resolve, reject) => {
    cosClient.deleteMultipleObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Objects: keys.map(Key => ({ Key }))
    }, (err, data) => err ? reject(err) : resolve(data));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  const user = await authenticate(req);
  if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    // 仅允许删除当前用户上传的（u{userId}_ 前缀）对象，防止越权删除
    const prefix = `${COS_IMG_DIR}/u${user.id}_`;
    const safeKeys = keys
      .map(k => String(k || '').trim())
      .filter(k => k.startsWith(prefix))
      .slice(0, 200); // 单次最多删除 200 个对象
    if (!safeKeys.length) return sendJson(res, 200, { ok: true, deleted: 0, skipped: keys.length });
    await deleteCosObjects(safeKeys);
    return sendJson(res, 200, { ok: true, deleted: safeKeys.length, skipped: keys.length - safeKeys.length });
  } catch (error) {
    console.error('Vercel COS delete error:', error);
    return sendJson(res, 500, { error: '图片删除失败：' + (error.message || '未知错误') });
  }
}
