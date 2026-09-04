import COS from 'cos-nodejs-sdk-v5';
import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
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
    error: 'COS 未配置：请在 Vercel 项目的 Environment Variables 中填写 COS_SECRET_ID 与 COS_SECRET_KEY，然后重新部署（Redeploy）'
  });
}

/** 清洗文件名，保留安全字符 */
function sanitizeFileName(name) {
  const base = String(name || 'page.html').split(/[\\/]/).pop();
  return base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 120) || 'page.html';
}

function putCosTextObject(key, text) {
  return new Promise((resolve, reject) => {
    cosClient.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: Buffer.from(text, 'utf8'),
      ContentType: 'text/html; charset=utf-8'
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: '请求方法不允许' });
  const user = await authenticate(req);
  if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
  if (!cosConfigured) return sendCosConfigError(res);
  try {
    const fileName = String(req.body?.fileName || 'page.html');
    const source = String(req.body?.source || req.body?.html || '');
    if (!source.trim()) return sendJson(res, 400, { error: 'HTML 内容为空' });

    const key = `${COS_HTML_DIR}/u${user.id}_${Date.now()}_${sanitizeFileName(fileName)}`;
    await putCosTextObject(key, source);
    return sendJson(res, 200, { ok: true, key, url: COS_BASE_URL + key });
  } catch (error) {
    console.error('Vercel COS HTML upload error:', error);
    return sendJson(res, 500, { error: 'HTML 上传失败：' + (error.message || '未知错误') });
  }
}
