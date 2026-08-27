# VoxSpeech JSON-RPC 协议规范

> 协议版本：1
>
> 状态：已确认

## 1. 通信边界

VoxSpeech 使用两条 JSON-RPC 2.0 链路：

```text
CLI / Desktop / 外部工具
            │
            │ Unix Socket + JSON-RPC 2.0
            ▼
    voxspeech-daemon
            │
            │ stdio + JSON-RPC 2.0
            ▼
    voxspeech-engine
```

Unix Socket 是 daemon 的公共本地控制面，允许多个独立客户端连接。stdio 是 daemon 与
其私有 engine 子进程之间的一对一链路。OpenAI-compatible HTTP API 不复用 JSON-RPC
传输，但必须调用与 daemon RPC 相同的业务服务。

## 2. 通用 framing

两条链路统一采用 NDJSON：

- 每条消息是一个紧凑 JSON-RPC 2.0 object；
- 每条消息后追加一个 LF；
- JSON 字符串内的换行必须转义，一个物理行始终等于一条完整消息；
- 单条 UTF-8 消息最大 1 MiB；
- request `id` 必须是非空字符串；
- notification 不含 `id`；
- 同一连接上的输出必须串行写入，保持物理消息顺序；
- 未知字段默认拒绝，新增可选字段必须保持向后兼容。

收到无法解析的 JSON 时返回标准 parse error。消息超过限制、stdout 混入非协议内容或
连续发生 framing 错误时，接收方关闭连接；daemon 与 engine 链路出错时由 daemon 结束
该 engine 进程。

## 3. 通用初始化

每条新连接的第一条 request 必须是 `initialize`：

```json
{
	"jsonrpc": "2.0",
	"id": "1",
	"method": "initialize",
	"params": { "protocolVersion": 1, "clientInfo": { "name": "voxspeech-cli", "version": "0.1.0" } }
}
```

result 返回 `protocolVersion`、`serverInfo` 和 `capabilities`。版本不兼容时返回
`-32001`，连接方不得继续发送其他业务请求。

## 4. Daemon 公共 RPC

### 4.1 生命周期与诊断

| Method            | 用途                                             |
| ----------------- | ------------------------------------------------ |
| `initialize`      | 协商协议与客户端能力                             |
| `daemon.status`   | 返回 daemon、engine、当前模型、Voice 和 API 状态 |
| `diagnostics.get` | 返回配置、模型、engine 和最近错误的只读诊断      |

### 4.2 合成

| Method              | 用途                                   |
| ------------------- | -------------------------------------- |
| `speech.synthesize` | 提交一次流式合成，request 保持 pending |
| `speech.cancel`     | 取消仍在执行或排队的合成 request       |

`speech.synthesize` params：

```json
{
	"input": "任务已经完成。",
	"voice": "assistant",
	"language": "Chinese",
	"instruct": "自然、清晰地播报"
}
```

engine 准备完成后 daemon 发送 `speech.started`，随后发送零到多个 `speech.audio`。
合成成功以原 request 的 result 收口，失败或取消以 error response 收口；不额外发送
`speech.completed` 或 `speech.failed`。

### 4.3 模型

| Method          | 用途                             |
| --------------- | -------------------------------- |
| `model.list`    | 列出 catalog、安装状态和当前模型 |
| `model.install` | 下载、校验并原子安装模型         |
| `model.verify`  | 重新校验已安装模型               |
| `model.use`     | 设置默认模型                     |
| `model.remove`  | 删除未被活动请求占用的模型       |

### 4.4 Voice

| Method         | 用途                                        |
| -------------- | ------------------------------------------- |
| `voice.list`   | 列出 Voice Profile                          |
| `voice.clone`  | 从参考 WAV 和 transcript 创建 Voice Profile |
| `voice.show`   | 返回一个 Voice Profile 的元数据             |
| `voice.use`    | 设置默认 Voice                              |
| `voice.remove` | 删除未被活动请求占用的 Voice                |

### 4.5 配置

| Method            | 用途                     |
| ----------------- | ------------------------ |
| `config.get`      | 返回当前配置对象         |
| `config.validate` | 校验配置但不保存         |
| `config.update`   | 校验、原子保存并应用配置 |

`setup` 和 `service` 是 CLI orchestration，不增加同名 daemon RPC：`setup` 组合模型、Voice
和配置方法，`service` 直接管理 systemd 用户服务。

### 4.6 长操作进度

模型安装、校验和 Voice Clone 可以发送：

```json
{
	"jsonrpc": "2.0",
	"method": "operation.progress",
	"params": {
		"requestId": "install-1",
		"phase": "downloading",
		"completed": 1048576,
		"total": 1540000000
	}
}
```

进度 notification 只提供展示信息，不代表事务已经提交；最终 result 才表示操作完成。

## 5. Engine 私有 RPC

### 5.1 生命周期

engine 状态机：

```text
starting → idle → loading → ready → busy → ready
                         └───────────────→ stopping
```

第一条 request 必须是 `initialize`。一个 engine 进程只加载一个模型 context；切换模型由
daemon 结束旧进程并启动新进程完成。

| Method              | 允许状态         | 用途                                       |
| ------------------- | ---------------- | ------------------------------------------ |
| `initialize`        | `starting`       | 协商协议，进入 `idle`                      |
| `engine.load`       | `idle`           | 加载 talker 和 codec，进入 `ready`         |
| `engine.status`     | 任意             | 返回状态、backend、模型类型和 runtime 版本 |
| `speech.synthesize` | `ready`          | 执行一次合成                               |
| `speech.cancel`     | `busy`           | 取消指定合成 request                       |
| `voice.extract`     | `ready`          | 使用 Base 模型提取 Voice Reference         |
| `engine.shutdown`   | 除 `stopping` 外 | 取消活动工作、释放资源并退出               |

### 5.2 `engine.load`

```json
{
	"talkerPath": "/data/models/talker.gguf",
	"codecPath": "/data/models/tokenizer.gguf",
	"backend": "cuda",
	"maxBatch": 1
}
```

`backend` 允许 `auto`、`cuda`、`vulkan` 和 `cpu`。V1 发布默认 `maxBatch` 为 1。

### 5.3 `speech.synthesize`

params 使用 engine 已加载模型，不接受产品层的 Voice ID。daemon 必须先把 Voice Profile
解析成 named speaker 或 reference 文件：

```json
{
	"text": "任务已经完成。",
	"language": "Chinese",
	"speaker": null,
	"instruct": null,
	"reference": {
		"speakerPath": "/data/voices/assistant/speaker.spk",
		"codesPath": "/data/voices/assistant/reference.rvq",
		"text": "参考音频对应的文本"
	},
	"sampling": {
		"seed": -1,
		"maxNewTokens": 2048
	}
}
```

`speaker` 与 `reference` 互斥。具体模型模式不支持某组参数时返回 invalid params 或 model
mode error，不进行隐式降级。

### 5.4 `voice.extract`

daemon 负责准备合法 WAV 和临时输出路径：

```json
{
	"audioPath": "/tmp/voxspeech/ref.wav",
	"speakerOutputPath": "/tmp/voxspeech/speaker.spk.new",
	"codesOutputPath": "/tmp/voxspeech/reference.rvq.new"
}
```

engine 只写临时结果。校验、元数据和最终原子提交由 daemon 完成。该方法只允许 Base
模型调用，result 返回 speaker dimension、codebook count 和 frame count。

## 6. 流式音频

`speech.started`：

```json
{
	"jsonrpc": "2.0",
	"method": "speech.started",
	"params": { "requestId": "synth-1", "encoding": "pcm_s16le", "sampleRate": 24000, "channels": 1 }
}
```

`speech.audio`：

```json
{
	"jsonrpc": "2.0",
	"method": "speech.audio",
	"params": { "requestId": "synth-1", "sequence": 0, "data": "AAE=" }
}
```

约束：

- 固定输出为 24 kHz、单声道、signed 16-bit little-endian PCM；
- `data` 使用 RFC 4648 Base64，不包含空白；
- Base64 解码后的单个 chunk 最大 64 KiB；
- `sequence` 从零开始严格递增；
- `speech.started` 必须先于同 request 的所有 `speech.audio`；
- 最后一个 audio notification 必须先于最终 response；
- daemon 转换 WAV 或 HTTP response，engine 不编码产品输出格式。

## 7. 并发与取消

- JSON I/O 循环不得被推理阻塞；
- engine 在独立推理线程中执行阻塞合成；
- `speech.cancel` 通过原子取消状态传入推理回调；
- V1 daemon 同时只向 engine 提交一个活动推理，其他请求在 daemon 有界排队；
- `speech.cancel` 的 `accepted` 只表示取消信号已送达；原合成 request 最终返回 cancelled
  error；
- `engine.shutdown` 会停止接收新请求、取消活动工作、等待推理线程结束、释放资源，写出
  shutdown response 后退出。

## 8. 错误

标准 JSON-RPC 错误码保持原定义：

|     Code | 含义             |
| -------: | ---------------- |
| `-32700` | parse error      |
| `-32600` | invalid request  |
| `-32601` | method not found |
| `-32602` | invalid params   |
| `-32603` | internal error   |

VoxSpeech 自定义错误：

|     Code | 稳定名称                    | 含义                     |
| -------: | --------------------------- | ------------------------ |
| `-32001` | `protocol_version_mismatch` | 协议版本不兼容           |
| `-32002` | `invalid_state`             | 当前生命周期不允许该操作 |
| `-32003` | `model_load_failed`         | 模型加载失败             |
| `-32004` | `synthesis_failed`          | 合成失败                 |
| `-32005` | `request_cancelled`         | 请求已取消               |
| `-32006` | `voice_extraction_failed`   | Voice Reference 提取失败 |
| `-32007` | `resource_busy`             | 模型或 Voice 正被使用    |
| `-32008` | `integrity_check_failed`    | 模型或数据校验失败       |

`error.data` 使用统一结构：

```json
{
	"code": "model_load_failed",
	"stage": "engine.load",
	"retryable": false,
	"details": "可供用户理解的简短诊断"
}
```

错误不得携带原始 PCM、内存地址或调用栈。

## 9. 实现与兼容性

- TypeScript schema 和类型位于 `packages/protocol`，使用 TypeBox；
- C++ 类型位于 `native/engine`，使用 vendored Glaze 7.9.0；
- 双方必须读取相同 golden fixtures；
- 修复实现 bug 不提升协议版本；
- 增加可选字段保持 version 1；
- 删除字段、改变字段含义、改变 framing 或时序语义时提升协议版本；
- daemon 公共 RPC 与 engine 私有 RPC 可以独立增加 method，但不得复用同名 method 表达
  不同语义。
