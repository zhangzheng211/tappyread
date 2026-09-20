import { authenticate } from '../_mysql.js';

const COS_BUCKET = process.env.COS_BUCKET || 'tappyreadjpeg-1325106148';
const COS_REGION = process.env.COS_REGION || 'ap-guangzhou';
const COS_IMG_DIR = (process.env.COS_IMG_DIR || 'jpeg').replace(/\/+$/, '');
const COS_HTML_DIR = (process.env.COS_HTML_DIR || 'html').replace(/\/+$/, '');
const COS_JSON_DIR = (process.env.COS_JSON_DIR || 'json').replace(/\/+$/, '');
const COS_TEMPLATE_KEY = process.env.COS_TEMPLATE_KEY || `${COS_JSON_DIR}/start.json`;
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
    const jsonKey = `${COS_JSON_DIR}/${safeUsername}.json`;
    // 🆕 不再对 jsonKey 做 headObject 存在性探测：这个探测本身要访问 COS
    // （Vercel 跨区域访问广州 COS 偶发 ETIMEDOUT，单次探测可能耗时 10+ 秒，
    // 是日志里"检测 COS 对象是否存在时出错"这条警告刷屏、以及本接口响应
    // 变慢的直接原因）。而且这个探测结果现在已经没有任何代码在依赖了——
    // 前端 loadRemoteLibrary() 的兜底逻辑已经改成不管这个标记，总是直接
    // 尝试读取用户自己的文件，只有明确收到 404 才会改用 start.json 模板
    // （见 tappyread.html 相关改造）。继续做这次探测只有成本、没有收益，
    // 所以直接去掉，userLibraryExists 固定返回 true 仅作字段兼容保留。
    const userLibraryExists = true;
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
