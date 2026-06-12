# bazhuayu-cli

[English](README.md) | 中文

Bazhuayu 采集任务的命令行运行工具。

`octopus` 可以列出云端任务、在本地运行任务、控制正在执行的本地任务，并导出采集数据。

## 环境要求

- Node.js 20 或更高版本
- 有效的 Bazhuayu API Key

## 快速开始

### 1. 安装

全局安装 CLI：

```bash
npm install -g bazhuayu-cli
```

安装后的命令是：

```bash
octopus
```

检查是否安装成功：

```bash
octopus --version
octopus doctor
```

### 2. 登录

大多数命令都需要八爪鱼登录凭据。执行：

```bash
octopus auth login
```

交互式登录会让你选择 OAuth 浏览器登录或 API Key 登录。

强制使用 OAuth：

```bash
octopus auth login --oauth
```

API Key 登录会尽量自动在浏览器中打开 API Key 页面，然后在本地校验并保存密钥。

在这里创建 API Key：

```text
https://www.bazhuayu.com/console/account-center/api-keys
```

如果你已经复制好了 API Key，也可以直接传入以节省时间：

```bash
octopus auth login XXXXX
```

如果是在 CI 或脚本中使用，建议通过环境变量传入：

```bash
OCTOPUS_API_KEY=xxx octopus task list --json
```

CI 也可以传入 bearer access token：

```bash
OCTOPUS_ACCESS_TOKEN=xxx octopus task list --json
```

### 3. 使用 CLI

查询任务列表：

```bash
octopus task list
octopus task list --page 2 --page-size 20
```

查询单个任务：

```bash
octopus task inspect <taskId>
```

在本地运行任务：

```bash
octopus run <taskId>
```

直接用 CLI 自动选择创建本地任务：

```bash
octopus detect 'https://example.com/list' --auto --output task.json
octopus detect 'https://example.com/search' --manual --query keyword --save-session --output task.json
```

`detect` 默认使用受保护的 SmartProxy 检测能力，需要已配置登录凭据。手动模式可以保存 cookies-only 浏览器会话，后续本地运行会自动注入。Agent 模式可通过 `--agent --agent-command` 使用；这个命令会执行本地 shell 命令，只应传入可信的 agent runner。

如果用户是在 LLM/Agent 里要求“用 bazhuayu-cli 创建采集任务”，Agent 应先执行
`octopus capabilities --json`，然后按
`machineContract.recipes.createTaskFromUrlWithAgent` 这条 recipe 自动完成：
准备确定性上下文、写 plan、预览、应用并校验任务。用户不需要解释
`--prepare-agent`、`--preview-agent-plan`、`--apply-agent-plan` 这些内部参数，也不应该把 `--auto` 当作默认 Agent 路径或手写任务 JSON。Agent 工作流会默认生成全页长截图并写入
`context.screenshot`；Agent 也应该把用户的自然语言需求通过 `--goal`
传进去，让判断同时参考页面视觉信息和用户目标。上下文还会包含
`resultValidationPolicy`；如果只是广告、专题卡、推荐卡或异构列表项导致少量行缺字段，Agent 应视为正常的部分数据，不要反复重建任务。

采集到固定行数后自动停止：

```bash
octopus run <taskId> --max-rows 100
```

后台运行：

```bash
octopus run <taskId> --detach
```

查询本地运行状态，或停止本地正在运行的任务进程：

```bash
octopus local status <taskId>
octopus local stop <taskId>
```

注意：本地运行状态仅由当前 CLI 跟踪，不会与 Bazhuayu 桌面客户端的状态同步。

导出数据：

```bash
octopus data export <taskId> --source local --format xlsx
octopus data export <taskId> --source cloud --format csv
```

## 常用命令

```bash
# 帮助与诊断
octopus --help
octopus doctor
octopus browser doctor

# 认证
octopus auth login
octopus auth login XXXXX
octopus auth status
octopus auth logout

# 任务查询
octopus task list
octopus task list --page 2 --page-size 20
octopus task list --keyword news --page 2 --page-size 10
octopus task inspect <taskId>

# 本地采集
octopus run <taskId>
octopus run <taskId> --max-rows 100
octopus run <taskId> --jsonl
octopus run <taskId> --detach
octopus local status <taskId>
octopus local pause <taskId>
octopus local resume <taskId>
octopus local stop <taskId>

# 云端采集
octopus cloud start <taskId>
octopus cloud stop <taskId>
octopus cloud status <taskId>
octopus cloud history <taskId>

# 数据
octopus data history <taskId> --source local
octopus data history <taskId> --source cloud
octopus data export <taskId> --source local --format xlsx
octopus data export <taskId> --source cloud --format csv
```

默认情况下，本地运行产物会保存在 `~/.octopus/runs`。如果你使用 `--output` 自定义了运行产物目录，那么查询本地历史或导出本地数据时，也要传入同一个 `--output`：

```bash
octopus run <taskId> --output ./runs
octopus data history <taskId> --source local --output ./runs
octopus data export <taskId> --source local --output ./runs --format xlsx
```

## API Key

大多数命令都需要 OAuth 或 API Key 凭据。只有初始化和诊断类命令，例如 `--help`、`--version`、`doctor`、`browser doctor`、`capabilities` 和 `auth`，可以在登录前运行。

在 Bazhuayu 控制台创建 API Key：

```text
https://www.bazhuayu.com/console/account-center/api-keys
```

交互式使用：

```bash
octopus auth login
```

强制使用 OAuth 浏览器登录：

```bash
octopus auth login --oauth
```

如果 API Key 已经复制好了：

```bash
octopus auth login XXXXX
```

如果你想手动复制链接，可以使用 `--no-open`：

```bash
octopus auth login --no-open
```

如果是在 CI 或脚本中使用：

```bash
OCTOPUS_API_KEY=xxx octopus task list --json
```

或者：

```bash
OCTOPUS_ACCESS_TOKEN=xxx octopus task list --json
```

凭据优先级：

```text
1. OCTOPUS_API_KEY
2. OCTOPUS_ACCESS_TOKEN
3. ~/.octopus/credentials.json
```

## 本地任务文件

你可以运行或校验本地任务定义文件：

```bash
octopus task validate <taskId> --task-file ./task.json
octopus run <taskId> --task-file ./task.json
octopus run baidu --task-file ./百度一下，你就知道.otd
```

支持的本地任务文件类型：

- `.json`
- `.xml`
- `.otd`

当前 CLI 不支持内核浏览器任务。

## 机器可读输出

使用 `--json` 输出单个 JSON 响应：

```bash
octopus task list --json
octopus local status <taskId> --json
```

使用 `--jsonl` 输出本地运行事件流：

```bash
octopus run <taskId> --jsonl
```

当运行时要求 CLI 自动处理验证码或代理资源时，事件流中会包含 `captcha` 和 `proxy` 事件。

默认情况下，本地运行产物会写入 `~/.octopus/runs`；如果配置了 `--output`，则会写入指定目录：

```text
<output>/<runId>/
  meta.json
  events.jsonl
  logs.jsonl
  rows.jsonl
```

## 故障排查

检查本地环境：

```bash
octopus doctor
octopus browser doctor
```

如果没有自动检测到浏览器，可以手动传入路径：

```bash
octopus run <taskId> --chrome-path "/path/to/chrome"
```

清理陈旧的本地控制状态：

```bash
octopus local cleanup
octopus runs cleanup
```
