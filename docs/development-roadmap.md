# VoxSpeech 分阶段推进规划

> 状态：已确认
>
> 执行模式：最多三个执行 Agent 并行，主 Agent 负责契约、目录分配、集成和阶段验收

## 1. 并行执行规则

每个阶段开始前先由主 Agent 冻结共享接口，再把互不重叠的目录交给执行 Agent。执行
Agent 不得同时修改同一个文件；根配置、共享协议和跨包依赖由主 Agent 维护。

主 Agent 固定负责：

- `package.json`、`project.tiny`、根 TypeScript 与 CMake 配置；
- `packages/protocol` 的最终接口；
- 架构和协议决策；
- 跨模块集成、完整质量检查和阶段验收；
- 处理需要改变已冻结契约的问题。

每个执行 Agent 完成任务时必须报告修改文件、验证命令、验证结果和剩余风险。阶段验收
失败时只修复当前阶段，不提前实现后续功能。

## 2. P0：协议与工程基线

目标：建立 TypeScript 和 C++ 都能编译、验证的 JSON-RPC version 1 契约。

| 执行线  | 目录所有权                | 工作                                    |
| ------- | ------------------------- | --------------------------------------- |
| Agent A | `packages/protocol`       | TypeBox schema、TypeScript 类型、Vitest |
| Agent B | `native/engine`           | Glaze JSON-RPC 类型、CMake、CTest       |
| Agent C | `test/fixtures`、协议测试 | 双端 golden fixtures、非法消息用例      |

主 Agent 集成 native CTest 到 `yarn tiny check`，确认 schema、C++ struct、fixture 和协议
文档完全一致。

验收门：

- TypeScript 7 类型检查、Oxlint、Oxfmt 和 Vitest 全部通过；
- C++23 + Glaze 编译和 CTest 通过；
- 同一 fixture 可被 TypeScript 与 C++ 解析；
- 超限、未知 method、非法 params 和协议版本不匹配均有确定结果；
- stdout 不允许出现非协议内容。

## 3. P1：native 验证与 TypeScript 假闭环并行

这一阶段同时推进三条互不阻塞的路径。

### Agent A：真实 native 能力

所有权：`native/engine`、`native/third_party/qwentts.cpp`、P0 原生验收记录。

- 固定 qwentts.cpp commit 和模型文件；
- 建立 CMake/Ninja 构建；
- 验证 CUDA 加载 1.7B Base Q4_K_M；
- 验证 WAV、流式 PCM、Voice Clone 和 reference latent 复用；
- 验证 cooperative cancellation、正常退出和显存回收；
- 记录 TTFA、RTF 与峰值显存。

模型资产通过共享 TypeScript 下载器准备：支持 Hugging Face 官方/镜像端点、代理、
多连接 Range 分块、跨进程续传、SHA256 校验和原子落盘。native probe 不再维护独立的
网络下载脚本。

### Agent B：Node engine-client

所有权：`packages/engine-client`。

- 使用 fake engine 实现 `spawn()` 和初始化；
- 管理 request ID、pending request、notification 和 Base64 PCM；
- 处理 stderr、超时、取消、异常退出和 shutdown；
- 建立全部进程边界单元测试。

### Agent C：daemon 与 CLI 假闭环

所有权：`apps/daemon`、`apps/cli` 中本阶段新增文件。

- 建立 daemon Unix Socket JSON-RPC server；
- 建立 CLI JSON-RPC client；
- 实现最小 `status` 与 `speak`；
- 使用 fake synthesis 验证 stdin、PCM/WAV 文件输出和播放路径；
- 验证 daemon 不可用、连接超时和请求取消。

验收门：

```text
CLI → Unix Socket → daemon → fake engine → PCM/WAV
```

与：

```text
native probe → qwentts.cpp → 真实 PCM/WAV
```

两条链路必须独立通过。native 调试不能阻塞 TypeScript 产品层开发。

## 4. P2：真实 engine 端到端集成

执行前必须遵守 `docs/decisions/p2-engine-integration.md` 的冻结契约。执行 Agent 不得自行
修改 JSON-RPC version 1、共享 fixture、跨目录边界或 qwentts.cpp submodule。

| 执行线  | 目录所有权               | 工作                                                  |
| ------- | ------------------------ | ----------------------------------------------------- |
| Agent A | `native/engine/src`      | JSON-RPC server、推理线程、取消回调、PCM notification |
| Agent B | `packages/engine-client` | 真实子进程监督、load/status/shutdown、流式解码        |
| Agent C | `apps/daemon/test`       | 崩溃、超时、取消、错误码和消息顺序集成测试            |

主 Agent 完成第一次真实闭环并处理双方契约差异：

```text
voxspeech speak
→ Unix Socket JSON-RPC
→ daemon
→ stdio JSON-RPC
→ C++ engine
→ qwentts.cpp
→ PCM notification
→ daemon
→ WAV / pw-play
```

验收门：

- 中文语音正确播放，首个 chunk 在完整语音结束前到达；
- `Ctrl+C` 可以传播取消；
- engine 崩溃不会带走 daemon；
- shutdown 后显存释放；
- stderr 不污染协议；
- 连续合成不会串流或错配 request ID。

## 5. P3：配置、模型和 Voice 并行

> 状态：实现与自动化完成；1.7B 验收通过，0.6B 已改用 Q8_0 并通过真实 Vulkan 自动化，等待试听；P4 尚未启动。

三个 Agent 只修改 daemon 内各自子目录及对应测试，避免提前增加 workspace 包。

| 执行线  | 目录所有权                              | 工作                                                       |
| ------- | --------------------------------------- | ---------------------------------------------------------- |
| Agent A | `packages/config`、daemon configuration | YAML v1、XDG、迁移、原子保存、config CLI                   |
| Agent B | daemon models                           | catalog、下载恢复、SHA256、原子安装、model CLI、setup      |
| Agent C | daemon voices                           | clone、Voice Profile、latent 持久化、默认 Voice、voice CLI |

主 Agent 负责模型、Voice、engine load 和配置事务之间的组合规则。

验收门：

- 空用户目录可以执行 `voxspeech setup`；
- 下载中断或校验失败不会产生可用模型；
- 一条命令完成 Voice Clone；
- daemon 重启后 Voice 仍然可用；
- 删除模型或 Voice 不会破坏当前运行请求。

## 6. P4：完整 daemon 与 OpenAI API

| 执行线  | 目录所有权                | 工作                                            |
| ------- | ------------------------- | ----------------------------------------------- |
| Agent A | daemon HTTP               | `/v1/audio/speech`、PCM streaming、WAV response |
| Agent B | daemon runtime            | 队列、idle unload、模型切换、崩溃恢复           |
| Agent C | CLI、diagnostics、systemd | 完整命令面、服务管理、状态与日志诊断            |

验收门：

- CLI 与 HTTP 共用同一 synthesis service；
- OpenAI client 可以直接调用；
- V1 同时只执行一个推理，其余请求有界排队；
- idle timeout 后 engine 退出，下一个请求可以重新拉起；
- API 默认只监听 `127.0.0.1`；
- systemd 停止执行有界 shutdown。

## 7. P5：打包与发布并行

| 执行线  | 目录所有权    | 工作                                                           |
| ------- | ------------- | -------------------------------------------------------------- |
| Agent A | Linux staging | 固定 Node.js 24、TS bundles、engine、原生动态库、staging smoke |
| Agent B | AUR           | PKGBUILD、install hook、systemd unit、安装升级卸载验证         |
| Agent C | 发布质量      | License、第三方 Notice、干净环境测试、版本与发布文档           |

模型不进入默认程序包，由 `voxspeech setup` 下载到用户数据目录。

最终验收门：

```text
安装
→ voxspeech setup
→ voxspeech voice clone
→ voxspeech speak
→ OpenAI API
→ idle unload
```

以上流程必须在干净 Arch/CachyOS 环境通过。

## 8. 后续阶段

V1 稳定后再评估 GTK 配置应用、更多模型模式、更多原生后端和其他 Linux 发行版。GUI
只能调用已有 daemon JSON-RPC，不形成第二套产品逻辑。
