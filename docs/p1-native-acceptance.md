# P1 Native 后端验收

> 状态：CPU、CUDA、Vulkan 均通过真实模型 probe
>
> 记录日期：2026-08-27

> 纠正（2026-08-28）：本报告中的 0.6B Q4_K_M 数据只证明有限 frame 的性能和文件格式，
> 不代表 Vulkan 语音质量通过。后续完整生成发现该组合产生纯噪音且不生成 EOS；P3 产品
> catalog 已改用 0.6B Q8_0。以下 Q4_K_M 数据仅保留为历史性能记录。

## 测试结论

测试使用 Base Q4_K_M Talker、共享 Q4_K_M Tokenizer、相同文本和 24-token 输出。
RTF 小于 1 表示生成速度快于播放速度。数据用于本机选型，不是发布性能承诺。

### 1.7B 后端对比

| 对比项             | CPU               | CUDA            | Vulkan          |
| ------------------ | ----------------- | --------------- | --------------- |
| 模型加载           | 547.32 ms         | 692.10 ms       | 933.44 ms       |
| Buffered RTF       | 1.3029            | 0.1681          | 0.1704          |
| Streaming 首个 PCM | 175.28 ms         | 31.54 ms        | 32.38 ms        |
| Streaming RTF      | 1.0909            | 0.1431          | 0.1497          |
| 进程峰值系统内存   | 4.725 GiB         | 2.228 GiB       | 1.676 GiB       |
| 峰值显存增量       | 0                 | 3.514 GiB       | 3.373 GiB       |
| 后端定位           | 无 GPU 时兼容回退 | NVIDIA 默认后端 | 跨厂商 GPU 兼容 |

### 0.6B 后端对比

| 对比项             | CPU                   | CUDA            | Vulkan          |
| ------------------ | --------------------- | --------------- | --------------- |
| 模型加载           | 466.21 ms             | 623.65 ms       | 730.75 ms       |
| Buffered RTF       | 1.0767                | 0.1500          | 0.1506          |
| Streaming 首个 PCM | 101.48 ms             | 30.53 ms        | 26.49 ms        |
| Streaming RTF      | 0.8375                | 0.1210          | 0.1346          |
| 进程峰值系统内存   | 3.713 GiB             | 1.675 GiB       | 1.131 GiB       |
| 峰值显存增量       | 0                     | 3.119 GiB       | 2.964 GiB       |
| 后端定位           | 可实时运行的 CPU 回退 | NVIDIA 默认后端 | 跨厂商 GPU 兼容 |

Vulkan 0.6B 连续运行两次，第二次数据列入主表；两次 Streaming RTF 为
0.1251–0.1346，首个 PCM 为 24.18–26.49 ms，结果稳定在同一量级。

### 0.6B 相对 1.7B 的收益

| 对比项               | 1.7B      | 0.6B       | 变化                   |
| -------------------- | --------- | ---------- | ---------------------- |
| Talker 文件大小      | 1.135 GiB | 599.77 MiB | 减少 48.4%             |
| CPU 峰值内存         | 4.725 GiB | 3.713 GiB  | 减少 1.012 GiB / 21.4% |
| CPU Streaming RTF    | 1.0909    | 0.8375     | 提升 23.2%             |
| CUDA 峰值显存        | 3.514 GiB | 3.119 GiB  | 减少 0.395 GiB / 11.2% |
| CUDA Streaming RTF   | 0.1431    | 0.1210     | 提升 15.4%             |
| Vulkan 峰值显存      | 3.373 GiB | 2.964 GiB  | 减少 0.409 GiB / 12.1% |
| Vulkan Streaming RTF | 0.1497    | 0.1346     | 提升 10.1%             |

### 产品判断

- **0.6B 更适合 CPU**：已经快于实时播放，系统内存比 1.7B 少约 1 GiB；CPU-only
  用户应默认使用 0.6B。
- **0.6B 没有根治 GPU 显存问题**：CUDA/Vulkan 仍需约 3 GiB 峰值增量，考虑桌面和
  驱动占用后仍属于 4 GiB 显卡门槛。
- **CUDA 仍是 NVIDIA 默认后端**；Vulkan 稳态性能接近 CUDA、发布产物更小，适合作为
  跨厂商兼容后端。
- **1.7B 保留为大模型档**，不应成为 CPU 默认配置；本轮没有进行主观听感或客观音质
  评测，不能仅凭参数量判定两个模型的质量差异。

## 后端交付差异

| 对比项               | CPU                     | CUDA                       | Vulkan                           |
| -------------------- | ----------------------- | -------------------------- | -------------------------------- |
| 测试设备             | Intel Core Ultra 9 386H | RTX 5070 Ti Laptop         | RTX 5070 Ti Laptop               |
| 实际显存建议         | 不需要独立显存          | 至少约 4 GiB 可用          | 至少约 4 GiB 可用                |
| 首次运行额外成本     | 无                      | 无明显额外成本             | 建立 shader/pipeline cache       |
| 最终用户运行时       | 常规 Linux 系统库       | NVIDIA 驱动的 `libcuda.so` | 显卡驱动的 `libvulkan.so`        |
| 构建工具是否随包分发 | 不需要                  | 不需要 CUDA Toolkit        | 不需要 Vulkan SDK 或 shader 工具 |
| 本次 probe 产物大小  | 未统计（CPU overlay）   | 约 559 MiB                 | 约 52.3 MiB                      |

## Vulkan 首次预热

NVIDIA 驱动尚未建立该 probe 的 shader/pipeline cache 时，第一次 Vulkan 运行记录为：

| 指标               | 冷缓存首次进程 | 缓存建立后的新进程 |
| ------------------ | -------------- | ------------------ |
| 模型加载           | 1253.45 ms     | 933.44 ms          |
| Buffered RTF       | 4.0257         | 0.1704             |
| Streaming 首个 PCM | 987.20 ms      | 32.38 ms           |
| Streaming RTF      | 2.368          | 0.1497             |

这是一次性驱动缓存成本，不是 Vulkan 的稳定推理性能。产品首次启动 Vulkan 后端时需要
显式预热，并向调用方反馈进度。

## 验收范围

两个模型在三个后端上均通过以下能力：

- buffered 24 kHz mono PCM16 WAV；
- streaming PCM16，6 chunks / 46,080 samples；
- cooperative cancellation；
- 直接 reference clone 与预提取 latent clone；
- voice reference：1.7B 为 2048 维、0.6B 为 1024 维 speaker embedding，均为
  215 frames、16 codebooks；
- `qt_free` 后正常退出并回收资源。

Intel Vulkan 设备已成功枚举，但本轮未执行模型 probe。

## 固定输入

| 项目          | 固定值                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| qwentts.cpp   | `ServeurpersoCom/qwentts.cpp@a8a7716b530e49fed537c57711247c12fbbb903c` |
| ggml          | `ServeurpersoCom/ggml@c044c6f03892f9d5e98213b05f8afea1f8b0d3c9`        |
| GGUF revision | `Serveurperso/Qwen3-TTS-GGUF@e0f336a048a3de02b29b8ad92969217d9ecffe3e` |
| Talker 1.7B   | `qwen-talker-1.7b-base-Q4_K_M.gguf`，1,219,245,248 bytes               |
| Talker 0.6B   | `qwen-talker-0.6b-base-Q4_K_M.gguf`，628,905,056 bytes                 |
| Tokenizer     | `qwen-tokenizer-12hz-Q4_K_M.gguf`，254,974,752 bytes                   |

1.7B 和 Tokenizer 的大小、SHA256 由 `native/engine/probe/model-manifest.json` 固定。
0.6B 通过重构后的公共下载器 CLI 从同一固定 revision 发现并下载，LFS SHA256 为
`4b468ec7b1f62b90ef4ca316c0aa57deadfd54b2cf9651703ea753cedaf04226`。
下载器报告 `sha256` 校验通过；测试过程未修改下载器实现。

## 内存测量口径

- **系统内存**：probe 进程运行期间轮询 `/proc/<pid>/status` 的 `VmRSS`，取峰值；
- **显存**：以 100 ms 间隔采集 `nvidia-smi memory.used`，用峰值减去进程启动时读数；
- **1.7B CUDA/Vulkan**：CUDA 为 2177 → 5775 MiB，Vulkan 为 2003 → 5457 MiB；
- **0.6B CUDA/Vulkan**：CUDA 为 2096 → 5290 MiB，Vulkan 稳态复测为
  2090 → 5125 MiB；
- RSS 与显存不是同一种内存，不能相加后作为精确的最低硬件要求。

## 构建与依赖验证

- qwentts.cpp 和嵌套 ggml 子模块均保持固定 revision，工作区无修改；
- C ABI smoke 在 CPU、CUDA、Vulkan 构建中均通过；
- CUDA 静态 probe 不依赖 CUDA Toolkit 共享库，只依赖驱动 `libcuda.so.1`；
- Vulkan probe 内嵌 shader，只依赖 loader `libvulkan.so.1` 与常规系统库；
- 本机 CUDA probe 只针对 Blackwell `120a`，最终发布需要单独确定架构矩阵。

具体构建和复现命令见 `native/engine/probe/README.md`。
