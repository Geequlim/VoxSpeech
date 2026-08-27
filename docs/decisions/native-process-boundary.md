# 原生进程边界

> 状态：已接受

## 决策

daemon 通过子进程使用 `voxspeech-engine`，不使用 Node Native Addon。engine 与 daemon
一起发布、一起验证，但拥有独立地址空间和生命周期。

## 协议方向

- stdin：daemon 写入换行分隔的 JSON-RPC request 和 notification。
- stdout：engine 写入换行分隔的 JSON-RPC response 和 notification。
- stderr：原生日志。
- 流式 PCM16 通过 Base64 编码的 `speech.audio` notification 返回。
- 每个 request 使用非空字符串 ID，支持取消、最终 response 和 error response。
- 单条 UTF-8 JSON 消息最大 1 MiB；解码后的单个 PCM chunk 最大 64 KiB。

完整规范见 `docs/protocol.md`。TypeScript 使用 TypeBox 定义和校验 schema，C++ 使用
vendored Glaze 7.9.0 定义 JSON-RPC 类型；双方通过共享 golden fixtures 做契约测试。

## 生命周期

- daemon 按需启动 engine 并等待 ready。
- 一个 engine 进程只加载一个模型 context。
- 切换模型时先停止旧进程，再启动新进程。
- 空闲超时后正常结束 engine。
- engine 崩溃时 daemon 保持运行，当前请求失败，后续请求可重新拉起 engine。

## C++ 职责限制

C++ 只负责加载模型、提取 Voice Reference、合成、流式 PCM、取消、日志和资源释放。
配置文件、网络服务、模型下载、用户目录、Voice 元数据和 systemd 管理全部留在 TypeScript。
