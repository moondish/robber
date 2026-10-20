<h1 align="center">⚡ 【2026最新】正方教务系统抢课脚本</h1>
<h3 align="center">深度抓包分析教务系统接口 · 1.5 秒完成抢课</h3>

<p align="center"><em>"每次选课开放的前 30 秒，当别人还在输入密码、点击界面的时候，你已经用 1.5 秒完成了选课。"</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-16+-339933?logo=nodedotjs&logoColor=white" alt="node">
  <img src="https://img.shields.io/badge/Playwright-blue?logo=playwright&logoColor=white" alt="playwright">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

<p align="center">
  🌐 <a href="README.md">中文</a> · <a href="https://github.com/ThisIsLittleSky/grabber">GitHub</a>
</p>

<p align="center">
  <a href="#优势">优势</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#配置说明">配置说明</a> ·
  <a href="#会话与无人值守">无人值守</a> ·
  <a href="#冲突自动重选">冲突自动重选</a> ·
  <a href="#测试">测试</a> ·
  <a href="#赞赏">赞赏</a> ·
  <a href="#二次开发">二次开发</a> ·
  <a href="#免责声明">免责声明</a>
</p>

<p align="center">
  无需开浏览器 → 登录-找课-选课 <strong>1.5 秒</strong> → 全自动无人值守<br/>
  只需要提供 <strong>账号 · 密码 · 年级 · 课程名称</strong>，剩下的交给脚本。
</p>

<p align="center">
  <a href="https://www.bilibili.com/video/BV17R866XEia">▶ 演示视频</a>
</p>

---

## 优势

| 环节 | 手工方式 | 本工具 |
|------|----------|--------|
| 开浏览器 | 打开选课页、找入口 | ❌ 无需开浏览器 |
| 登录 | 输账号密码、等验证码 | 会话复用，自动维持登录态 |
| 找课 | 一页页翻课程列表 | 定时轮询，课程号/教学班/关键词自动匹配 |
| 选课 | 抢名额、手点提交 | **1.5 秒完成**，命中即自动提交 |
| 冲突 | 手动退课再选 | 自动退可选修课重选，绝不误退必修 |

> 抢课拼的是速度。别人还在输密码的时候，你的课已经选完了。

目标命中后会持续查询并重试提交，直到服务器返回成功或确认课程已在已选列表；成功后自动停止轮询。会话失效、系统维护等不可恢复错误会停止并提示重新准备。

## 技术栈

- **Node.js** (>= 16)
- **Playwright** — 虚拟浏览器登录 + 抓取会话
- **纯 HTTP 请求** — 抢课核心不依赖页面 UI
- **HAR / 网络层自动识别** — 接口路径变了也不用改源码

## 快速开始

```bash
npm install                      # 安装依赖（含 Playwright 浏览器）
Copy-Item config/config.example.json config/config.json   # 生成配置（PowerShell）
# 编辑 config/config.json：base 改成你的正方地址，填 targets 目标课程
node grab.js --prepare --sso wengine   # 反代登录；正方原生入口用 --sso zfsoft
node grab.js --dryrun                  # 干跑：只查询和匹配，不提交
node grab.js                           # 实跑：允许自动提交
```

首次必须先执行 `--prepare`。浏览器完成登录并采集 Cookie/请求模板后会自动关闭、退出准备进程；此后普通运行不会再次打开登录浏览器。若未准备，`node grab.js` 会直接报错。

`--prepare` 会采集当前环境所有可获得的 Cookie、学生上下文和请求模板。查询模板、`xkkz_id`、`do_jxb_id` 等只能在开抢阶段取得的数据由运行时动态补齐，不需要等到那时才完成准备。

所有账号（包括只有一个账号）统一使用 `accounts[]`。仅保留一个 `config/config.example.json`，在其中添加多个 `accounts[]` 条目即可切换为多账号；每个账号独立 `state` / `templates` / 日志：

```bash
node grab.js --prepare --sso wengine  # 逐账号登录，生成各自会话
node grab.js --list-accounts    # 查看账号和文件路径
node grab.js --dryrun           # 使用准备结果并发干跑
node grab.js                    # 使用准备结果并发实跑
```

如果换学校/换系统版本后一直提示“等待模板”，维护者可以用抓包/HAR 诊断；普通用户不需要自己抓包：

```bash
node grab.js --capture           # 浏览器里登录并操作一遍，回终端按 Enter
# 或者用 DevTools 导出 HAR：
node grab.js --import-har 选课.har
```

抓包会自动识别查询、详情、提交、已选、退选等接口，并写入对应账号的 `state/<id>.templates.json`。具体要抓哪些请求见 [docs/抓包清单.md](docs/抓包清单.md)。

## 配置说明

编辑 `config/config.json`：

| 键 | 默认 | 说明 |
|---|---|---|
| `base` | 必填 | 正方系统根地址，如 `https://<your-host>/jwglxt`；仓库不写死学校地址 |
| `indexPath` | `/xsxk/zzxkyzb_cxZzxkYzbIndex.html` | 选课首页路径 |
| `loginPath` | 同 `indexPath` | 登录入口；如果登录先经过门户/统一认证页，填这里 |
| `zfsoftLoginPath` | `/xtgl/login_slogin.html` | 使用 `--sso zfsoft` 时的正方原生登录入口 |
| `ssoPath` | 空 | 反代认证后仍需续登时使用的 SSO 接入口，可写完整 URL |
| `selectionPath` | 自动推导 | 登录后要跳转的选课页；留空时使用 `indexPath` 或默认选课路径 |
| `gnmkdm` | `N253512` | 功能模块号，按学校系统填写 |
| `accounts[].targets.kch` | `""` | 课程号（纯数字），如 `207786` |
| `accounts[].targets.jxb` | `""` | 教学班 ID（32 位十六进制） |
| `accounts[].targets.kw` | `""` | 关键词（课程名/教学班名包含） |
| `accounts[].targets.njdm_id` | `2025` | 年级过滤，留空=不过滤 |
| `accounts[].login.username/password` | `""` | 登录账号密码（选填） |
| `intervalSec` | `2.5` | 查询间隔秒数，勿低于 1.5 |
| `kklxdm` | `10` | 课程类别（10=通识选修） |
| `api` | `{}` | 覆盖接口路径，如 `{"query":"/xsxk/xxx.html?gnmkdm=N253512"}`；显式填写优先，留空时用抓包结果 |
| `appendGnmkdm` | `true` | 自动给接口 URL 补 `gnmkdm`；若本校接口不接受可设 `false` |
| `requestTimeoutSec` | `30` | 单次接口请求超时 |
| `useTitleProbe` | `true` | 抓到前置探针模板时是否调用 `cxXkTitleMsg` |
| `authMode` | `auto` | `auto`/`zfsoft`/`wengine`/`manual`；反代认证页用 `auto` 或 `wengine` |
| `rewriteProxyAssets` | `true` | 反代把 js/css 改写成认证页时，自动还原静态资源 URL |
| `bypassProxyCSP` | `true` | 反代改写登录页脚本时放宽浏览器 CSP，避免二段登录表单被拦截 |
| `debug` | `false` | 详细调试日志；也可用命令行 `--debug` 临时开启 |
| `debugFile` | 自动 | 调试日志路径；留空时按 `logFile` 生成 `*.debug.log` |
| `accounts[].stateFile` | `state/<id>.state.json` | 账号 Cookie/会话文件 |
| `accounts[].templatesFile` | `state/<id>.templates.json` | 账号接口模板文件 |
| `accounts[].logFile` | `logs/<id>.log` | 账号日志文件 |
| `notify.webhook` | `""` | 成功/会话过期推送 URL（ServerChan/PushPlus 类） |
| `notify.beep` | `true` | 成功/失败时控制台提示音 |
| `accounts[]` | 必填 | 账号数组；旧顶层单账号配置已弃用 |
| `concurrency` | 账号数 | 同时运行的账号数，默认全部并发 |
| `restartDelaySec` | `15` | 账号异常退出后的重启间隔 |
| `maxRestarts` | `5` | 每个账号最大自动重启次数 |

> 所有账号默认使用 `state/<id>.state.json`、`state/<id>.templates.json`、`logs/<id>.log`，不会互相覆盖。

## 多账号并发

复制 `config/config.example.json` 为 `config/config.json`，在 `accounts[]` 中增加账号，并填写公共 `base` 和每个账号的 `login` / `targets`：

```json
{
  "base": "https://<your-zfsoft-host>/jwglxt",
  "concurrency": 3,
  "accounts": [
    { "id": "a1", "login": { "username": "u1", "password": "p1" }, "targets": { "kch": "1001" } },
    { "id": "a2", "login": { "username": "u2", "password": "p2" }, "targets": { "kch": "1002" } },
    { "id": "a3", "login": { "username": "u3", "password": "p3" }, "targets": { "kw": "摄影" } }
  ]
}
```

- 第一次先运行 `node grab.js --prepare --sso wengine`，逐个账号登录并保存会话；避免同时弹出多个浏览器。
- 之后先运行 `node grab.js --dryrun` 核对命中；确认后直接运行 `node grab.js` 实跑。
- 只跑某个账号：`node grab.js --account a1`。
- 只给某个账号抓包/导入 HAR：`node grab.js --capture --account a1`、`node grab.js --import-har 选课.har --account a1`。
- 账号异常退出会自动重启；会话过期退出码为 2，不会盲目重启，需要重新 `--prepare` 该账号。
- 账号默认继承顶层 `base/indexPath/api/notify`，也可以在单个账号里覆盖 `base`，适配不同学校实例。

## 会话与无人值守

- 进入正方教务系统后只采集一次 Cookie，并写入对应账号的 `state/<id>.state.json`；准备阶段随后采集模板并退出。
- 普通运行只复用准备结果；会话过期会退出并提示重新执行 `--prepare`，不会自动弹浏览器。
- 多账号模式每个账号写入各自的 `state/<id>.state.json`；首次部署先 `node grab.js --prepare --sso zfsoft|wengine`。
- **服务器部署**：本地 `--prepare` 一次 → 拷贝 `config/config.json`、`state/`、`logs/` → `node grab.js --dryrun` 验证 → `node grab.js` 实跑 → 配好 `notify.webhook` 收通知。

## 清空配置

以下命令会删除默认配置、所有账号 Cookie/模板、日志及旧版根目录运行时文件，但不会删除示例配置和源码：

```bash
node grab.js --delete
```

`--delete` 必须单独使用；与 `--prepare`、`--sso`、`--account`、`--dryrun`、`--capture`、`--config` 等参数组合会直接报错，不执行删除。

## 冲突自动重选

提交返回"冲突"时，自动查询已选课程，解析上课时间找与目标课**时间重叠**的课：

- 重叠课是**可退的选修课**（`kklxdm=10` 且 `rwlx=2`）→ 自动退掉，重新提交目标课。
- 其余情况（必修/不可退/定位不到/退选失败）→ **一律只告警不动手**，冷却后重试。

一句话：**只退可退选修课，绝不误退必修课。** 退选不可逆，实跑前务必先干跑确认。

## 测试

```bash
npm test                         # 运行单元测试（node lib/self_test.js）
```

## 文档

- [使用说明.md](使用说明.md) — 完整使用手册（配置、会话、冲突规则、故障排查）
- [docs/抓包清单.md](docs/抓包清单.md) — 换学校/换版本时要抓的接口与字段
- [docs/接口分析.md](docs/接口分析.md) — 选课接口逆向分析
- [docs/开发计划2.md](docs/开发计划2.md) — 本独立工具实现方案
- ~~[docs/开发计划.md](docs/开发计划.md) — 油猴脚本版方案（首版，已弃用）~~

> ⚠️ `config/config.json`（含账号密码）、`state/`（含 Cookie 和模板）等敏感/运行时文件已被 `.gitignore` 忽略，请勿提交。

## 接口适配更新

- 接口路径集中到 `lib/api.js`，不再散落在主流程里；`config/config.json` 的 `api` 显式覆盖优先，留空时使用抓包自动学习的结果。
- 新增 `node grab.js --capture` 和 `node grab.js --import-har`，可从真实页面/HAR 自动学习路径、请求模板和响应结构。
- 兼容新版页面的 `cxZzxkYzbDisplay.html` 初始加载和 `cxZzxkYzbChoosed.html` HTML 已选列表（旧版 `ChoosedDisplay` JSON 仍可用）。
- 提交前若抓到 `cxXkTitleMsg` 模板，会先走前置探针；退选后会刷新批次并重新获取 `do_jxb_id` 再重试。
- 兼容 `tmpList` / `list` / `rows` / `items` / `data` 等常见响应外壳，以及 `do_jxb_id` / `jxb_ids` 两种加密 ID 字段。

## 赞赏

如果它帮你抢到了课，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="docs/paycode.jpg" alt="赞赏码" width="220">
</p>

## Roadmap

规划中的功能方向，欢迎认领开发（对应 GitHub Issues 见文末链接）：

- **友好的 UI 界面** — Web 或桌面客户端（形态待定，欢迎贡献者共创）
- ~~**多账号并发**~~ — 已完成：独立子进程、独立会话/模板/日志、并发上限和异常重启
- **定时轮询** — ① 定时到点自动启动 ② 开抢窗口内自动提频，两者都支持
- **多学校适配** — 内置几所学校的正方系统模板，选学校即可用

> 每个方向对应一个 GitHub Issue，标有 `good first issue` / `help wanted`，可认领开发并提交 PR。

## 二次开发

本项目**允许二次开发**（MIT License）。你可以：

- Fork 后自行修改、增强、打包分发。
- 在此基础上开发自己的抢课工具。
- 提交 PR 贡献回本项目。

二次开发时可参考：

- 核心代码：`grab.js` 与 `lib/`（匹配、冲突、参数解析）
- [docs/接口分析.md](docs/接口分析.md) — 选课接口逆向分析
- [docs/开发计划2.md](docs/开发计划2.md) — 独立工具实现方案

请遵守 MIT License 及下方免责声明。

## 免责声明

本项目**仅供学习研究使用，请勿用于真实环境**。

- 使用本工具可能违反你所在学校的选课系统使用条款，请自行评估风险。
- 因个人操作不当（如误退课、误选课）造成的一切后果，**作者不承担任何责任**。
- 本工具不保证抢课成功率，选课结果以教务系统为准。
- **绿色上网，人人有责。**

---

<p align="center">
  <sub>抢课不是目的，选到心仪的课才是。把体力活交给脚本，把时间留给真正重要的事情。</sub>
</p>

<p align="center">
  <a href="https://github.com/ThisIsLittleSky/grabber/issues">Issues</a> ·
  <a href="https://github.com/ThisIsLittleSky/grabber/pulls">Pull Requests</a>
</p>

<p align="center">
  <sub>欢迎提交 Issue 和 Pull Request！</sub>
</p>
