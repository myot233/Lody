# Oh My Pi 原生 ACP

Status: draft
Translation: current

[English](omp-native-acp.md)

已配置 Oh My Pi 的用户可以在连接的机器上选择 **Oh My Pi (OMP)**。
Lody 以稳定身份 `registry/omp` 通过 stdio 启动 `omp acp`，安装、凭据和配置由
OMP 管理。已有内置 Pi Provider 和会话保持原身份。

## 命令、Skills 和表单

运行中的进程提供模型、模式、命令和其他能力，验证失败走现有 Provider 流程。
探测读取自身会话最新的标准 `available_commands_update`，包括空列表以及
`session/new` 后的通知。响应中的可选列表仅作回退，两者都没有时最多等待一秒。
取消关闭进程且不缓存成功，递增缓存版本使旧探测刷新。

`/` 菜单展示运行时公布的命令，选择后插入命令。prompt 传输保留文字和参数，
包括首轮发送；不向运行时命令追加系统提示和引用。Skill 和扩展命令在运行时
公布时出现，不用静态目录代替真实列表。

Skills 菜单映射默认项目 `.omp/skills`、`.agent/skills`、`.agents/skills`，
以及用户 `~/.omp/agent/skills`、`~/.omp/agent/managed-skills`、`~/.agent/skills`、
`~/.agents/skills`。额外目录和自定义 profile 路径需要动态发现，不属于静态映射。

标准 ACP 表单复用持久化问答/权限 UI，支持字符串、选项、枚举数组和布尔值。
回复保留字段身份与 JSON 类型，并验证 required/enum。不支持的约束及无效、未来
版本 Core metadata 被拒绝。未标记的 `_other` 字段保持独立，默认值暂不预填。

## 协商后的 GUI 组件

兼容 Agent 可以在 Lody 的问答卡片打开原生自定义组件。Core v1 通过标准 form
elicitation 协商惰性文本/按钮/输入文档。必填的 `event` 字符串包含版本、组件 ID、
revision 和输入。只有当前请求能接受匹配事件，过期或未来版本事件取消。
权限归属、取消、持久化和历史写入仍由现有路径管理，历史 frame 禁用输入。

配色和快捷键局限于组件。只有 region 获得焦点时响应按键，不拦截可编辑字段或
IME。文档没有 HTML、脚本、URL、任意 CSS 或远端 widget。UTF-8 文档最多
128 KiB、256 节点、128 快捷键和 4096 字符输入。

修复后的 OMP bridge 执行原生 `ctx.ui.custom`、Theme 和 profile
KeybindingsManager，投影有界的 80 列文本 frame 与原生按键输入。每次输入产生
下一 revision，完成返回原生结果，cancel/abort 释放组件，也释放取消后迟到的
factory。v1 不承诺无输入动画、ANSI 布局保真或原生 header/footer/widget 放置。

## 原生 ACP 扩展行为

固定的 extended OMP 构建还通过 `/omp` 提供原生管理和语音目录，支持版本化
acknowledged steering、`/commit-plan` 原子提交计划以及加密协作命令。
这些能力来自运行时公布；选择官方二进制不会自动安装源码补丁。

Steering 保留在当前拥有的 turn，要求原生应用证明并撤回取消后的排队输入。
提交验证和审批先于原生 index/HEAD 变更，取消或无效计划不能生成提交。
协作保留本地 ACP 身份及 cwd，强制只读链接限制，访客 prompt 要求 host 的
`/collab watch` turn。远端状态预览有界，未知用量不伪造；离开关闭副本与自有
socket，原生 crypto 和 write-token 检查保持权威。

## 固定验收基线

验收要求固定[36 类清单](../apps/cli/src/agent/omp-integration-baseline.ts)的
**100%**，包含全部 21 个 OMP 重点功能以及生命周期、配置、命令、表单、权限、
MCP、媒体、上下文、任务、会话、用量、管理、自定义界面和安全。
每个必需项都要有执行证据，部分完成、失败、不支持或未验证的类仍在分母中。
仅发现能力或阅读源码不能计分。

[可选 runner](../apps/cli/scripts/omp-integration-baseline.ts) 使用真实 OMP 18.4.3
进程与 Lody ACP 客户端，外部服务用可控替身。验证工具结果与状态、独立 Cocoa
测试窗口的原生捕获/输入、真实 React GUI 交互、两个加密协作原生进程。
模型、搜索、GitHub、relay、语音、LSP/DAP 和 MCP 服务均为合成 loopback 服务；
Mnemopi 使用独立 FTS 数据库，浏览器验证使用自有 headless Chrome。
桌面验证需要 macOS ARM64、`swiftc` 和捕获/辅助功能权限。继承环境采用白名单并
禁用 login-shell 导入，临时状态与自有子进程被清理，报告只保留结果和摘要。

测得 `acp-extended` 构建完成 **36/36**；未修改官方对照为 28/36，MCP 专项修复
为 29/36，两者均未通过当前 100% 门槛。结果对应固定源码、合约、二进制，
不推广为所有 OMP 版本的保证。Extended 构建需要随附源码补丁和 owning Note
中记录的 Core overlay。启动前校验二进制及补丁摘要，重建摘要变化需复核后固定。
另一次构建后的 Electron 验证覆盖真实桌面命令/组件路径。在 `apps/cli` 中运行：

```sh
pnpm exec tsx --tsconfig tsconfig.json scripts/omp-integration-baseline.ts \
  --build acp-extended --binary /path/to/omp --report /tmp/omp-baseline.json
pnpm exec tsc --noEmit -p tsconfig.omp-baseline.json
```

## 证据

- [决策、限制、构建步骤与验证](../.agents/notes/implemented/feature/2026-09-30-omp-native-acp.zh.md)
- [OMP 源码补丁](../scripts/omp-acp-extended.patch)、[Core 合约补丁](../scripts/omp-acp-core-components.patch)
- [命令发现](../apps/cli/src/agent/acp-capabilities.test.ts)
- [命令传输](../apps/cli/tests/session-execution-helpers.test.ts)
- [表单/组件验证](../packages/shared/tests/ask-user-question.test.ts)
- [生产卡片及原生 GUI 验收驱动](../packages/components/tests/ask-user-question-card.test.ts)
