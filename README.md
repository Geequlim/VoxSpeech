# VoxSpeech

面向 Linux 的轻量本地 TTS Runtime。项目以 TypeScript 承载产品逻辑，以独立 C++
进程承载原生推理，通过 CLI、Unix Socket 和 OpenAI-compatible HTTP API 提供能力。

当前仓库处于项目骨架阶段，尚未接入真实推理引擎。

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

详细设计与实施顺序见：

- [技术规划](docs/technical-plan.md)
- [开发路线图](docs/development-roadmap.md)
- [JSON-RPC 协议规范](docs/protocol.md)
- [项目架构决策](docs/decisions/project-architecture.md)
- [原生进程边界](docs/decisions/native-process-boundary.md)
