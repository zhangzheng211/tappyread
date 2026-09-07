-- ============================================================
-- 本次更新涉及的数据库变更（TiDB / MySQL 兼容语法）
-- ============================================================
-- 说明：以下 SQL 均已加了存在性判断，重复执行也是安全的。
-- 应用启动时（server/server.js）以及每次调用注册/登录接口
-- 时也会自动尝试执行 CREATE TABLE IF NOT EXISTS，
-- 所以理论上不手动执行这个文件也能正常工作；
-- 但仍建议手动执行一次，确保表结构、索引符合预期。

-- 1. 新增 loginlog 表：记录注册 / 登录行为
CREATE TABLE IF NOT EXISTS loginlog (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL COMMENT '用户名',
  action VARCHAR(20) NOT NULL COMMENT '行为类型：register 注册 / login 登录',
  action_time DATETIME NOT NULL COMMENT '操作时间',
  duration_seconds INT UNSIGNED NULL COMMENT '本次登录在线时长（秒），退出登录时回填',
  ip VARCHAR(64) NULL COMMENT '客户端 IP',
  ip_region VARCHAR(100) NULL COMMENT 'IP 归属地（省市）',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_username (username),
  KEY idx_action_time (action_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 强烈建议：给 users.username 加唯一索引，作为「用户名不能重复」的
--    最后一道防线（应用层已经在 INSERT 前做了显式查重，这里是双保险，
--    防止极端并发场景下的竞态条件）。
--    如果你的 users 表当初建表时就已经有这个唯一索引，执行下面这条会报
--    "Duplicate key name" 错误，直接忽略即可，不影响其它变更。
ALTER TABLE users ADD UNIQUE INDEX uniq_username (username);
