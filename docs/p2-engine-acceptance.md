# P2 真实 Engine 集成验收

> 状态：实现与自动化验收完成，等待中文试听确认
>
> 日期：2026-08-28
>
> 契约：`docs/decisions/p2-engine-integration.md`

## 1. 已交付链路

```text
CLI
→ Unix Socket JSON-RPC
→ daemon synthesis service
→ EngineClient
→ stdio JSON-RPC
→ voxspeech-engine
→ qwentts.cpp
→ streaming PCM16
```

真实 daemon 启动入口显式接收 engine executable、talker、codec、backend 和 socket
路径，不读取 P3 才会实现的用户配置。qwentts Runtime 通过固定 submodule 的 CMake overlay
构建，上游源码保持不变。

## 2. 构建结果

| Profile | 关键配置                                             | `voxspeech-engine` |
| ------- | ---------------------------------------------------- | ------------------ |
| CPU     | `GGML_CUDA=OFF`、`GGML_VULKAN=OFF`                   | 通过               |
| CUDA    | `GGML_CUDA=ON`、`GGML_STATIC=ON`、device `CUDA0`     | 通过               |
| Vulkan  | `GGML_VULKAN=ON`、`GGML_STATIC=ON`、device `Vulkan0` | 通过               |

三个产物均为单后端构建。显式 backend 与产物不匹配时拒绝加载；`auto` 选择当前产物的
固定后端。

## 3. 真实模型矩阵

| 模型              | CPU  | CUDA | Vulkan | 验证范围                            |
| ----------------- | ---- | ---- | ------ | ----------------------------------- |
| 0.6B Base Q4_K_M  | 通过 | 通过 | 通过   | 完整 CLI → daemon → engine 流式闭环 |
| 1.7B Base Q4_K_M  | —    | 通过 | 通过   | 加载、取消、流式合成、正常 shutdown |
| 12Hz Codec Q4_K_M | 通过 | 通过 | 通过   | 与上述 talker 组合加载              |

0.6B 三个 profile 的输出均经文件识别为 RIFF/WAVE、24 kHz、mono、signed PCM16。
CPU 的独立 8-frame smoke 产生 15,360 samples，`firstAudioMs=116`，最终 response 在全部
audio notification 之后到达。

## 4. Voice Reference

- 使用上游 WAV decoder 转换为 24 kHz mono float32；
- `.spk` 按 little-endian float32 写入；
- `.rvq` 按 11-bit LSB-first、`[K,T]` row-major 写入；
- 从文件位数与 `qt_num_codebooks()` 恢复 frame count，并拒绝非法 size/padding；
- CUDA 0.6B Base 已完成 `voice.extract`、文件读取校验与 latent 再合成；
- 输出创建使用 exclusive file create，失败时清理本次已创建的文件，不覆盖已有文件。

## 5. 故障与生命周期

| 场景                        | 结果                                     |
| --------------------------- | ---------------------------------------- |
| cooperative cancellation    | CPU、CUDA、Vulkan 真实 Runtime 均通过    |
| engine crash                | daemon 保持监听并返回可重试错误          |
| protocol framing/order 错误 | EngineClient 终止 session 并拒绝 pending |
| stderr 与 stdout 隔离       | 通过                                     |
| shutdown                    | 子进程正常退出，无残留 engine 进程       |
| Voice 文件损坏              | size、padding、code range 校验通过       |

默认测试继续使用 deterministic fake runtime。根目录的 `p2-real.test.ts` 只有在提供
`VOXSPEECH_P2_ENGINE`、`VOXSPEECH_P2_TALKER`、`VOXSPEECH_P2_CODEC` 和
`VOXSPEECH_P2_BACKEND` 时才执行真实硬件验收；可选
`VOXSPEECH_P2_REFERENCE_WAV` 会启用 Voice Reference 提取与 latent 复用。

## 6. 剩余验收

P2 自动化门槛已经完成。阶段仍停在 P2，不启动 P3；最后只需要用户试听至少一份中文输出并
确认音频内容与听感正常。
