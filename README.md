# tappyread — 点读绘本阅读器（前端直传 COS 版）
基于 Node.js + Express + MySQL（TiDB Cloud）的绘本阅读应用，支持账号注册/登录、绘本目录云端同步（COS JSON）、图片/HTML 前端直传腾讯云 COS、HTML 绘本双击全屏点读。

## 一、本次优化：注册默认绘本超时 + Chrome 朗读异常

### 1. 新用户默认绘本改为“浏览器直读 COS”

注册接口现在只完成 MySQL 用户、Session 和后台日志写入，不再等待 `json/start.json` 下载和复制。新用户进入阅读器后：

1. 浏览器通过轻量 `/api/cos/config` 获取当前用户的 COS 对象键和 `json/start.json` 模板键；
2. 浏览器通过 `/api/cos/auth` 获取短期签名；
3. `json/{用户名}.json` 与 `json/start.json` 的 JSON 文件体直接在“浏览器 ↔ COS”之间传输，不经过 Vercel；
4. 用户目录不存在时才读取 `json/start.json`，首屏立即使用模板；随后异步写入自己的用户目录，不阻塞阅读器；
5. 已有用户网络异常时优先保留 IndexedDB 缓存，不会把现有绘本误判成空目录。

因此，截图中 `/api/auth/register` 因等待 COS 导致的约 8 秒请求链路被彻底移除。

### 2. Chrome 朗读稳定性

- 删除每 6 秒强制 `pause()/resume()` 的“续命”定时器，避免它反过来打断正常朗读；
- `cancel()` 后增加短暂间隔再 `speak()`；
- 单句朗读增加 4.5 秒启动看门狗，静默失败自动重试 1 次；
- 跨页连续朗读同样增加看门狗和重试，不会因某一句没有触发 `onend` 而永久卡死；
- 标签页重新恢复可见时只执行 `resume()`；
- HTML 点读页内置脚本同步采用同样策略。


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
   | `COS_TEMPLATE_KEY` | 默认 `json/start.json`，新用户默认绘本模板 |

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
2. Environment Variables 配置与 `.env` 相同的变量（`MYSQL_*`、`COS_*`、`TENCENT_TTS_*`、`SESSION_DAYS`）。
3. 部署后访问域名。文件上传/下载直连 COS，**不再受 Vercel 4.5MB 请求体限制**；函数只处理登录与签名等轻量请求。

## 七、使用流程

1. **注册/登录** → 注册接口立即返回；新用户进入阅读器后由浏览器直读 COS `json/start.json` 作为默认绘本，并异步初始化自己的 `json/{用户名}.json`，同时记录 loginlog。
2. **导入目录**：「📥 导入」选择备份 JSON；含 Base64 图片的备份自动补传 COS。
3. **批量导入绘本 / 新增绘本 / 添加页面**：确认导入后图片**直传** COS `jpeg/`，进度条显示进度。
4. **一键生成**：选择 HTML 文件 → 分析（整文件直传 COS `html/` 1 次，本地分页裁剪）→ 确认生成（裁剪页内联进目录，**不逐页上传**，与历史逻辑一致）。(暂时隐藏了html绘本导入的“添加HTML绘本”按钮，该功能暂时不开放！)
5. **刷新/换设备**：自动从 COS 重新加载你的目录（按用户隔离）。
6. **删除绘本**：COS 上的对应图片/HTML 同步删除。

## 八、V9 语音朗读优化（腾讯云 TTS，默认英语男声）

### 1. 背景与目标

浏览器原生 `speechSynthesis` 在国内网络环境下存在语音库不稳定、依赖 `Google UK English Male`（国内网络无法稳定访问）、不同系统/浏览器效果差异大、连续朗读后偶发失声等问题。V9 起新增腾讯云语音合成（TTS）作为**默认**朗读引擎，浏览器本地语音降级为**备用**引擎，具体见《V9 语音朗读优化改造需求说明.docx》。

### 2. 架构

```
用户点击文字/单词
      │
      ▼
tappyread.html  →  speakText(text) / speakOne(text) / speakSequence(items)
      │                 │
      │        ① 默认：POST /api/tts（服务端代理，密钥不下发前端）
      │                 │→ 腾讯云语音合成 TextToVoice（英语男声 WeJack）
      │                 │→ 返回 base64 MP3 → 浏览器 <audio> 播放
      │
      └── ② 腾讯云异常/超时/未配置 → 自动降级 → 浏览器 speechSynthesis（原有稳定性修复全部保留）
```

- `/api/tts`（Vercel 云函数）与 `server/server.js` 的 `POST /api/tts`（本地开发）逻辑一致，均要求登录（`authenticate`），密钥只从环境变量读取。
- 前端内置内存音频缓存（同一段文本+同一语速重复朗读直接复用，无需重新请求），并支持可选的腾讯云 COS 音频持久化缓存（见下）。
- 长文本会在浏览器端按句子边界自动切分为多段，分别合成后连续播放，规避腾讯云单次合成字数上限。
- 连续失败达到阈值后进入约 1 分钟的"冷却期"，冷却期内直接使用本地语音，避免反复等待超时影响体验；点击「🔄 重置语音」按钮会立即清除冷却、停止当前播放并重新初始化两套引擎。

### 3. 必需的环境变量

| 变量 | 说明 |
| --- | --- |
| `TENCENT_TTS_SECRET_ID` / `TENCENT_TTS_SECRET_KEY` | 腾讯云 API 密钥（控制台 → 访问管理 CAM → API 密钥管理）。**必填**，否则 `/api/tts` 返回 503 |
| `TENCENT_TTS_APP_ID` | 语音合成应用 AppId（控制台 → 语音合成 → 应用管理），当前基础合成接口不强制使用，预留给后续长文本异步合成等扩展 |

可选高级配置（不填使用默认值）：`TENCENT_TTS_REGION`（默认 `ap-guangzhou`）、`TENCENT_TTS_VOICE_TYPE`（默认 `1050`=WeJack 英文男声标准音色）、`TENCENT_TTS_VOLUME`（默认 `8`，范围 -10~10，数值越大越响）、`TENCENT_TTS_CACHE`（默认开启，填 `0` 关闭 COS 缓存）、`TENCENT_TTS_CACHE_DIR`（默认 `audio`）。

> 开通语音合成服务：[腾讯云控制台 → 语音合成 TTS](https://console.cloud.tencent.com/tts) → 新建应用即可获得 AppId；密钥与 COS 共用同一套「访问管理 CAM → API 密钥管理」，也可以单独为 TTS 创建一组子账号密钥并只授予 `QcloudTTSFullAccess` 权限，遵循最小权限原则。

### 4. 音色、音量与语速

- 默认音色：`VoiceType=1050`（WeJack，英文男声，标准音色，账号无需额外开通）。如已开通精品/大模型音色，可将 `TENCENT_TTS_VOICE_TYPE` 改为 `101050`（WeJack 精品）或 `501008`（WeJames 大模型，音质更自然清晰）等，完整音色表见腾讯云文档「语音合成 → 音色列表」。
- **音量**：`TENCENT_TTS_VOLUME`，范围 `-10 ~ 10`，`0` 为腾讯云的默认音量（实测偏小，是"声音有点小"反馈的直接原因）。已把默认值调高到 `8`，比原始默认音量明显更响；如果觉得还不够大声或者出现了轻微失真，可以在环境变量里继续微调（`9`、`10` 更响，但失真风险也更高；调小则更保守）。修改后需要重启本地服务（`npm start`）或在 Vercel 上 Redeploy 才会生效。
- 语速沿用页面原有的语速滑块（0.6～1.1，1.0 为正常速度），服务端按腾讯云 `Speed` 参数区间（[-2, 6]，每 0.2 倍速对应 1 档）等比换算，浏览器备用引擎与腾讯云音色的听感语速基本保持一致。

### 5. 音频缓存（可选，需要额外的 COS 权限）

同时配置了 `COS_SECRET_ID` / `COS_SECRET_KEY` 时，`/api/tts` 会在同一个 COS 桶下按 `audio/{文本+音色+语速哈希}.mp3` 缓存已合成的音频：命中缓存直接返回，未命中则调用腾讯云合成后异步写入缓存（不阻塞本次播放）。这能显著降低重复朗读（同一页反复点读）时的腾讯云调用次数、加快后续播放速度。不需要该能力时设置 `TENCENT_TTS_CACHE=0` 关闭。

### 6. 音色下拉框："腾讯云 TTS 英语男声"作为第一项、可自由切换

页面右上角原有的"音色"下拉框（`#voiceSelect`）第一项固定为 **腾讯云 TTS 英语男声（推荐）**，默认选中：

- 选中该项时，朗读走腾讯云 TTS（异常时仍会自动降级为浏览器语音，见上文）。
- 选中列表中其他任意浏览器语音（如 `Google UK English Male`）时，**完全按原来的方式朗读**，不会请求 `/api/tts`，也不受腾讯云冷却期影响——相当于把 TTS 功能整体关闭，回到改造前的行为。
- 用户的选择会记录在浏览器 `localStorage`（键名 `tappyread_voice_pref`），下次打开页面自动沿用。

### 7. 冷启动 / 首次朗读延迟优化

Vercel 上 `/api/tts` 是独立的 Serverless 函数，长时间无请求后容器会被回收，下一次调用需要重新冷启动、重新建立数据库连接，是"部署到 Vercel 后第一次朗读要等几秒"的主要原因（尤其当数据库与 Vercel 部署区域不在同一地理区域时，首次建连耗时更明显）。本次已加入以下优化：

- **预热请求**：页面加载后（及此后每 4 分钟，仅在页面可见时）会自动发送一次 `{warmup:true}` 的轻量请求到 `/api/tts`，只做登录校验和数据库连接，不调用腾讯云、不计入朗读次数，提前把容器"叫醒"，让用户真正点读时无需等待冷启动。
- **按需加载 COS SDK**：只有真正开启了音频缓存时才会加载 COS SDK，减少未使用缓存场景下的冷启动体积。
- **缓存查询超时保护**：COS 缓存查询设置 600ms 超时，查询变慢时直接当作未命中处理，避免"缓存本该更快"反而拖慢整体响应。
- **耗时排查**：将环境变量 `TTS_DEBUG_TIMING` 设为 `1` 后，Vercel 函数日志（Vercel 控制台 → 项目 → Logs）会打印鉴权、缓存查询、腾讯云合成、总耗时等各阶段耗时，便于进一步定位具体哪个环节慢。

> 预热请求无法完全消除冷启动（容器仍可能因 Vercel 资源调度被回收，尤其 Hobby 免费套餐的资源保留时间更短），但能覆盖绝大多数"打开页面后正常阅读"的场景。如果需要更强的保障（几乎不出现冷启动），可以考虑升级到 Vercel Pro 套餐并配置 Cron Job 定时（每几分钟）访问一个轻量接口保持容器常驻，或将数据库迁移到与 Vercel 部署区域更近的地域以缩短建连耗时。

### 8. 兼容性与安全

- 已验证兼容 Chrome / Edge，且不依赖 VPN、代理或本地安装语音包；腾讯云异常时自动无缝降级，不影响原有点读、单句朗读、整页朗读、自动翻页朗读、语速控制、语音选择、暂停/继续/停止等既有功能。
- `SecretId` / `SecretKey` 全程只存在于服务端环境变量中，前端与浏览器网络面板都无法看到；`/api/tts` 与其他业务接口一样要求登录态，并做了简单的按用户限流，避免异常调用导致腾讯云账单激增。
- 说明：为「一键生成绘本」导出的**独立 HTML 点读页**（脱离本应用、可单独打开的 HTML 文件）目前仍使用浏览器 `speechSynthesis`，未接入腾讯云 TTS——这类独立文件没有后端会话，若要接入需额外设计免登录/限量的公开代理接口，超出本次改造范围，如有需要可在后续版本中单独实现。

## 九、常见问题

- **直传失败/一直走降级？** 检查：① `.env` 或 Vercel 环境变量是否配了 `COS_SECRET_ID/KEY`；② COS 桶 CORS 是否按「二」配置（控制台报 CORS 错即此因）；③ 浏览器控制台网络面板看 `GET /api/cos/auth` 是否 200。
- **6MB+ 目录还是传不上？** 确认不是走了降级链路（控制台会有"回退后端中转"警告）；直传模式下 COS 简单上传上限 5GB，不存在 4~6MB 失败的场景。
- **老目录数据在哪？** 旧版命名的 `json/{用户名}_绘本目录.json` 会在下次保存时自动清理合并到标准位置。
- **图片不显示？** 老数据页面无 `cosKey` 时，重新导入备份（自动补传）即可。
