import { authenticate } from '../_mysql.js';

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: '请求方法不允许' });
  try {
    const user = await authenticate(req);
    if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
    return sendJson(res, 200, { id: user.id, username: user.username });
  } catch (error) {
    console.error('Vercel me error:', error);
    return sendJson(res, 500, { error: '服务暂时不可用' });
  }
}
