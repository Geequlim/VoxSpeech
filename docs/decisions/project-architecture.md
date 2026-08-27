# 项目架构决策

> 状态：已接受

## 决策

VoxSpeech 使用 Yarn Workspaces monorepo。Node.js 与 TypeScript 是产品主体，独立 C++
进程是原生推理适配层。CLI、HTTP、模型管理和 Voice 管理共享 daemon/core 能力。

## 依赖方向

```text
apps/cli ─────────────┐
                     ├── packages/protocol
apps/daemon ─────────┼── packages/config
                     ├── packages/core
                     ├── packages/model-downloader
                     └── packages/engine-client ── native/engine
```

- `protocol` 不依赖其他 workspace。
- `core` 只依赖 `protocol`，保持与进程和文件系统无关。
- `config` 负责配置，不启动服务或 engine。
- `engine-client` 负责原生进程，不管理模型 catalog 与用户配置。
- `model-downloader` 负责可恢复的分块下载、端点/镜像、代理、校验与原子落盘，
  不决定安装哪个模型。它以 `@tinyaxis/model-downloader` 对外发布到 npm，
  仓库内以 workspace 依赖接入。
- 应用可以组合 packages，packages 不反向依赖应用。

## 拆包原则

首期保留五个共享包。下载能力同时被 native probe 和未来 daemon model install 使用，
因此独立为 `model-downloader`；model catalog、Voice 仓库和 HTTP 路由仍留在 daemon 内部。
