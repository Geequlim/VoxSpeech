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
                     └── packages/engine-client ── native/engine
```

- `protocol` 不依赖其他 workspace。
- `core` 只依赖 `protocol`，保持与进程和文件系统无关。
- `config` 负责配置，不启动服务或 engine。
- `engine-client` 负责原生进程，不管理模型 catalog 与用户配置。
- 应用可以组合 packages，packages 不反向依赖应用。

## 拆包原则

首期只保留四个共享包。模型下载、Voice 仓库和 HTTP 路由先留在 daemon 内部；只有出现
第二个独立使用者或明确发布边界时才拆分，避免预先建立无实际价值的包。
