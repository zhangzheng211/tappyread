import { authenticate, getPool } from './_mysql.js';

function sendJson(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8').end(JSON.stringify(body));
}

export default async function handler(req, res) {
  try {
    const user = await authenticate(req);
    if (!user) return sendJson(res, 401, { error: '未登录或登录已过期' });
    const pool = getPool();

    if (req.method === 'GET') {
      const [rows] = await pool.execute(
        'SELECT library_json, collapsed_json, selected_folder_id, current_story_id FROM user_libraries WHERE user_id = ?',
        [user.id]
      );
      if (!rows.length) return sendJson(res, 200, { tree: [], collapsed: [], selectedFolderId: null, currentStoryId: null });
      const row = rows[0];
      return sendJson(res, 200, {
        tree: typeof row.library_json === 'string' ? JSON.parse(row.library_json) : row.library_json,
        collapsed: typeof row.collapsed_json === 'string' ? JSON.parse(row.collapsed_json) : row.collapsed_json,
        selectedFolderId: row.selected_folder_id,
        currentStoryId: row.current_story_id
      });
    }

    if (req.method === 'PUT') {
      const { tree, collapsed } = req.body || {};
      if (!Array.isArray(tree) || !Array.isArray(collapsed)) return sendJson(res, 400, { error: '目录数据格式错误' });
      await pool.execute(
        `INSERT INTO user_libraries (user_id, library_json, collapsed_json, selected_folder_id, current_story_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE library_json = VALUES(library_json), collapsed_json = VALUES(collapsed_json),
         selected_folder_id = VALUES(selected_folder_id), current_story_id = VALUES(current_story_id)`,
        [user.id, JSON.stringify(tree), JSON.stringify(collapsed), req.body.selectedFolderId || null, req.body.currentStoryId || null]
      );
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: '请求方法不允许' });
  } catch (error) {
    console.error('Vercel library error:', error);
    return sendJson(res, 500, { error: '绘本目录服务暂时不可用，请检查云数据库配置' });
  }
}
