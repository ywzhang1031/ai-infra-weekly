# AI Infra Weekly

中文 AI Infrastructure 研究周刊：从推理调度到训练通信，保留机制、性能条件与证据局限。由 AI 辅助编辑，原文实验未经本站独立复现。

- [阅读周刊](https://evan-ai-infra-weekly.evan-ai-infra-weekly.workers.dev/)
- [订阅入口](https://evan-ai-infra-weekly.evan-ai-infra-weekly.workers.dev/subscribe/)
- [RSS](https://evan-ai-infra-weekly.evan-ai-infra-weekly.workers.dev/feed.xml)
- [编辑流程](docs/editorial-policy.md) · [贡献指南](CONTRIBUTING.md)

## 本地运行

要求 Node.js 22 或更新版本、npm、Git；生产校验另需 curl。站点构建只用 Node 标准库，不需要模型 API、个人研究目录或任何密钥。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run preview
```

预览：http://127.0.0.1:4173 。按 Ctrl+C 停止；端口冲突时使用 `PORT=4174 npm run preview`。

## 仓库内容

- `content/`：经过公开整理的每期 JSON，保留原文链接和来源覆盖缺口。
- `config/sources.json`：公开来源清单；不会从安装者机器读取私有文件。
- `build.mjs`、`web/`：生成归档、独立期刊、订阅页、RSS 和 sitemap。
- `publish.mjs`：发布到 Cloudflare 并核对生产内容哈希。
- `docs/`：编辑与发布流程。

原始私人报告、采集缓存、学习记录、工作台、订阅者邮箱和凭据不属于本仓库。Cloudflare 只上传生成的 `dist/`。公开稿中的 `progress` 保持空数组。

## 每周更新

1. 按编辑规范整理 `content/YYYY-MM-DD.json`；可参考现有稿件结构。来源日期不使用抓取时间；窗口外材料设置 `extension: true`。
2. 运行 `npm run check`，检查本期、归档与手机布局。
3. 发布时必须传入最新一期，防止缺稿时误发旧归档：

```sh
npm run deploy -- --expected-week YYYY-MM-DD
```

只有新的 `publication-state.json` 中 `latestWeek`、`checkedAt` 和所有 `checks` 成功，才算上线。失败记录在 `publication-last-error.json`；旧成功记录不代表本次完成。部署成功但网络验收中断时使用 `--verify-only` 继续验收，避免重复部署。

## 部署自己的站点

修改 `site-config.json` 的 `title`、`baseUrl` 以及可选订阅地址，修改 `wrangler.jsonc` 的 Worker 名称。保留其他网站的 canonical 或订阅地址会把读者导向原站，请使用自己的配置。

```sh
npx --no-install wrangler login
npm run deploy:dry-run
npm run deploy -- --expected-week YYYY-MM-DD
```

生产是 Cloudflare Workers Static Assets 的持久公开地址，不依赖本机预览进程。无人值守发布需要有效的 Cloudflare 身份；OAuth 过期时需重新授权，也可由站点所有者配置限定账户与 Workers 权限的 API token。凭据只放安全凭据存储或 CI secrets，不写入仓库。Fork 不会自动发布或发送邮件。

## 许可

站点代码与工具文档：[MIT](LICENSE)。原创中文期刊内容：[CC BY 4.0](LICENSE-CONTENT.md)。第三方论文、文章与依赖保留各自许可。
