import { authenticate, getPool, hashToken, getToken, fillLoginLogDuration } from '../_mysql.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '请求方法不允许' });
  const user = await authenticate(req);
  const token = getToken(req);
  if (token) {
    await getPool().execute('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  }
  // 回填这次会话的在线时长到登录日志，不阻塞响应、失败也不影响退出登录
  if (user) await fillLoginLogDuration(user.username);
  res.setHeader('Set-Cookie', 'tappyread_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}
