# 每周公开发布与通知

同一份公开稿驱动网站、RSS、GitHub Release 与待确认的邮件草稿。私人研究材料不进入这个仓库；不要从上层目录执行 `git add .`。

## 首次准备

使用本仓库的 `main` 分支；GitHub 仓库地址位于 `site-config.json` 的 `subscriptions.githubUrl`。站点所有者需要有效的 Cloudflare 与 GitHub 身份。配置邮箱入口前需完成自己的 Buttondown 注册。

## 一期发布

1. 核验 `content/YYYY-MM-DD.json` 的技术内容、原始来源、来源日期与证据局限，`progress=[]`。历史期刊保留。
2. `npm run check`；检查新页面的手机布局与来源链接。
3. 读取 `git status` 和公开稿 diff。自动化只可暂存本期确切 JSON 路径；如果还有其他未提交文件或分支分歧，先停止源码同步并报告，不合入未知改动、不重置或强推。
4. 明确暂存、提交并推送本期：

```sh
git add -- content/YYYY-MM-DD.json
git commit -m "Publish AI Infra Weekly YYYY-MM-DD"
git push origin main
```

已有匹配提交时复用，不创建空提交。没有重新生成周报，也无需重复改动历史稿件。

5. 发布并核验网站：

```sh
npm run deploy -- --expected-week YYYY-MM-DD
```

只有新的 `publication-state.json` 的期号、网址和所有检查通过才继续。发布失败时保留公开稿与源码提交；源码可见不代表期刊网页已上线。

发布命令在全部生产路由验证成功后，自动生成 `.local-maintenance/newsletters/YYYY-MM-DD/draft.md` 与 `manifest.json`，再调用 Buttondown API 保存或复用 Draft。邮件步骤失败只记录待恢复，不撤销网站已验证状态；必须区分网站上线、本地备稿与远端草稿验收。

6. 生产验收后发布对应 Release：

```sh
npm run release -- --expected-week YYYY-MM-DD --dry-run
npm run release -- --expected-week YYYY-MM-DD
```

`--dry-run` 不创建远端 Release/tag，但会运行本地构建和检查。正式命令要求当前源码干净、远端 main 与本地 HEAD 一致、GitHub 身份/仓库匹配且公开、最新公开期号匹配，并重新对照生产哈希。已有对应 Release 时核验后复用，不覆盖标签或重复通知。

7. 将本期邮件保存在 Buttondown 的 Drafts，等待所有者审阅，流程见下节。GitHub Release 失败不阻止已上线期刊准备草稿；网站未通过生产验收则不准备草稿。

## 邮件草稿与人工确认

此步骤只准备草稿，不发送测试邮件、不排期、不点击 Publish 或 Send draft，也不启用 Buttondown 的 RSS-to-email 自动发送。发送给订阅者需要所有者对具体期刊、内容及受众明确确认；保存草稿不构成发送授权。

已上线期刊需要单独恢复 API 草稿同步时运行：

```sh
npm run email:sync -- --expected-week YYYY-MM-DD
```

该命令重新构建和检查公开内容，核对完整生产验收记录及本地产物哈希，再有界校验当期生产正文。发布验收在同一个 curl 进程中依次读取同站路由，复用已验证的 TLS 连接；每个响应独立保存并核对哈希，记录实际连接数与耗时，避免每个路径重新握手。Release 与单独邮件恢复仍读取对应正文。每次连接上限 10 秒、单个请求总上限 20 秒；仅传输超时最多重试一次，批次重试丢弃全部部分结果并从新进程开始，HTTP 非 200、证书错误或内容哈希不符不重试。保持现有代理环境和 TLS 证书校验，不修改系统网络设置。失败记录只含退出码、阶段及耗时，不输出凭据或完整网络响应。它只接受最新、已经发布的公开期号。`deploy` 刚完成全路由验证时复用该结果，不重复请求生产正文。输入只来自 `content/YYYY-MM-DD.json`，`progress=[]`；不读取私人研究报告或学习记录。

模板保留单栏短导读、最多三个当期重点、深绿底白字全文按钮、当期永久链接、最新一期与历史归档、来源覆盖及证据局限。邮件主题在 `manifest.subject`，正文在 `draft.md`；Buttondown 会渲染主题，因此正文不重复添加一级标题。使用 Markdown 编辑模式并保留平台提供的退订页脚。

### 一次性 API 密钥设置

Buttondown [免费套餐支持 API](https://buttondown.com/features/api)。在 [API → Keys](https://buttondown.com/keys) 创建单独的非 Primary key，名称建议 `AI Infra Weekly · Draft only`，API version 为 `2026-04-01`。按 [官方权限文档](https://docs.buttondown.com/api-authentication) 设置：Emails 为 Read & write，Sending 为 Disabled；Subscribers、Automations、Forms、Surveys、Settings、Styling 均为 None。记录实际权限检查，不通过尝试发信验证权限。首次创建与保存凭据由所有者确认；每周任务不得自行创建、扩大或轮换权限。

macOS 自动化从登录钥匙串读取 `service=ai-infra-weekly.buttondown`、`account=ai-infra-weekly`。在自己的终端执行以下命令，然后在隐藏输入提示中粘贴受限 key；不要把 key 写进命令、聊天、仓库或截图：

```sh
security add-generic-password -a ai-infra-weekly -s ai-infra-weekly.buttondown -T /usr/bin/security -w
```

`-w` 必须放在最后，使用隐藏输入；命令不覆盖已有项目。 若通过“钥匙串访问”界面保存，则在这一凭据的“访问控制”中仅将 `/usr/bin/security` 加入始终允许列表，保持“允许所有应用程序访问”关闭。随后用两个独立进程验证读取无需交互，检查退出状态即可，不输出密钥；仅手动点一次“允许”不足以证明无人值守可用。其他运行环境可由所有者在安全 secret 管理器提供 `BUTTONDOWN_API_KEY`，权限必须与上述一致。Cloudflare 静态站点不需要也不会收到该 key。钥匙串锁定、key 撤销或权限不足时保留待恢复状态，不自动回退到浏览器或使用 Primary key。

普通应用允许列表与 Keychain 的签名 partition 检查是两层权限。即使条目允许 `/usr/bin/security`，缺少该工具的 `apple-tool:` partition 仍可能等待系统确认。遇到 `credential_timeout` 时，由所有者在终端手动运行以下无输出命令，并只对这一条目完成系统“始终允许”；不要批量改 partition、允许所有应用、关闭安全检查或复制密钥到文件：

```sh
/usr/bin/security find-generic-password -s ai-infra-weekly.buttondown -a ai-infra-weekly -w >/dev/null
```

自动化保持单次 10 秒读取上限，不循环等待；区分超时、条目不存在、读取被拒与格式异常，不输出原始 stdout/stderr。恢复必须以两个独立进程无交互读取成功为准，而非仅凭界面点击。实现依据见 Apple 的 [partitionIdForProcess](https://github.com/apple-oss-distributions/Security/blob/main/securityd/src/clientid.cpp) 与 [validatePartition](https://github.com/apple-oss-distributions/Security/blob/main/securityd/src/acls.cpp)。

### API 保存与恢复

1. `email:sync` 先执行上面的公开稿、生产记录与在线正文检查。`email:draft` 仍保留为仅生成本地稿的诊断命令，不调用远端。API 阶段只访问固定 `https://api.buttondown.com/v1/emails` 列表与详情，或 POST 到该路径新建 Draft；不提供编辑、删除、发送、排期接口。
2. 读取 `manifest.remote.url` 并核验实际远端身份；按期号检查所有状态的邮件并有界遍历分页，不仅查 API 创建的稿件。排除主题以 `[TEST · 不发送]` 开头或正文包含 `BD-CREATE-` 的测试稿。唯一正式匹配必须有本期期号与永久正文链接；多个匹配、同日期身份冲突或分页覆盖不完整均停止。
3. 已有 Draft 保留主题与正文，包括人工编辑，只更新本地验证记录。已发送或排期的稿件不修改或重建。只在确认本期尚无邮件时创建，payload 仅有 `subject`、带 Markdown 模式注释的 `body`、显式 `status: "draft"`，不含 `publish_date` 或其他发送控制字段。
4. POST 前持久化 `buttondown-create.json` 的随机幂等 UUID 与请求 SHA256；固定 `X-API-Version: 2026-04-01`，用 `X-Idempotency-Key` 绑定该请求。网络结果不明时不自动重发 POST、不生成新 key；恢复先查远端。若仍无法确认该请求结果，保留 pending 等人工核实，不能靠重复新建绕过。
5. 创建后 GET 读回，核对 ID、Draft 状态、主题和正文，才标为 `awaiting_owner_review`。实际远端 URL、正文 SHA256 与 verifiedAt 写回 manifest；人工稿的实际哈希与生成稿分开。API 错误保存在 `buttondown-sync-error.json`，入口失败另存 `sync-pending.json`；不记录 token、订阅者名单或原始错误响应。

认证头经进程标准输入传给 curl，不进入命令行参数；保持代理与 TLS 校验，不跟随重定向，限制连接/请求时长及响应大小。API POST 不沿用生产 GET 的超时重试规则。没有草稿 URL 或只有创建响应都不能当作读回验收通过。

2026-11-19 已通过真实受限 API 验收：保留现有人工 Draft，创建独立 TEST Draft 后读回全文与状态，第二次运行复用同一测试 ID，并核对原有草稿未变。没有发送、排期或购买套餐；测试稿被排除在正式周报去重与发送候选之外。验收不代表下一次自然定时运行已经发生，也不保证上游网络或凭据永不失效。

同一期、相同输入和模板重复运行会原样复用本地稿及远端记录；检测到本地人工改动、原稿变化或模板变化时停止覆盖。所有草稿、哈希、远端状态和错误记录均位于已忽略的 `.local-maintenance/`，不进入公开仓库或 `dist`。

### 完整流程验收（仅显式维护时使用）

本期正式稿已经发送时，不重建或覆盖它。为验证同一个发布 hook 的“新建”分支，可以对真实已审核期刊使用固定、唯一的测试标识：

```sh
npm run deploy -- --expected-week YYYY-MM-DD --email-test-id BD-CREATE-E2E-<unique-id>
npm run deploy -- --expected-week YYYY-MM-DD --verify-only --email-test-id BD-CREATE-E2E-<same-id>
```

首轮实际部署并验证所有生产路由后，自动创建带永久正文链接的 `[TEST · 不发送]` Draft；第二轮只复核生产内容并复用同一远端 ID，不再 POST。测试稿及幂等、错误记录独立保存在 `.local-maintenance/newsletter-tests/YYYY-MM-DD/<test-id>/`，强制 `sendPolicy=never_send`，读回成功才标 `test_draft_verified`。正式 manifest 与原有邮件保持原样。邮件验收失败时测试命令退出非零，但仍保留网站的真实发布状态。

每周正常任务不传 `--email-test-id`，不自动生成测试稿；只为新的真实期刊准备一份待所有者确认的正式 Draft。测试路径不能用于发送，也不能代替下一次自然定时运行的记录。

## 失败与恢复

- Cloudflare 登录过期：交互环境使用 `npx --no-install wrangler login --device`，由所有者在官方设备授权页完成；无人值守任务保存待恢复状态，不等待交互。
- 已部署但网络验收中断：用 deploy 命令附加 `--verify-only` 继续核验，不盲目重发。
- GitHub Release 失败：保留已验证网站，恢复 GitHub 身份或解决源码状态后，只重跑 release 命令。
- 某期标签已存在但核验不一致：人工检查历史，不删除/覆盖既有 tag，不自动重发。
- 邮件草稿失败：保留已上线网页和本地状态，恢复受限凭据后运行 `email:sync`；先查同一期远端草稿，不重发网站或重复建稿。不会由本流程注册读者、导入邮箱、购买套餐或自动群发。

网站、源码仓库、Release 和邮件分别记录结果；不能用其中一步的成功代替其他步骤。
