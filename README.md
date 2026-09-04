# tappyread — 点读绘本阅读器（前端直传 COS 版）

基于 Node.js + Express + MySQL（TiDB Cloud）的绘本阅读应用，支持账号注册/登录、绘本目录云端同步（COS JSON）、图片/HTML 前端直传腾讯云 COS、HTML 绘本双击全屏点读。

## 一、本次优化：三个上传问题的根因与终极方案

### 问题 1：COS 对上传文件有最大限制吗？

**没有实质限制。** 腾讯云 COS 简单上传（putObject）单个对象上限 **5GB**，对 JSON / JPEG / HTML 均一视同仁，6MB 的 JSON 对 COS 来说微不足道。**真正卡住的不是 COS，而是中间的中转层**（见下）。

### 问题 2：6MB+ 的目录 JSON 传不上去，600KB 的可以？

**根因：Vercel Serverless Functions 有 4.5MB 的请求体硬上限（平台限制，无法调大）。**
旧链路是：浏览器 →（把整个目录 JSON 塞进 HTTP 请求体）→ Vercel 函数 → COS。
- 600KB 的 `json/admin.json`：低于 4.5MB → 成功（已在桶里验证到）。
- 6MB+ 的目录：请求还没进函数就被 Vercel 网关以 413 拒绝 → COS 上根本没有这个文件（桶里也验证了：不存在大文件）。
- 次要因素：`vercel.json` 里 `maxDuration: 10`（函数最多跑 10 秒）与代码里 COS 客户端 `Timeout: 8000`（8 秒硬超时），大文件转传随时被掐断。

### 问题 3：一键生成后 HTML 没上传到 COS，目录也没更新？

**两个叠加的根因：**
1. **Vercel 侧缺少 `api/upload/html.js` 接口**——前端调用 `POST /api/upload/html` 直接 404，HTML 上传永远失败（桶里 `html/` 目录至今是空的，已验证）。
2. HTML 上传失败后，代码**静默回退为"整段 HTML 内联进目录 JSON"**，目录瞬间膨胀到几十 MB → `PUT /api/library` 触发 4.5MB 上限失败 → **保存目录这步也失败**，所以目录"没有更新"。

### 终极方案：前端直传 COS（已实施）

```
旧链路（受限）：浏览器 ──6MB 请求体──> Vercel/Express ──转传──> COS
                             ↑ 4.5MB 上限 / 10s 时长 / 8s 超时，全部卡在这

新链路（直传）：浏览器 ──putObject 直连 COS（文件体不经过任何后端）──> COS
                    │
                    └──签名: GET /api/cos/auth（只传 Method+Key，几百字节）
```

- 前端引入 `cos-js-sdk-v5`（本地 `vendor/cos-js-sdk-v5.min.js`，不走 CDN），浏览器**直接**向 COS 上传 JSON / JPEG / HTML。
- 后端只提供两个**轻量**接口（请求体只有几十字节，永远不可能触发 4.5MB 限制）：
  - `GET /api/cos/config`：返回桶名/地域/当前用户目录 JSON 键（**不含密钥**）。
  - `GET /api/cos/auth`：按请求的 `Method + Key` 实时计算 COS 签名（**密钥只留在服务端**，安全性等同后端中转）。
- 目录保存：前端直传 `json/{用户名}.json` 到 COS，不再把目录数据塞进 `PUT /api/library`（该接口保留为降级兜底）。
- 目录加载：前端签名 GET 直接从 COS 读 `json/{用户名}.json`，大目录加载也绕开函数响应体积限制；找不到再走 `GET /api/library` 兼容旧命名文件。
- 一键生成：**保持原始业务逻辑**——选中的 HTML 在分析阶段直传 COS `html/` 目录 1 次（每本书 1 个整文件，用于标准化分页源码与删除清理）；确认生成时裁剪出的每一页 HTML **不再逐个上传**，直接内联进目录，渲染时注入点读脚本后用 `srcdoc` 显示（与历史版本行为一致）。
- 直传不可用时（如未配密钥）自动降级回后端中转（现已补齐 Vercel 版 `api/upload/html.js`），功能不中断。
- 防越权：签名接口只允许当前用户前缀（`jpeg/u{userId}_`、`html/u{userId}_`）或本人的 `json/{用户名}.json`，无法给别人的对象签名或删除别人的文件。

**该方案对三个问题的效果：**

| 问题 | 是否解决 | 说明 |
| --- | --- | --- |
| 1. COS 限制 | ✅ | 本来就不是 COS 的限制；直传后简单上传 5GB 上限内任意大小 |
| 2. 6MB JSON | ✅ | 文件体直接从浏览器到 COS，不再经过 4.5MB 网关；目录 JSON 无论多大都能直传成功 |
| 3. HTML 未上传/目录未更新 | ✅ | 一键生成的整文件直传不再依赖缺失的 `api/upload/html.js`（顺带也补齐了兜底接口）；目录保存走直传，必然成功 |

## 二、必做一次性配置：COS 存储桶 CORS（直传前提）

浏览器直传是跨域请求，必须在 COS 控制台为桶 `tappyreadjpeg-1325106148` 配置 CORS 规则：

1. 打开 [COS 控制台](https://console.cloud.tencent.com/cos) → 存储桶 `tappyreadjpeg-1325106148` → **安全管理 / 跨域访问 CORS 设置** → 添加规则：
   - **来源 Origin**：`http://localhost:3000` 和你的 Vercel 域名（如 `https://xxx.vercel.app`），或图省事填 `*`
   - **操作 Methods**：`GET, PUT, POST, HEAD, DELETE`
   - **Allow-Headers**：`*`
   - **超时 Max-Age**：`600`
2. 保存即生效（无需重启）。

> 没配 CORS 时：页面仍可正常加载已有图片（防盗链不拦 `<img>`），但直传会失败并自动降级回后端中转（6MB+ 大文件仍会受限）。所以**请务必配置**。

## 三、技术架构

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

## 四、数据库初始化

在 TiDB Cloud（或其他 MySQL 8.0+）中建表：`users`（id, username, password, created_at）、`sessions`（token_hash, user_id, expires_at）。
（绘本目录存于 COS JSON，不再依赖 `user_libraries` 表。）

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
4. `npm start` → 访问 `http://localhost:3000` → 注册 → 登录。

> ⚠️ 密钥只放在后端 `.env`（或 Vercel 环境变量），**永远不会下发到前端**——前端拿到的是每次请求的实时签名，泄露面与后端中转方案完全一致。

## 六、部署到 Vercel

1. 导入仓库，Framework Preset 选 **Other**。
2. Environment Variables 配置与 `.env` 相同的变量（`MYSQL_*`、`COS_*`、`SESSION_DAYS`）。
3. 部署后访问域名。文件上传/下载直连 COS，**不再受 Vercel 4.5MB 请求体限制**；函数只处理登录与签名等轻量请求。

## 七、使用流程

1. **注册/登录** → 自动进入阅读器。
2. **导入目录**：「📥 导入」选择备份 JSON；含 Base64 图片的备份自动补传 COS。
3. **批量导入绘本 / 新增绘本 / 添加页面**：确认导入后图片**直传** COS `jpeg/`，进度条显示进度。
4. **一键生成**：选择 HTML 文件 → 分析（整文件直传 COS `html/` 1 次，本地分页裁剪）→ 确认生成（裁剪页内联进目录，**不逐页上传**，与历史逻辑一致）。
5. **刷新/换设备**：自动从 COS 重新加载你的目录（按用户隔离）。
6. **删除绘本**：COS 上的对应图片/HTML 同步删除。

## 八、常见问题

- **直传失败/一直走降级？** 检查：① `.env` 或 Vercel 环境变量是否配了 `COS_SECRET_ID/KEY`；② COS 桶 CORS 是否按「二」配置（控制台报 CORS 错即此因）；③ 浏览器控制台网络面板看 `GET /api/cos/auth` 是否 200。
- **6MB+ 目录还是传不上？** 确认不是走了降级链路（控制台会有"回退后端中转"警告）；直传模式下 COS 简单上传上限 5GB，不存在 4~6MB 失败的场景。
- **老目录数据在哪？** 旧版命名的 `json/{用户名}_绘本目录.json` 会在下次保存时自动清理合并到标准位置。
- **图片不显示？** 老数据页面无 `cosKey` 时，重新导入备份（自动补传）即可。
