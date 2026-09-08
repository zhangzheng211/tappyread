# tappyread — 点读绘本阅读器（前端直传 COS 版）
基于 Node.js + Express + MySQL（TiDB Cloud）的绘本阅读应用，支持账号注册/登录、绘本目录云端同步（COS JSON）、图片/HTML 前端直传腾讯云 COS、HTML 绘本双击全屏点读。

## 一、本次优化：三个上传问题的根因与终极方案

## 二、技术架构

```
浏览器 (tappyread.html / index.html / showfirst.html)
   │  认证/目录元数据：REST /api/*（Bearer token / Cookie，均为轻量请求）
   │  文件体：cos-js-sdk-v5 直传/直读 COS（签名来自 /api/cos/auth）
   ▼
Express 服务 (server/server.js) 或 Vercel 云函数 (api/*)
   ├── MySQL (TiDB Cloud)：users / sessions 表（账号与会话）
   └── 腾讯云 COS：
        ├── json/{用户名}.json        —— 绘本目录（前端直传/直读）
        ├── jpeg/u{userId}_*.{jpg…}  —— 图片绘本页（前端直传）
        └── html/u{userId}_*.html    —— 一键生成分析阶段的整文件（每本书 1 个，含点读脚本注入见渲染侧）
```

- 认证：登录后颁发 32 字节随机 token，sha256 哈希存 `sessions` 表；请求带 `Bearer token` 或 `tappyread_session` Cookie。
- 直传签名：`GET /api/cos/auth?method=PUT&key=jpeg/u5_xxx.jpg` → `{Authorization}`（600 秒有效，仅限本人对象键）。
- 删除：`POST /api/images/delete`（body: `{keys}`，仅允许删除当前用户前缀的对象）。

## 三、必做一次性配置：COS 存储桶 CORS（直传前提）
网页地址：https://console.cloud.tencent.com/cos/bucket?bucket=tappyreadjpeg-1325106148&region=ap-guangzhou&path=%252Fjson%252F
使用微信账号关联登录
浏览器直传是跨域请求，必须在 COS 控制台为桶 `tappyreadjpeg-1325106148` 配置 CORS 规则：

1. 打开 [COS 控制台](https://console.cloud.tencent.com/cos) → 存储桶 `tappyreadjpeg-1325106148` → **安全管理 / 跨域访问 CORS 设置** → 添加规则：
   - **来源 Origin**：`http://localhost:3000` 和你的 Vercel 域名（如 `https://xxx.vercel.app`），或图省事填 `*`
   - **操作 Methods**：`GET, PUT, POST, HEAD, DELETE`
   - **Allow-Headers**：`*`
   - **超时 Max-Age**：`600`
2. 保存即生效（无需重启）。

> 没配 CORS 时：页面仍可正常加载已有图片（防盗链不拦 `<img>`），但直传会失败并自动降级回后端中转（6MB+ 大文件仍会受限）。所以**请务必配置**。

## 四、数据库初始化
网页地址：https://tidbcloud.com/tidbs/10361392845639587237/sqleditor?orgId=1372813089209357031
使用github账号登录
在 TiDB Cloud（或其他 MySQL 8.0+）中建表：
`users`（id, username, password, created_at）：存储注册/登录的用户信息
`loginlog`id, username, action,action_time,duration_seconds,ip,ip_region,created_at）：存储注册/登录用户的登录日志，可用户分析网站使用情况
`user_libraries`：已弃用（绘本目录存于 COS JSON，不再依赖 `user_libraries` 表。）
`sessions`（token_hash, user_id, expires_at,created_at）：存储注册/登录用户的token信息   
以下是方便执行的sql脚本
   USE tappyread;
   SELECT * FROM `tappyread`.`users` LIMIT 100;
   SELECT * FROM `tappyread`.`loginlog` LIMIT 100;
   SELECT * FROM `tappyread`.`user_libraries` LIMIT 100;
   SELECT * FROM `tappyread`.`sessions` LIMIT 100;
   DELETE FROM users;
   DELETE FROM user_libraries;
   DELETE FROM loginlog;
   DELETE FROM sessions;

## 五、本地运行

1. 安装依赖：`npm install`
2. 复制 `.env.example` 为 `.env`，填写：

   | 变量 | 说明 |
   | --- | --- |
   | `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | TiDB Cloud 连接信息 |
   | `COS_SECRET_ID` / `COS_SECRET_KEY` | **腾讯云 API 密钥**（控制台 → 访问管理 → API 密钥管理）。**必填**，否则直传与中转上传都不可用 |
   | `COS_BUCKET` / `COS_REGION` | 默认 `tappyreadjpeg-1325106148` / `ap-guangzhou` |
   | `COS_IMG_DIR` / `COS_HTML_DIR` / `COS_JSON_DIR` | 默认 `jpeg` / `html` / `json` |

3. 按「二」配置 COS CORS。
   图片绘本存储地址：https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/jpeg/
   绘本目录存储地址：https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/json/
   html绘本存储地址：https://tappyreadjpeg-1325106148.cos.ap-guangzhou.myqcloud.com/html/
   注意：暂时隐藏了html绘本导入的“添加HTML绘本”按钮，该功能暂时不开放！

4. `npm start` → 访问 `http://localhost:3000` → 注册 → 登录。

> ⚠️ 密钥只放在后端 `.env`（或 Vercel 环境变量），**永远不会下发到前端**——前端拿到的是每次请求的实时签名，泄露面与后端中转方案完全一致。

## 六、部署到 Vercel
网页地址：https://vercel.com/zz-4651/tappyread/AkZmLMwGenQtY9uSiBZ8oMKNYTGz/logs?refreshedAt=1788832171236
使用github账号登录
1. 导入仓库，Framework Preset 选 **Other**。
2. Environment Variables 配置与 `.env` 相同的变量（`MYSQL_*`、`COS_*`、`SESSION_DAYS`）。
3. 部署后访问域名。文件上传/下载直连 COS，**不再受 Vercel 4.5MB 请求体限制**；函数只处理登录与签名等轻量请求。

## 七、使用流程

1. **注册/登录** → 自动进入阅读器，新注册的用户默认加载cos上json目录下的start.json绘本目录，并记录loginlog表日志。
2. **导入目录**：「📥 导入」选择备份 JSON；含 Base64 图片的备份自动补传 COS。
3. **批量导入绘本 / 新增绘本 / 添加页面**：确认导入后图片**直传** COS `jpeg/`，进度条显示进度。
4. **一键生成**：选择 HTML 文件 → 分析（整文件直传 COS `html/` 1 次，本地分页裁剪）→ 确认生成（裁剪页内联进目录，**不逐页上传**，与历史逻辑一致）。(暂时隐藏了html绘本导入的“添加HTML绘本”按钮，该功能暂时不开放！)
5. **刷新/换设备**：自动从 COS 重新加载你的目录（按用户隔离）。
6. **删除绘本**：COS 上的对应图片/HTML 同步删除。

## 八、常见问题

- **直传失败/一直走降级？** 检查：① `.env` 或 Vercel 环境变量是否配了 `COS_SECRET_ID/KEY`；② COS 桶 CORS 是否按「二」配置（控制台报 CORS 错即此因）；③ 浏览器控制台网络面板看 `GET /api/cos/auth` 是否 200。
- **6MB+ 目录还是传不上？** 确认不是走了降级链路（控制台会有"回退后端中转"警告）；直传模式下 COS 简单上传上限 5GB，不存在 4~6MB 失败的场景。
- **老目录数据在哪？** 旧版命名的 `json/{用户名}_绘本目录.json` 会在下次保存时自动清理合并到标准位置。
- **图片不显示？** 老数据页面无 `cosKey` 时，重新导入备份（自动补传）即可。
