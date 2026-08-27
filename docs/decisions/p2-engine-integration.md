# P2 Engine 集成契约

> 状态：已冻结
>
> 生效范围：P2 真实 Engine 端到端集成
>
> 基线：`docs/protocol.md` 的 JSON-RPC version 1

## 1. 阶段边界

P2 只把 P1 已验证的产品链路和原生推理链路接通：

```text
CLI
→ Unix Socket JSON-RPC
→ daemon
→ EngineClient
→ stdio JSON-RPC
→ voxspeech-engine
→ qwentts.cpp
→ streaming PCM16
```

P2 包含真实模型加载、合成、流式音频、取消、Voice Reference 提取、进程退出和错误传播。
P2 不实现模型 catalog、模型安装、YAML 用户配置、Voice Profile 仓库、请求队列、自动崩溃
恢复、HTTP API 或 systemd；这些能力仍属于 P3/P4。

`packages/protocol`、`docs/protocol.md` 和 `test/fixtures/protocol/v1` 在执行任务中只读。
如果实现需要改变 version 1 契约，执行 Agent 必须停止并报告，不得自行修改。

## 2. 目录所有权

| 执行线                 | 可修改目录                           | 禁止修改                                                |
| ---------------------- | ------------------------------------ | ------------------------------------------------------- |
| Native JSON-RPC 进程壳 | `native/engine/**`                   | qwentts.cpp submodule、协议、TS、根配置                 |
| daemon Engine 适配     | `apps/daemon/**`                     | CLI、EngineClient、协议、配置与模型下载器               |
| EngineClient 加固      | `packages/engine-client/**`          | daemon、Native、协议、公共 API                          |
| 主集成                 | 跨模块、构建配置、文档与真实 runtime | 已固定的 JSON-RPC version 1，除非先形成新的显式决策记录 |

三个执行任务不得修改 `package.json`、`yarn.lock`、`project.tiny`、根 CMake、`docs/**` 或
`native/third_party/**`。新增依赖、公共 API 变化和跨目录修改必须先由主集成裁决。

## 3. Native 进程边界

### 3.1 Server 与 Runtime 分层

Native JSON-RPC server 不直接包含 qwentts.cpp 调用。它只依赖一个可替换的 Runtime
接口，概念能力固定为：

```text
load(params) -> load result
status() -> engine status
synthesize(params, cancellation token, float audio sink) -> synthesis result
extractVoice(params) -> extraction result
shutdown() -> release runtime resources
```

Runtime 的头文件和类型位于 `native/engine/include/voxspeech/engine`。接口不得暴露
`qt_context`、GGML 类型或 qwentts.cpp 头文件。测试使用 deterministic fake runtime；
真实 qwentts runtime 由主集成实现。

Runtime audio sink 接收 24 kHz mono float32 PCM。Server 负责：

- clamp 到 `[-1, 1]`，按 `lrint(sample * 32767)` 转为 signed little-endian PCM16；
- 复制数据后放入输出队列，不在 qwentts callback 中阻塞写 stdout；
- Base64 编码，并保证解码后每个 chunk 不超过 64 KiB；
- 发出严格递增、从零开始的 `sequence`。

### 3.2 线程与输出

- 主线程持续读取和解析 stdin，不执行阻塞推理；
- 同时最多一个推理 worker；P2 的 `maxBatch` 只接受 `1`；
- 所有 response 和 notification 进入同一个有序 writer；只有 writer 可以写 stdout；
- stdout 只能包含紧凑 JSON-RPC NDJSON，所有日志写 stderr；
- 收到 stdin EOF 时执行无响应的有界 shutdown，然后退出；
- 单条输入或输出消息遵循 1 MiB 上限。

### 3.3 状态机

`docs/protocol.md` 的状态机保持不变。额外冻结以下行为：

- `initialize` 成功前，除 `initialize` 外的方法返回 `invalid_state`；
- 第二次 `initialize` 返回 `invalid_state`；
- `engine.load` 只允许在 `idle`，成功后本进程不允许再次加载；
- `speech.synthesize` 和 `voice.extract` 互斥；执行期间状态为 `busy`；
- `engine.status` 在所有未进入最终退出的状态都可调用；
- busy 时只允许 `engine.status`、匹配当前请求的 `speech.cancel` 和
  `engine.shutdown`；其他工作返回 `resource_busy`；
- `speech.cancel` 只有在目标 ID 等于当前合成 request ID 时返回
  `{ accepted: true }`，否则返回 `{ accepted: false }`；
- shutdown 在 busy 时先设置取消标记，等待 worker 返回，再释放 Runtime；原合成的
  cancelled error 必须先于 shutdown response 写出；
- shutdown response 写出后进程正常退出，后续输入不再处理。

### 3.4 流式时序与计时

成功接受合成后立即发送一次 `speech.started`，随后发送零到多个 `speech.audio`，最后发送
原 request 的 result。若 Runtime 在首个 chunk 前失败，仍保持 `started → error response`
的顺序。

计时口径固定为：

- `processingMs`：worker 开始调用 Runtime 到 Runtime 返回；
- `firstAudioMs`：worker 开始到第一个非空 audio chunk 进入 sink；
- `sampleCount`：所有成功提交给 sink 的样本总数；
- `durationMs`：`sampleCount * 1000 / 24000` 的整数除法结果；
- 没有产生音频的成功结果将 `firstAudioMs` 设为 `processingMs`。

## 4. qwentts Runtime 契约

### 4.1 构建产物

同一份源码在独立 build directory 中生成名为 `voxspeech-engine` 的单后端产物：

| 构建 profile | qwentts/ggml 配置                  | P2 load backend  |
| ------------ | ---------------------------------- | ---------------- |
| CPU          | `GGML_CUDA=OFF`、`GGML_VULKAN=OFF` | `auto`、`cpu`    |
| CUDA         | `GGML_CUDA=ON`、`GGML_STATIC=ON`   | `auto`、`cuda`   |
| Vulkan       | `GGML_VULKAN=ON`、`GGML_STATIC=ON` | `auto`、`vulkan` |

Runtime 不做跨产物后端切换。显式请求与编译 profile 不匹配时，`engine.load` 返回
`model_load_failed`。`auto` 选择该产物的编译后端；result/status 中保留 `auto`，P2 不新增
物理设备字段。

真实 Runtime 在第一次 `qt_init` 前设置进程内 `GGML_BACKEND`：CPU → `CPU`、CUDA →
`CUDA0`、Vulkan → `Vulkan0`；`auto` 清除外部继承的 `GGML_BACKEND` 后使用本 profile
默认值。P2 只选择设备 0，多 GPU 选择留到后续配置阶段。

构建使用 qwentts.cpp 固定 submodule，不复制、不修改上游源码。测试 fixture executable
只链接 fake runtime，不链接 qwentts.cpp。

### 4.2 加载与模型类型

- `talkerPath` 和 `codecPath` 必须是可读普通文件；
- 在 `qt_init` 前读取 talker GGUF 的 `general.architecture`，必须为 `qwen3-tts`；
- `modelType` 只允许读取 GGUF 元数据 `qwen3-tts.model_type`，禁止根据文件名推断；
- `qt_init_params.max_batch` 固定为 1；
- `qt_init_params.use_fa` 使用上游默认值；
- `qt_version()` 作为 `runtimeVersion`；
- 任何部分加载失败都必须释放已创建资源并返回 `model_load_failed`。

### 4.3 合成与取消

- qwentts 的 float chunk callback 连接 Runtime audio sink；
- cancellation token 通过 `qt_cancel_cb` 每帧轮询；
- `QT_STATUS_CANCELLED` 映射为 `request_cancelled`；
- `QT_STATUS_MODE_INVALID` 和 `QT_STATUS_INVALID_PARAMS` 映射为 JSON-RPC
  `invalid params`；
- OOM 和其他生成失败映射为 `synthesis_failed`，details 使用当次
  `qt_last_error()` 的拷贝；
- `qt_last_error()` 指针不得跨下一次 qwentts 调用保存；
- `qt_free` 只在 worker 已结束后调用。

## 5. Voice Reference 文件契约

P2 使用与固定 qwentts.cpp revision 相同的无头格式：

- `.spk`：little-endian IEEE-754 float32 数组，长度为 `speakerDimension * 4`；
- `.rvq`：每个 code 11 bit，LSB-first 打包，逻辑布局 `[codebookCount, frameCount]`
  row-major，T/帧维最快，无 header；
- `codebookCount` 从 `qt_num_codebooks()` 获取；
- `.rvq` 的 frameCount 从文件位数、11 bit 和 codebookCount 推导，不能来自文件名；
- P2 运行平台为 little-endian Linux x86_64，不定义跨端序格式。

`voice.extract` 使用上游 WAV decoder 将输入转为 24 kHz mono float32，再调用
`qt_extract_voice_ref`。只有两个输出文件都完整写入后才返回成功；失败或取消必须尽力删除
本次创建的两个输出。输出路径由 daemon 提供，Engine 不执行最终 rename。

`speech.synthesize.reference` 读取上述两个文件，并在提交给 qwentts 前验证非空、大小可整除、
codebook/frame 布局合法。speaker dimension 最终由 qwentts 对当前模型 hidden size 再校验。

## 6. EngineClient 契约

P2 保持 `packages/engine-client` 现有公共 API：`spawn`、`load`、`status`、
`startSynthesis`、`cancel`、`extractVoice` 和 `shutdown`。执行任务不得改方法签名或协议类型。

额外冻结：

- unexpected response ID、notification request ID、重复 `speech.started`、audio sequence
  跳号/重复均视为协议失败，终止子进程并拒绝全部 pending；
- Base64 必须是 canonical RFC 4648；解码后必须非空、偶数字节且不超过 64 KiB；
- synthesis result 前必须已经收到 `speech.started`，所有 audio 必须先于 result；
- generic request timeout 只拒绝对应 request；合成取消由 daemon 的 AbortSignal 显式调用
  `SynthesisHandle.cancel()`，EngineClient 不自行猜测取消策略；
- child 异常退出拒绝全部 pending，并保留 exit code、signal 和 stderr；
- stderr 只作诊断，不进入协议解析；P2 将内存中保留的 stderr 尾部限制为 256 KiB；
- `shutdown()` 幂等，超时后依次使用 SIGTERM 和 SIGKILL，最终等待 child close。

## 7. daemon 适配契约

daemon 内部合成服务固定为可注入边界，能力为：

```text
run(params, AbortSignal, onChunk) -> SpeechResult
audio metadata -> pcm_s16le / 24000 Hz / mono
status() -> engine state summary
close() -> bounded engine shutdown
```

现有 fake synthesis 继续实现该边界，仅供单元测试。真实实现组合一个已初始化并已加载的
EngineClient；模型路径和 backend 通过构造参数显式注入，不读取尚未实现的 P3 配置。

P2 的 daemon 映射规则：

- `input` → engine `text`；`language ?? "auto"` → engine `language`；
- `instruct` 原样传递；sampling 固定为 `{ seed: -1, maxNewTokens: 2048 }`；
- `voice` 非空时返回 `invalid_state`，P2 不把 Voice ID 当成文件路径；
- EngineClient 的 started/audio/result 保持顺序转发，不重新切 chunk；
- Unix Socket 客户端取消或断开时，最多调用一次 engine cancel；
- engine crash 使当前请求返回可重试的 `synthesis_failed`，daemon 仍保持监听；P2 不自动
  重启 engine；
- daemon close 先停止接受新合成并取消活动请求，再执行 engine shutdown；
- `daemon.status.engine` 反映 EngineClient status，`modelId` 在 P2 保持 `null`。

`startDaemonServer` 的测试默认 fake 行为可以暂时保留以兼容 P1 测试，但产品/真实集成入口
必须显式传入真实 synthesis service。

## 8. 错误映射

| 场景                           | JSON-RPC code | stable code               | retryable |
| ------------------------------ | ------------: | ------------------------- | --------- |
| 协议版本不匹配                 |      `-32001` | protocol_version_mismatch | false     |
| 生命周期不允许                 |      `-32002` | invalid_state             | false     |
| 模型、backend 或 GGUF 加载失败 |      `-32003` | model_load_failed         | false     |
| qwentts 合成/OOM/engine crash  |      `-32004` | synthesis_failed          | true      |
| 用户或 shutdown 取消           |      `-32005` | request_cancelled         | false     |
| Voice 提取或文件写入失败       |      `-32006` | voice_extraction_failed   | false     |
| 同时提交第二个工作             |      `-32007` | resource_busy             | true      |

`stage` 固定使用触发失败的方法名，例如 `engine.load`、`speech.synthesize`、
`voice.extract` 或 `engine.shutdown`。内部错误细节只进入 `details` 和 stderr，不改变稳定
code/message。

## 9. P2 最终验收门

- 三个执行任务的目标测试和全量 `yarn tiny check` 通过；
- CPU、CUDA、Vulkan profile 均能构建 `voxspeech-engine`；
- 0.6B Base 在 CPU、CUDA、Vulkan 完成真实 CLI → daemon → engine 流式闭环；
- 1.7B Base 至少在 CUDA 和 Vulkan 完成加载与一次流式合成；
- 首个 PCM 在最终 response 前到达，输出为合法 24 kHz mono PCM16；
- Ctrl+C 传播到 qwentts cooperative cancellation；
- engine crash 不导致 daemon 退出，当前请求得到确定错误；
- 连续请求不串流、不复用 request ID；
- Voice Reference 提取、文件校验和 latent 复用通过；
- shutdown 后 engine 正常退出，GPU 显存回到启动前波动范围；
- 由用户完成至少一次中文试听确认。
