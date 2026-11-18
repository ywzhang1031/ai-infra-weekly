# 订阅配置与首次开放

## RSS

订阅入口为 `/subscribe/`，RSS 为 `/feed.xml`。每一期的 GUID 是永久期刊 URL，发布日期使用期号对应的周一 08:30（Asia/Shanghai）。不要因部署、补发或订阅页改版而刷新旧期的 GUID 或日期。

RSS 包含标题、摘要和网页链接。浏览器直接打开 XML 不等于完成订阅，读者需把地址添加到自己的 RSS 阅读器。复制按钮失败时，仍可手动复制可见地址。

## 邮件订阅

在 Buttondown 建立属于自己的 newsletter 后，将真实订阅页填入 `site-config.json`：

```json
{
  "subscriptions": {
    "buttondownUrl": "https://buttondown.com/ai-infra-weekly",
    "buttondownStatus": "active"
  }
}
```

使用时请保留已有 `title`、`baseUrl` 和其他订阅配置。占位地址不能进入生产；没有 `buttondownUrl` 时，站点不显示邮件按钮，也不收集邮箱。`buttondownStatus` 仅允许 `pending_review` 或 `active`，省略时兼容既有配置，按 `active` 展示。

2026-11-18 已核验 AI Infra Weekly 审核通过：官方批准通知之后没有更新的暂停或拒绝通知，刷新登录后台后不再显示审核或暂停限制，匿名访问真实订阅页返回 HTTP 200，名称及邮箱订阅表单均正确。因此将入口切换为 `active`。此前审核期间的 404 已解除。

后续恢复入口时，同样须确认账号已获 Buttondown 批准、后台没有审核或暂停限制，且匿名访问订阅页返回 HTTP 200 并显示属于 AI Infra Weekly 的订阅表单，再使用 `active` 并验证发布。页面开通与邮件发送分别验收；后续内容由编辑审核发布，未购买套餐、未启用周报自动发送。

2026-11-18 已使用所有者本人邮箱完成真实订阅：确认邮件和默认欢迎邮件均进入收件箱，点击确认链接后，Buttondown 显示订阅成功。默认欢迎邮件没有周报正文入口；这次核验不能作为某一期周报已经投递的证据。仅向本人发送正文预览的结果仍待本轮核验，不据此声称已经发送周报。

订阅页直接提供 `/latest/` 与 `/#archive` 阅读入口。`/latest/` 每次构建都复用最新公开期刊正文，canonical 指向该期 `/weeks/YYYY-MM-DD/` 永久地址；每期邮件仍应使用对应日期永久链接。RSS 的 GUID、发布日期及 sitemap 继续使用原有永久地址，不随欢迎邮件或入口调整而改变。

2026-11-18 已在 Buttondown 后台确认，自定义欢迎邮件等 transactional email 需要 Standard 或更高套餐，当前账号显示升级入口。本轮未升级套餐、未修改默认欢迎模板。订阅页明确确认/欢迎邮件与期刊正文的区别，并提供可立即阅读的入口。不得为修改模板自动购买套餐，也不得向已有订阅者批量重发欢迎邮件。套餐能力说明见 [Buttondown welcome email 文档](https://docs.buttondown.com/transactional-emails-welcome)。

本网站只链接到 Buttondown 的官方订阅页，不存储邮箱或邮件 API token。订阅确认、退订与发信由 Buttondown 管理；本地按钮不会伪造成功状态。

如开通 RSS-to-email：使用真实生产 feed，先选择生成草稿，并跳过已有历史条目。先检查草稿的日期、摘要与可访问链接，确认不会向新订阅者批量发送历史六期。自动化可能需要付费套餐；购买或启用自动发送需由所有者决定。仅添加订阅页链接不会自动启用发信。

官方说明：
- https://docs.buttondown.com/building-your-subscriber-base
- https://docs.buttondown.com/rss-to-email

## GitHub

公开仓库创建、内容推送并核验后，填写真实的 `subscriptions.githubUrl`。网站会说明 `Watch → Custom → Releases`，并提供 Releases 链接；Star 仅用于收藏。

每期必须先通过站点生产哈希验收，再发布对应 GitHub Release。Release 标题使用期号，正文包含本期摘要、生产期刊链接与来源覆盖说明。补齐历史期时避免创建大量通知；首发可只为最新一期创建一条 Release，历史仍从网页归档阅读。

只在确认仓库存在且发布方式已建立后启用 GitHub 入口。GitHub 身份、权限与发信设置由仓库所有者及订阅者管理。

## 发布与通知的边界

本地构建完成、Cloudflare 已接收部署、生产校验通过、GitHub Release 已发布、邮件已发送是不同状态。记录实际完成的步骤；失败时保留待恢复状态，不能用旧成功记录替代本次结果。
