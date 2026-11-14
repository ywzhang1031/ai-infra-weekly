# 每周公开发布与通知

同一份公开稿驱动网站、RSS 与 GitHub Release。私人研究材料不进入这个仓库；不要从上层目录执行 `git add .`。

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

6. 生产验收后发布对应 Release：

```sh
npm run release -- --expected-week YYYY-MM-DD --dry-run
npm run release -- --expected-week YYYY-MM-DD
```

`--dry-run` 不创建远端 Release/tag，但会运行本地构建和检查。正式命令要求当前源码干净、远端 main 与本地 HEAD 一致、GitHub 身份/仓库匹配且公开、最新公开期号匹配，并重新对照生产哈希。已有对应 Release 时核验后复用，不覆盖标签或重复通知。

## 失败与恢复

- Cloudflare 登录过期：交互环境使用 `npx --no-install wrangler login --device`，由所有者在官方设备授权页完成；无人值守任务保存待恢复状态，不等待交互。
- 已部署但网络验收中断：用 deploy 命令附加 `--verify-only` 继续核验，不盲目重发。
- GitHub Release 失败：保留已验证网站，恢复 GitHub 身份或解决源码状态后，只重跑 release 命令。
- 某期标签已存在但核验不一致：人工检查历史，不删除/覆盖既有 tag，不自动重发。
- 邮件订阅：需要独立的真实 Buttondown 订阅页；开始时只准备草稿。不会由本流程注册读者、导入邮箱、购买套餐或自动群发。

网站、源码仓库、Release 和邮件分别记录结果；不能用其中一步的成功代替其他步骤。
