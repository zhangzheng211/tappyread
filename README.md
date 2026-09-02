# tappyread — 点读绘本阅读器（用户数据绑定版）

基于 Node.js + Express + MySQL（TiDB Cloud）的绘本阅读应用，支持账号注册/登录、绘本目录云端同步、图片上传腾讯云 COS、HTML 绘本双击全屏点读。

## 一、核心能力（本次优化）

1. **深度用户绑定与数据隔离**
   - 「绘本目录」、绘本信息、页面文本全部按登录用户存储（MySQL `user_libraries` 表，按 `user_id` 隔离）。
   - 「导入备份」「一键生成」「批量导入绘本」「新增绘本」「添加绘本页面」操作后的数据均绑定当前用户。
   - 用户重新登录后绘本目录与信息不丢失；不同用户之间数据互相隔离（同一浏览器多账号也不串数据）。
   - 前端 localStorage 键带 `:userId` 后缀，同一浏览器多账号互不干扰。

2. **图片异步上传腾讯云 COS**
   - 「批量导入绘本」「新增绘本」「添加绘本页面」确认导入成功后，所选图片异步上传至
     `https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/jpeg/`。
   - 图片对象键格式：`jpeg/u{userId}_{时间戳}_{文件名}`（按用户隔离，防止越权删除他人图片）。
   - 上传成功后页面写入 `cosKey`，之后图片直接从 COS URL 加载 —— 刷新页面、换设备都不丢失。
   - **删除绘本时同步删除该绘本在 COS 上的全部图片**。
   - 备份文件导入后，若备份内带 Base64 图片，会自动补传 COS 并回填 `cosKey`。

3. **HTML 绘本双击全屏优化**
   - 双击 HTML 绘本页面**任意位置**（包括空白处、文本处）均可进入/退出全屏。
   - 实现方式：在 iframe 内注入双击监听（`data-tappy-point-reader="v7"`），通过 `postMessage` 通知父页面切换全屏；输入框、按钮、链接、视频等交互元素除外，不影响正常操作。

## 二、技术架构

```
浏览器 (tappyread.html / index.html / showfirst.html)
   │  REST /api/*（Bearer token / Cookie）
   ▼
Express 服务 (server/server.js) 或 Vercel 云函数 (api/*)
   ├── MySQL (TiDB Cloud)：users / sessions / user_libraries 表
   └── 腾讯云 COS：绘本图片存储（jpeg/u{userId}_*）
```

- 认证：登录后颁发 32 字节随机 token，sha256 哈希存 `sessions` 表；请求带 `Bearer token` 或 `tappyread_session` Cookie。
- 目录同步：`PUT /api/library` 全量保存，`GET /api/library` 恢复。
- 图片上传：`POST /api/upload/image`（body: `{fileName, dataUrl}`）。
- 图片删除：`POST /api/images/delete`（body: `{keys: [...]}`，仅允许删除当前用户前缀的对象）。

## 三、数据库初始化

在 TiDB Cloud（或其他 MySQL 8.0+）中执行 `tappyread.sql`，会创建：

- `users`（id, username, password, created_at）
- `sessions`（token_hash, user_id, expires_at）
- `user_libraries`（user_id 主键, library_json, collapsed_json, selected_folder_id, current_story_id）

## 四、本地运行

1. 安装依赖：

```bash
npm install
```

2. 复制 `.env.example` 为 `.env`，填写：

| 变量 | 说明 |
| --- | --- |
| `MYSQL_HOST` / `MYSQL_PORT` | TiDB Cloud 连接地址 |
| `MYSQL_USER` / `MYSQL_PASSWORD` | 数据库账号密码 |
| `MYSQL_DATABASE` | 库名，默认 `tappyread` |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | **腾讯云 API 密钥**（控制台 → 访问管理 → API 密钥管理）。**必填**，否则图片上传/删除接口返回 503，但其余功能不受影响 |
| `COS_BUCKET` / `COS_REGION` / `COS_IMG_DIR` | 存储桶信息，默认已填好（`tappyreadjpeg-1325106148` / `ap-guangzhou` / `jpeg`） |

> ⚠️ `COS_SECRET_ID` / `COS_SECRET_KEY` 属于敏感凭据，只可放在后端 `.env`，切勿提交到公开仓库或写进 HTML。

3. 启动：

```bash
npm start
```

4. 浏览器访问 `http://localhost:3000` → 注册账号 → 登录 → 开始使用。

## 五、部署到 Vercel（可选）

项目内置 `api/` 目录（Vercel Serverless 版接口，与本地 Express 行为一致），可直接托管前端 + 接口：

1. 导入仓库到 Vercel，Framework Preset 选择 **Other**。
2. 在 Vercel 项目设置 → Environment Variables 中配置与 `.env` 相同的变量（`MYSQL_*`、`COS_*`、`SESSION_DAYS`）。
3. `cos-nodejs-sdk-v5` 已在 `package.json` dependencies 中，Serverless 环境会自动安装。
4. 部署后访问 `https://你的域名`。

注意：Vercel 无 `MYSQL_SSL_CA` 文件时，连接使用 `ssl: { rejectUnauthorized: false }`（`api/_mysql.js` 已内置）。

## 六、使用流程

1. **注册/登录**：`index.html` 注册账号，登录成功后自动进入阅读器。
2. **导入绘本目录**：目录区左上角「📥 导入」→ 选择备份 JSON 文件（含图片数据的备份会自动补传 COS）。
3. **新增绘本 / 添加绘本页面**：选择绘本 →「➕ 添加页面」选择图片（OCR 自动识别文本）→「全部加入」，图片异步上传 COS。
4. **批量导入绘本**：「📦 批量导入」选择多张/多组图片 → 预览确认 → 导入，每本绘本的图片自动上传 COS。
5. **删除绘本**：右键/删除按钮删除绘本，其 COS 图片同步删除。
6. **HTML 绘本**：双击页面任意位置进入全屏，单击单词发音/查词（点读）。

## 七、常见问题

- **图片不显示？** 确认 `.env` 已配置 `COS_SECRET_ID`/`COS_SECRET_KEY` 并重启服务；老数据若页面上没有 `cosKey`，可重新导入备份（自动补传）或重新添加页面。
- **多账号数据串了？** 本版本已按用户隔离：登录后所有 localStorage 键带 `:userId` 后缀，云端按 `user_id` 存取，不会串。
- **COS 删除失败？** 只有当前用户前缀（`jpeg/u{userId}_`）的图片才会被删除，这是防越权的安全设计。
