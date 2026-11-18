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

2026-11-18 已使用所有者本人邮箱完成真实订阅：确认邮件和默认欢迎邮件均进入收件箱，点击确认链接后，Buttondown 显示订阅成功。默认欢迎邮件没有周报正文入口；订阅事务邮件与某一期周报的投递分别验收。

同日已在原有 2026-11-16 草稿中保存 Markdown 排版，并通过 Buttondown 仅向所有者本人发送一封 `[PREVIEW]` 测试邮件。实际邮件进入 INBOX，DKIM、SPF、DMARC 均通过；包含绿底白字的全文按钮、三个重点、本期永久链接、最新一期与历史归档入口，以及平台退订和订阅管理链接。从 Gmail 中用键盘激活正文按钮后，已打开并核验当期生产页面。该结果仅证明本人测试投递与桌面阅读链路，不代表正式群发或真实手机测试。

订阅页直接提供 `/latest/` 与 `/#archive` 阅读入口。`/latest/` 每次构建都复用最新公开期刊正文，canonical 指向该期 `/weeks/YYYY-MM-DD/` 永久地址；每期邮件仍应使用对应日期永久链接。RSS 的 GUID、发布日期及 sitemap 继续使用原有永久地址，不随欢迎邮件或入口调整而改变。

2026-11-18 已在 Buttondown 后台确认，自定义欢迎邮件等 transactional email 需要 Standard 或更高套餐，当前账号显示升级入口。本轮未升级套餐、未修改默认欢迎模板。订阅页明确确认/欢迎邮件与期刊正文的区别，并提供可立即阅读的入口。不得为修改模板自动购买套餐，也不得向已有订阅者批量重发欢迎邮件。套餐能力说明见 [Buttondown welcome email 文档](https://docs.buttondown.com/transactional-emails-welcome)。

每期正文邮件保持单栏短导读：期号与标题、主题标签、一段导读、靠前的“阅读本期完整周报”按钮、最多三个重点、最新一期与历史归档链接，最后保留证据说明及平台退订页脚。主按钮必须使用该期永久地址，避免旧邮件随 `/latest/` 指向新内容。使用 Markdown 标题与保守的内联按钮样式；即使样式被邮箱忽略，也应保留可点击的文字链接。

后续修改邮件时，先仅向所有者本人发送测试，核验实际收件中的正文链接、标题层级和平台退订信息。页面预览、草稿保存、测试邮件送达及正式群发是不同状态；本轮未群发、未付费、未启用自动发送。

2026-11-18 已保存 `After confirming` 重定向至 `/latest/`；离开该设置页并返回后，地址仍保留。General 描述已补充确认订阅说明，以及最新一期和历史归档的 Markdown 链接；刷新后内容仍保留，预览显示实际锚链接。这轮未重新执行新订阅者确认流程，不能据此声称修改后的确认邮件和确认后跳转已完成新的端到端验收。

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
