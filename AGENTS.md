# VoxSpeech 编码代理指南

## 开始工作前

- 修改代码前阅读 `docs/technical-plan.md`、`docs/development-roadmap.md` 与相关架构决策。
- 代码编写、审查、重构和测试遵守 karpathy-guidelines。
- 用户仍在讨论方案时，只做只读探索；明确要求实施后才修改文件。

## 工程约定

- TypeScript 使用 TypeScript 7，包管理器使用 Yarn 4，测试使用 Vitest。
- TypeScript 与 C++ 使用 tab 缩进和 LF 换行；YAML 使用两个空格缩进。
- 产品逻辑优先放在 TypeScript 中，C++ 仅承载原生推理适配。
- CLI 和 HTTP API 不重复实现业务逻辑，统一调用 daemon/core 能力。
- 不手工修改 `yarn.lock`；依赖变更后运行 Yarn 安装命令更新。
- 临时文件放在 `/tmp`、`.temp` 或 `.cache`，不要散落进源码目录。

## 验证

完成代码修改后执行：

```bash
yarn tiny fix-worktree
yarn tiny check
```
