# 通过原生 ACP 接入 Oh My Pi

Status: implemented
Translation: current

[English](2026-09-30-omp-native-acp.md)

## 摘要

Lody 可以启动用户安装的 `omp acp`，发现 slash command 并保留命令参数。
单独固定版本的 OMP 源码补丁补齐了官方 ACP 尚未暴露的协作、原子提交计划、
管理、steering 和 GUI 组件。固定的 36 类验收清单使用真实 OMP 进程和 Lody
ACP 客户端完成 36/36，外部服务使用可控替身。此结果对应修复后的构建；
直接选择未修改的 OMP 安装不会获得这些扩展。

## 接入归属

Registry 生成器在上游刷新后保留 `registry/omp`，现有启动解析器运行 `omp acp`，
不托管下载。安装、凭据、配置由 OMP 和用户管理，其身份独立于
[内置 Pi](2026-09-17-builtin-pi.zh.md)。

通用能力探测读取自身 ACP 会话的最新命令列表；空列表具有权威性，响应扩展仅作
回退。没有列表时最多等待一秒，取消会关闭进程并阻止缓存成功结果。能力和 Skills
缓存版本递增。默认项目目录为 `.omp/skills`、`.agent/skills`、`.agents/skills`；
用户目录包含 `~/.omp/agent/{skills,managed-skills}` 及共享目录，自定义 profile
路径需要动态发现。Composer 和首轮执行原样保留 slash 输入，不追加指导文字；
真实桌面验证发现追加 MCP 提示会改变原生命令名或参数，并已修复。

标准表单复用现有持久化权限/问答路径。通用解析保留原字段名，恢复布尔类型，验证
required/enum，拒绝不支持的约束以及无效或未来版本的 Core metadata。
默认值暂不预填，未标记的 `_other` 字段不推断关联。没有增加其他历史写入路径或
供应商专属渲染器。

## 原生扩展及权限边界

[OMP 补丁](../../../../scripts/omp-acp-extended.patch) 复用原生实现：

- MCP prompt catalog 转为标准命令更新；重配置隔离旧 manager 并移除过期命令，
  覆盖延迟出现的 stdio/HTTP prompt。
- `/omp` 提供会话、项目、聊天、用量、扩展和语音模型目录。扩展开关写入原生存储并
  reload，目录包含已禁用项。
- Core acknowledged steering 在当前原生 turn 排队。只有原生 `message_start`
  能证明应用，取消撤回尚未注入的消息，不会自动启动空闲会话。
- `/commit-plan validate|apply <plan.json>` 复用原生验证及拆分提交。审批先于变更；
  取消或无效计划保留 HEAD/index；接受后按准确的文件归属生成独立提交。
- `/collab start|view|status|watch|stop`、`/join`、`/leave` 复用加密 relay frame、
  写入 token 和磁盘快照副本。只读链接不能提交 prompt；ACP host 仅在其拥有的
  `/collab watch` turn 接受访客输入。远端身份不覆盖本地 ACP 身份或 cwd，未知用量
  不伪造。状态预览最多保留 20 项且文本有界；resync 前刷新旧副本，离开时关闭资源。

## GUI 协议和呈现

[Core 源码补丁](../../../../scripts/omp-acp-core-components.patch) 定义共享 v1 合约，
Lody 从公开 Core submodule 导入。客户端协商
`_meta.lody.elicitation.components.version = 1`，标准表单携带惰性文档及唯一必填
`event` 字符串，回复绑定组件 ID 和 revision。未知版本、过期事件、可执行内容、
任意 CSS 和超限文档被拒绝。上限为 UTF-8 128 KiB、256 节点、128 快捷键和
4096 字符输入。

真实问答卡片通过 `@lody/ui` 呈现文本、按钮、输入、局部配色和焦点内快捷键。
历史和等待中的 frame 禁用操作。OMP adapter 运行原生 `ctx.ui.custom` factory、
Theme 和 profile KeybindingsManager，将每个 80 列文本 frame 投影为文档。
CSI-u 保留 Ctrl+J，避免混同 Enter；取消也释放迟到的 factory。所属 Story 复用
同一个生产组件。

v1 由输入驱动，不推送无输入的动画，也不实现原生 header/footer/widget 布局。
ANSI 布局转换为文本和组件局部配色，不宣称完整终端 API 等价。固定的自定义界面
验收项验证原生主题、profile 快捷键、自定义组件及其原生返回值。

## 验收和复现

[清单与评估器](../../../../apps/cli/src/agent/omp-integration-baseline.ts) 要求
**36/36（100%）**。每个必需项必须执行，部分完成、不支持、失败或没有证据的类
仍保留在分母。测试证明 28、29、35 类均失败，36 类才通过。官方对照完成 28/36，
[MCP 专项补丁](../../../../scripts/omp-acp-mcp-prompts.patch) 完成 29/36，
两者均不满足当前门槛。完整验收需要 extended 补丁及 Core GUI 合约。

最终完整原生运行完成 36/36，验证工具结果及实际状态、真实 LSP/DAP frame、两个
加密协作 OMP 进程、steering 应用与撤回、提交验证/审批/拆分、表单、媒体、任务、
load/resume/fork、管理持久化、浏览器操作，以及新进程读取安全报告。
原生桌面捕获与输入作用于独立 Cocoa 测试窗口。自定义界面通过真实 React 权限
卡片执行 Ctrl+J 与确认；另一次构建后的 Electron 验证覆盖真正的
main/preload/renderer/CLI 链路及原生结果。输入和外部服务均为合成数据，
不操作用户已有窗口，不替换用户安装的 OMP。

版本固定为 OMP 18.4.3 源码 `fc671eba383f2a7208500836673b485c0dc7073d`、
Core `c80616271c52de79ab4502fd58901d1e72088b86`、Bun 1.4.0、Node 22.23.2。
原生 addon 为 `@oh-my-pi/pi-natives-darwin-arm64@18.4.3`，SHA-256 为
`820115e81da1d57b3a8fb5efc3780ca827ac568f8c2e74389d812b80c3d40461`。
最终补丁和二进制摘要由评估器导出并写入报告，也包含 Core 合约补丁摘要。
runner 启动前校验字节；重建产生不同二进制摘要时，需要复核后重新固定。

从本 Lody checkout 初始化 submodule 和依赖，运行 Core 的 `npm run build` 和
`npm run typecheck`。随附 Core 补丁也可从其 base commit 复现合约变化。
在固定 OMP 源码上应用 `scripts/omp-acp-extended.patch`，冻结运行 `bun install`，
将已安装的 `node_modules/acp-extension-core` 目录替换为指向构建后 Core 的符号
链接。0.1.8 registry 依赖提供现有 steering 运行时定义；尚未发布的 GUI 类型
需要显式源码 overlay，不放宽上游 release-age 策略。在 OMP 的
`packages/coding-agent` 中 `bun run build`，然后运行：

```sh
# 在 Lody apps/cli 中；需要 macOS ARM64、swiftc 和原生桌面权限。
pnpm exec tsx --tsconfig tsconfig.json scripts/omp-integration-baseline.ts \
  --build acp-extended --binary /path/to/omp --report /tmp/omp-baseline.json
pnpm exec tsc --noEmit -p tsconfig.omp-baseline.json
```

验收进程使用环境白名单并禁用 login-shell 导入。模型、搜索、GitHub、MCP、relay
和语音外部服务由 loopback 替身提供；Mnemopi 使用独立 FTS 数据库，浏览器使用
独立 headless Chrome 并清理。报告仅保留结果和摘要，不保留对话或工作目录。
Core build/typecheck/test、上游 ACP/MCP/协作所属测试、格式化、Lody 检查和
验收脚本 typecheck 验证源码。[Spec](../../../../specs/omp-native-acp.zh.md) 保持 draft，
等待人工评审。本次不包含 OMP 上游发布或替换用户运行时。

Core 合约依赖：[draft PR #16](https://github.com/LodyAI/acp-extension-core/pull/16)，commit `a63f327`。未报告 CI check，本地 build/typecheck/test 已通过。
