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

开发态运行：

```bash
VOXSPEECH_ENGINE=/path/to/voxspeech-engine yarn tiny daemon
yarn tiny cli setup
# setup 会提示重启 daemon，使选中的模型在受控启动时加载
yarn tiny cli voice clone assistant reference.wav "参考音频文本"
yarn tiny cli voice use assistant
yarn tiny cli speak "你好" --output speech.wav
```

详细设计与实施顺序见：

- [技术规划](docs/technical-plan.md)
- [开发路线图](docs/development-roadmap.md)
- [JSON-RPC 协议规范](docs/protocol.md)
- [项目架构决策](docs/decisions/project-architecture.md)
- [原生进程边界](docs/decisions/native-process-boundary.md)
- [P3 验收报告](docs/p3-product-state-acceptance.md)
