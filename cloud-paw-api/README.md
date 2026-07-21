# 云爪免费后端

这个目录是 Cloudflare Workers + D1 后端。它用于保存账号、一次性兑换码、会员期限与纪念资料。

发布前需要登录 Cloudflare，然后依次执行：

1. `npx wrangler d1 migrations apply cloud-paw-vip-db --remote`
2. `npx wrangler deploy`

部署成功后，把 Worker 网址写入网站的 `cloud-paw-config.js`，前端即可切换到新后端。

兑换码由管理员通过 D1 写入。公开网页永远不会拥有生成兑换码的权限。
