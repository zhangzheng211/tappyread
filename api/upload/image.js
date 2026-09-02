import COS from 'cos-nodejs-sdk-v5';
import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_BASE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/`;
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

/** 清洗文件名，保留安全字符 */
function sanitizeFileName(name) {
  const base = String(name || 'image').split(/[\\/]/).pop();
  return base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'image';
}

/** 上传单张图片到 COS */
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  const user = await authenticate(req);
  if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const fileName = String(req.body?.fileName || 'image');
    const dataUrl = String(req.body?.dataUrl || '');
    const match = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
    if (!match) return sendJson(res, 400, { error: '图片数据格式错误（需要 base64 dataURL）' });
    const mime = match[1];
    if (!/^image\//i.test(mime)) return sendJson(res, 400, { error: '仅支持上传图片文件' });
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) return sendJson(res, 400, { error: '图片内容为空' });

    // 对象键带 u{userId}_ 前缀，实现用户间隔离
    const key = `${COS_IMG_DIR}/u${user.id}_${Date.now()}_${sanitizeFileName(fileName)}`;
    await putCosObject(key, buffer);
    return sendJson(res, 200, { ok: true, key, url: COS_BASE_URL + key });
  } catch (error) {
    console.error('Vercel COS upload error:', error);
    return sendJson(res, 500, { error: '图片上传失败：' + (error.message || '未知错误') });
  }
}
