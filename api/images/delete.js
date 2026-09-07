import COS from 'cos-nodejs-sdk-v5';
import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
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

/** 批量删除 COS 对象（腾讯云 deleteMultipleObject 单次最多支持 1000 个对象，
 *  这里按 900 一批切分，避免绘本页数较多时一次性删不完） */
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  const user = await authenticate(req);
  if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
    // 仅允许删除当前用户上传的（u{userId}_ 前缀）对象，防止越权删除。
    // 🔧 修复：之前这里只放行 jpeg/ 图片目录的前缀，绘本页面若是 HTML 类型
    // （对应 html/ 目录下的 htmlCosKey），会被这里的前缀过滤直接挡掉、
    // 永远删不掉，导致删除绘本后 COS 里仍然残留部分对象。现在与
    // server/server.js 保持一致，同时放行 jpeg/ 与 html/ 两个目录前缀。
    const imgPrefix = `${COS_IMG_DIR}/u${user.id}_`;
    const htmlPrefix = `${COS_HTML_DIR}/u${user.id}_`;
    // 单次最多接受 2000 个 key（覆盖绝大多数绘本的图片数量），避免请求体过大；
    // 之前的 200 上限对页数较多的绘本明显不够，也会导致删不干净。
    const safeKeys = keys
      .map(k => String(k || '').trim())
      .filter(k => k.startsWith(imgPrefix) || k.startsWith(htmlPrefix))
      .slice(0, 2000);
    if (!safeKeys.length) return sendJson(res, 200, { ok: true, deleted: 0, skipped: keys.length });
    await deleteCosObjects(safeKeys);
    return sendJson(res, 200, { ok: true, deleted: safeKeys.length, skipped: keys.length - safeKeys.length });
  } catch (error) {
    console.error('Vercel COS delete error:', error);
    return sendJson(res, 500, { error: '图片删除失败：' + (error.message || '未知错误') });
  }
}
