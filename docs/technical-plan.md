# VoxSpeech 技术规划

> 状态：架构基线
>
> 目标平台：Linux x86_64

## 1. 项目定位

VoxSpeech 是面向 Linux 的轻量本地 TTS Runtime，为 AI Agent、命令行工具和本地应用
提供低延迟语音合成、Voice Clone、音色管理及 OpenAI-compatible TTS API。

项目主体使用 Node.js 24 与 TypeScript 7，原生推理通过独立 C++23 子进程完成。用户功能
首先以完整 CLI 暴露，配置使用 YAML，常驻部分运行在 systemd 用户服务中。

## 2. 首期目标

- 提供 `voxspeech` CLI 和 `voxspeech-daemon` 常驻服务。
- 使用 Qwen3-TTS GGUF 和 qwentts.cpp 完成本地流式 TTS。
- 支持 1.7B Base 模型的 Voice Clone 与可复用 Voice Profile。
- 支持模型下载、校验、选择、删除和状态查看。
- 提供 Unix Socket 管理协议和 `POST /v1/audio/speech`。
- 支持空闲超时后终止 engine，完整释放原生运行时资源。
- 通过通用 Linux 二进制资产发布，并提供 AUR 二进制包。

首期不开发 GUI、多 TTS 引擎、高并发推理、在线账户、音频编辑器及其他桌面平台。

## 3. 技术决策

| 领域         | 决策                        |
| ------------ | --------------------------- |
| 产品代码     | TypeScript 7                |
| Node 运行时  | Node.js 24                  |
| 包管理       | Yarn 4、node-modules linker |
| 仓库结构     | Yarn Workspaces monorepo    |
| 测试         | Vitest；原生层使用 CTest    |
| 代码质量     | Oxlint、Oxfmt               |
| 配置         | YAML、schema 校验、原子保存 |
| 本地管理协议 | Unix Socket + JSON-RPC 2.0  |
| 外部 API     | OpenAI-compatible HTTP API  |
| 推理边界     | 独立 C++ executable         |
| Engine 协议  | stdio + JSON-RPC 2.0        |
| 原生 JSON    | Glaze 7.9.0                 |
| 原生构建     | C++23、CMake、Ninja         |
| 服务管理     | systemd 用户服务            |
| 日志         | stdout/stderr 交给 journald |

## 4. 运行时架构

```text
CLI / Desktop / 外部工具
            │
            │ Unix Socket + JSON-RPC 2.0
            ▼
    voxspeech-daemon ◄──── OpenAI-compatible HTTP API
    配置 / 模型 / Voice
    队列 / API / 生命周期
            │
            │ stdio + JSON-RPC 2.0
            ▼
    voxspeech-engine
            │
            ▼
    qwentts.cpp / GGML
```

daemon 是唯一产品编排者。CLI 只解析输入并调用 daemon；HTTP 只做协议适配；C++ engine
只加载模型、提取 Voice Reference、执行合成、流式返回 PCM 和处理取消。两层 JSON-RPC
的 framing、方法、通知、错误与生命周期见 `docs/protocol.md`。

engine 在一个进程中只持有一个模型 context。切换模型或空闲卸载时结束整个进程，由操作
系统回收原生资源。engine 异常退出不得导致 daemon 退出。

## 5. 包边界

- `protocol`：公共请求、响应、RPC 与配置数据类型。
- `config`：XDG 路径、YAML 解析、schema 迁移与原子持久化。
- `core`：请求规范化、模型/Voice 兼容性、队列与生命周期规则。
- `engine-client`：启动 engine、帧协议、流式 PCM、取消、退出和错误映射。
- `model-downloader`（对外发布为 `@tinyaxis/model-downloader`）：多连接分块下载、
  跨进程断点恢复、Hugging Face 端点/镜像与文件树发现、代理、校验与原子落盘，
  同时提供 `model-downloader` CLI 与 npm API。
- `daemon`：文件、网络、模型仓库、Voice 仓库、HTTP、RPC 与 systemd 运行时。
- `cli`：用户输入输出、文件输出、stdin 与播放命令。

依赖方向固定为应用依赖包；`core` 不依赖 daemon、CLI 或原生实现；C++ 不承载产品配置
与下载逻辑。

## 6. 数据布局

```text
~/.config/voxspeech/config.yaml
~/.local/share/voxspeech/models/
~/.local/share/voxspeech/voices/
~/.cache/voxspeech/downloads/
$XDG_RUNTIME_DIR/voxspeech/daemon.sock
```

Voice Profile 使用独立目录保存 `voice.yaml`、speaker embedding 与 reference codes。
模型目录由内置 catalog 管理，用户配置只保存稳定模型 ID，不保存下载 URL 或校验和。

## 7. CLI 能力面

稳定命令组规划为：

```text
voxspeech setup
voxspeech status
voxspeech diagnostics
voxspeech speak
voxspeech model <list|install|verify|use|remove>
voxspeech voice <list|clone|show|use|remove>
voxspeech config <path|show|validate|apply>
voxspeech service <status|start|stop|restart|enable|disable>
```

GUI 在未来只能调用同一 daemon 能力，不能形成第二套业务实现。

## 8. 安全与可靠性

- HTTP 默认仅监听 `127.0.0.1`。
- 模型必须在 SHA256 校验通过后原子进入可用目录。
- Hugging Face 下载端点可配置，默认为 `https://huggingface.co`，可通过配置、
  CLI `--hub-url` 或 `HF_ENDPOINT` 指向兼容镜像；显式配置优先。模型 catalog 只保存
  repo/revision/path，不把镜像写死在模型条目中。
- 下载支持显式代理和 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量；显式配置
  优先，无代理时不改写请求。
- 下载必须支持多连接 Range 分块和进程退出后恢复；同一目标同时只允许一个
  写入者。
- 配置和 Voice 元数据使用临时文件、fsync 与 rename 原子提交。
- 下载支持中断恢复，但未完成文件不得被识别为模型。
- 合成请求有明确大小限制、排队上限和取消语义。
- engine 私有协议设版本号、长度上限和未知消息拒绝策略。
- Voice 数据目录只允许当前用户访问。

## 9. 发布边界

程序包携带固定 Node.js 24 runtime、TypeScript 构建产物和原生 engine。模型不进入默认
程序包，由 `voxspeech setup` 下载到用户数据目录。首个正式支持的原生后端以实机验收
结果为准，未完成真实验证的后端不进入发布承诺。
