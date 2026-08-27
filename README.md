# VoxSpeech

面向 Linux 的轻量本地 TTS Runtime。项目以 TypeScript 承载产品逻辑，以独立 C++
进程承载原生推理，通过 CLI、Unix Socket 和 OpenAI-compatible HTTP API 提供能力。

当前仓库已完成 P3：真实原生推理、YAML 配置、模型安装与校验、Voice Profile、Unix
Socket JSON-RPC daemon，以及基于 Commander 的完整 CLI 已贯通。

## 技术栈

- Node.js 24
- TypeScript 7
- Yarn 4
- Vitest
- C++23、CMake 与 Ninja

## 工作区

```text
apps/
  cli/                 用户命令行
  daemon/              常驻服务与 API
packages/
  protocol/            公共协议与数据类型
  config/              YAML 配置与 XDG 路径
  core/                与运行时无关的产品规则
  engine-client/       原生推理子进程客户端
native/
  engine/              VoxSpeech C++ 推理适配器
  third_party/         固定版本的原生上游依赖
```

## 开发命令

```bash
yarn install
yarn tiny check
```

首次准备模型并构建全部原生后端：

```bash
yarn tiny native/models
yarn tiny native/build
```

模型和增量构建产物固定保存在 Git 已忽略的 `.cache/voxspeech` 中。也可以只构建一个后端：

```bash
yarn tiny native/build/cpu
yarn tiny native/build/cuda
yarn tiny native/build/vulkan
```

真实 CLI 链路需要两个终端。第一个终端前台启动 daemon；它会一直运行并持续显示 native
engine 日志，直到按下 `Ctrl+C`：

```bash
yarn tiny daemon
```

再次运行同一命令会先结束占用 VoxSpeech Socket 的旧 daemon，再启动新实例，不需要手工清理
进程或 Socket。

首次启动默认加载 0.6B Q8_0 与 Vulkan；之后无参数启动会沿用 `model use` 和配置中保存的
模型与后端。可以显式覆盖：

```bash
yarn tiny daemon --model 1.7b --backend cuda
```

开发 daemon 会把 `yarn tiny native/models` 准备的两个模型都注册到产品模型仓库。切换后
重新运行 daemon 即可加载新模型；旧实例会被自动替换：

```bash
yarn tiny cli model use qwen3-tts-1.7b-base-q4_k_m
yarn tiny daemon
```

第二个终端直接使用产品 CLI：

```bash
yarn tiny cli status
yarn tiny cli model list
yarn tiny cli voice list
yarn tiny cli voice clone '甜妹助理' reference.wav "参考音频的准确文本"
yarn tiny cli speak "你好，这是命令行真实链路测试。" --output /tmp/voxspeech-cli.wav --play
```

Voice 名称是用户数据，支持中文、空格、路径字符、标点和 emoji。内部使用名称的 SHA-256
作为存储目录；重复执行 `voice clone` 会原子更新同名 Profile，不需要先删除。

这两个入口自动使用同一个开发态 Unix Socket：
`$XDG_RUNTIME_DIR/voxspeech/daemon.sock`，不需要手工设置 engine 或 XDG 环境变量。配置、模型
安装和下载缓存仍隔离在仓库的 `.cache/voxspeech/dev` 中；保留系统 runtime 目录可确保
`--play` 正常连接 PipeWire。

详细设计与实施顺序见：

- [技术规划](docs/technical-plan.md)
- [开发路线图](docs/development-roadmap.md)
- [JSON-RPC 协议规范](docs/protocol.md)
- [项目架构决策](docs/decisions/project-architecture.md)
- [原生进程边界](docs/decisions/native-process-boundary.md)
- [P3 验收报告](docs/p3-product-state-acceptance.md)
