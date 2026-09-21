# 云爪免费后端

PET FORGE 当前使用 `tencent-cloudbase/` 下的 CloudBase HTTP 函数保存账号、使用次数、订单与纪念资料。`src/` 是旧的 Cloudflare 版本，不是当前网站的运行入口。

发布前需要登录 Cloudflare，然后依次执行：

1. `npx wrangler d1 migrations apply cloud-paw-vip-db --remote`
2. `npx wrangler deploy`

部署成功后，把 Worker 网址写入网站的 `cloud-paw-config.js`，前端即可切换到新后端。

当前购买流程为：用户创建订单 -> 扫站长支付宝二维码 -> 管理员输入订单号确认收款 -> 用户增加 3 次使用次数。公开网页永远不能直接确认订单或增加次数。

手机号注册需要在 CloudBase 函数环境配置腾讯云短信变量：`TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`SMS_SDK_APP_ID`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_ID`，可选 `SMS_REGION`。邮箱注册需要配置 Resend 的 `RESEND_API_KEY` 和已验证的 `EMAIL_FROM`；接口会先发送 6 位验证码，验证成功后才创建账号。未配置短信或邮件服务时，接口会明确返回“验证码服务尚未配置”，不会伪造验证码。
