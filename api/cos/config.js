import { authenticate } from '../_mysql.js';
import COS from 'cos-nodejs-sdk-v5';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const COS_TEMPLATE_KEY = process.env.COS_TEMPLATE_KEY || `${COS_JSON_DIR}/start.json`;
const cosConfigured = Boolean(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY);
const cosClient = cosConfigured ? new COS({SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 3000}) : null;

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

function objectExists(Key) {
  return new Promise(resolve => {
    if(!cosClient) return resolve(true); // 无法判断时保守当作"存在"，避免误触发模板覆盖
    cosClient.headObject({Bucket:COS_BUCKET, Region:COS_REGION, Key}, err => {
      if(!err) return resolve(true);
      const status = Number(err.statusCode || err.status || 0);
      const code = String(err.code || '').toLowerCase();
      if(status === 404 || code === 'nosuchkey' || code === 'notfound') return resolve(false);
      // 🆕 超时/网络异常等其它错误不能当成"文件不存在"，否则会被误判为新用户、
      // 被 start.json 模板覆盖真实数据。宁可保守地认为"存在"，让后续真正
      // 读取该文件的逻辑去处理（读取失败会返回错误而不是静默用模板顶替）。
      console.warn('检测 COS 对象是否存在时出错，保守当作存在处理:', Key, err);
      resolve(true);
    });
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
    const safeUsername = sanitizeUsername(user.username).replace(/_+$/g, '') || 'guest';
    const jsonKey = `${COS_JSON_DIR}/${safeUsername}.json`;
    // 🆕 关键修复：这里之前硬编码成 false（"新用户默认走 start.json"），
    // 本意是给全新用户省一次 headObject 请求，但副作用是：只要前端主流程
    // （GET /api/library）因为任何原因失败、走到这个"COS 直连兜底"配置时，
    // 所有用户（不只是真正的新用户）都会被当成"没有自己的目录文件"，从而
    // 被兜底逻辑加载 start.json 模板、并自动保存覆盖掉真实数据。
    // 现在改成真实检测（cosClient 本身带了超时保护，不会无限等待）；即使
    // 这次检测本身失败/超时，也保守地当作"存在"处理（宁可让前端多尝试读
    // 一次自己的文件、读不到再判定为不存在，也不要轻易谎称"不存在"）。
    const userLibraryExists = cosConfigured ? await objectExists(jsonKey).catch(() => true) : true;
    return sendJson(res, 200, {
      enabled: cosConfigured,
      bucket: COS_BUCKET,
      region: COS_REGION,
      userId: user.id,
      username: user.username,
      jsonKey,
      userLibraryExists,
      templateKey: COS_TEMPLATE_KEY,
      imgDir: COS_IMG_DIR,
      htmlDir: COS_HTML_DIR
    });
  } catch (error) {
    console.error('Vercel cos/config error:', error);
    return sendJson(res, 500, { error: '服务暂时不可用' });
  }
}
