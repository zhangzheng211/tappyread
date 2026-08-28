# tappyread

## Supabase 后端

项目现在使用 Node.js + Express + Supabase 保存账号、登录会话和绘本目录。

1. 在 Supabase Dashboard 的 SQL Editor 执行 `database/supabase.sql`。
2. 复制 `.env.example` 为 `.env`，填写 Supabase URL、服务端 `service_role` key 和匿名 key。
3. 安装依赖并启动：

```bash
npm install
npm start
```

浏览器访问 `http://localhost:3000`。`service_role` key 只能放在后端 `.env`，不能放进 HTML 或公开仓库。Supabase Authentication 用户登录时，后端会将其同步到自建的 `public.users` 表。

### 导入原有账号

先执行数据库脚本并配置 `.env`，然后运行：

```bash
npm run migrate:user
```

脚本默认读取项目根目录的 `user` 文件，也可以传入其他文件路径。导入后登录验证由 Supabase 的 `users` 表完成，密码以 bcrypt 哈希保存。用户第一次登录后，当前浏览器中的本地绘本目录会同步到该账号；之后目录读写均按账号保存。

生产环境请将 `NODE_ENV` 设置为 `production` 后通过 HTTPS 部署。