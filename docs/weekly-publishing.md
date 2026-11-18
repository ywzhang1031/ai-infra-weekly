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

发布命令在全部生产路由验证成功后，自动生成 `.local-maintenance/newsletters/YYYY-MM-DD/draft.md` 与 `manifest.json`。邮件步骤失败时另写该目录的 `generation-error.json`，不撤销网站已验证状态；必须区分网站上线与邮件草稿准备结果。

6. 生产验收后发布对应 Release：

```sh
npm run release -- --expected-week YYYY-MM-DD --dry-run
npm run release -- --expected-week YYYY-MM-DD
```

`--dry-run` 不创建远端 Release/tag，但会运行本地构建和检查。正式命令要求当前源码干净、远端 main 与本地 HEAD 一致、GitHub 身份/仓库匹配且公开、最新公开期号匹配，并重新对照生产哈希。已有对应 Release 时核验后复用，不覆盖标签或重复通知。

7. 将本期邮件保存在 Buttondown 的 Drafts，等待所有者审阅，流程见下节。GitHub Release 失败不阻止已上线期刊准备草稿；网站未通过生产验收则不准备草稿。

## 邮件草稿与人工确认

此步骤只准备草稿，不发送测试邮件、不排期、不点击 Publish 或 Send draft，也不启用 Buttondown 的 RSS-to-email 自动发送。发送给订阅者需要所有者对具体期刊、内容及受众明确确认；保存草稿不构成发送授权。

已上线期刊需要单独恢复本地草稿时运行：

```sh
npm run email:draft -- --expected-week YYYY-MM-DD
```

该命令重新构建和检查公开内容，核对完整生产验收记录及本地产物哈希，再有界校验当期生产正文。发布、Release 与邮件草稿共用同一 HTTPS 读取实现：每次连接上限 10 秒、请求总上限 20 秒，仅传输超时最多追加一次全新的 GET；丢弃失败请求的部分正文，HTTP 非 200、证书错误或内容哈希不符不重试。保持现有代理环境和 TLS 证书校验，不修改系统网络设置。失败记录只含退出码、阶段及耗时，不输出凭据或完整网络响应。它只接受最新、已经发布的公开期号。`deploy` 刚完成全路由验证时复用该结果，不重复请求生产正文。输入只来自 `content/YYYY-MM-DD.json`，`progress=[]`；不读取私人研究报告或学习记录。

模板保留单栏短导读、最多三个当期重点、深绿底白字全文按钮、当期永久链接、最新一期与历史归档、来源覆盖及证据局限。邮件主题在 `manifest.subject`，正文在 `draft.md`；Buttondown 会渲染主题，因此正文不重复添加一级标题。使用 Markdown 编辑模式并保留平台提供的退订页脚。

在已登录的 Buttondown 后台执行以下有界步骤；没有可用连接或登录过期时保留本地草稿，记录待恢复原因，不在无人值守任务中等待授权：

1. 读取 manifest 的远端记录。若有 `remote.url`，打开同一草稿；否则在 Emails 按期号查找，核对主题与当期正文 URL。两种入口均须排除主题以 `[TEST · 不发送]` 开头或正文包含 `BD-CREATE-` 测试标记的条目；测试稿不得映射为正式 manifest 的远端稿件，也不得作为发送候选。排除测试稿后，找到一份已存在的正式稿件就复用；结果不唯一时停止，避免重复。
2. 若已有稿件被人工编辑，保留原稿，不用生成稿覆盖。若已发送或排期，不修改、不再创建。记录实际状态；本地模板或公开稿哈希变化也需要人工复核。
3. 仅在确认本期尚无邮件时创建草稿，填入本地主题和 Markdown 正文；等待保存后重新打开，核对主题、正文、期号、三个阅读入口及预览，确认状态仍为 Draft。
4. 把实际远端结果写回同一 `manifest.json`，例如：

```json
{
  "status": "awaiting_owner_review",
  "remote": {
    "status": "draft",
    "url": "https://buttondown.com/emails/实际草稿ID",
    "bodySha256": "实际保存的Markdown正文SHA256",
    "verifiedAt": "实际核验时间的ISO时间戳"
  }
}
```

保留 manifest 的其他字段；正文哈希按 UTF-8、LF 换行及一个结尾换行计算。若复用了已有人工稿，可另写 `remote.preservedExisting=true`，不要把其正文哈希假称为生成稿的哈希。`sent`/`scheduled` 只能根据后台实际状态记录，不能从有 URL 推断。远端失败保留 `remote.status="pending"` 并记录简短原因。最终提供草稿链接、当期公开链接及待确认状态；不得声称已发给订阅者。

同一期、相同输入和模板重复运行会原样复用本地稿及远端记录；检测到本地人工改动、原稿变化或模板变化时停止覆盖。所有草稿、哈希、远端状态和错误记录均位于已忽略的 `.local-maintenance/`，不进入公开仓库或 `dist`。

## 失败与恢复

- Cloudflare 登录过期：交互环境使用 `npx --no-install wrangler login --device`，由所有者在官方设备授权页完成；无人值守任务保存待恢复状态，不等待交互。
- 已部署但网络验收中断：用 deploy 命令附加 `--verify-only` 继续核验，不盲目重发。
- GitHub Release 失败：保留已验证网站，恢复 GitHub 身份或解决源码状态后，只重跑 release 命令。
- 某期标签已存在但核验不一致：人工检查历史，不删除/覆盖既有 tag，不自动重发。
- 邮件草稿失败：保留已上线网页和本地状态，先查同一期远端草稿，再恢复保存，不能重发网站或重复建稿来绕过错误。不会由本流程注册读者、导入邮箱、购买套餐或自动群发。

网站、源码仓库、Release 和邮件分别记录结果；不能用其中一步的成功代替其他步骤。
