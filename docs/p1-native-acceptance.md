# P1 Native 后端验收

> 状态：当前正式模型在 CPU、CUDA、Vulkan 三个后端均通过真实 probe
>
> 复测日期：2026-08-28

本报告记录当前产品模型的真实 native probe 复测结果。结论只适用于本机、固定
qwentts.cpp revision 和本报告列出的模型文件，不构成发布性能承诺。

## 测试结论

1.7B Base Q4_K_M 和 0.6B Base Q8_0 在 CPU、CUDA、Vulkan 六个组合中均完成
完整自然 EOS；没有一个组合跑满 `--max-new 256`。每次 probe 都成功完成
buffered、streaming、合作式取消、直接 reference clone 和预提取 latent clone。
输出信号非静音，WAV 均为 24 kHz、mono、PCM16。

GPU 复测在可访问 NVIDIA 驱动的环境中完成：CUDA 使用 `CUDA0`，Vulkan 使用
`Vulkan0`，设备为 NVIDIA GeForce RTX 5070 Ti Laptop GPU（12,227 MiB）。
受限沙箱内无法访问 GPU 设备或驱动接口属于执行环境限制，不记为 CUDA、Vulkan、
GPU 或驱动失败；GPU 验收结论只采用获得设备访问权限后的真实 probe 结果。

### 当前正式模型

| 模型             | Talker 文件                         |            大小 | SHA256                                                             |
| ---------------- | ----------------------------------- | --------------: | ------------------------------------------------------------------ |
| 1.7B Base Q4_K_M | `qwen-talker-1.7b-base-Q4_K_M.gguf` | 1,219,245,248 B | `ea393ebaf2167ea23ce9fc18b093822851358a950d7075cd47ab4f6ce23e887d` |
| 0.6B Base Q8_0   | `qwen-talker-0.6b-base-Q8_0.gguf`   |   992,615,488 B | `d54dbaf10591421fa764ed630d764efa717ae40cd959bd48c66d4eb1af226426` |

两者共享 `qwen-tokenizer-12hz-Q4_K_M.gguf`，254,974,752 B，SHA256
`cf3788b4d50aaa665fb6e57c170396aae03a3555fea52d2b5d0cda902d658039`。

### 性能和资源对比

`buffered RTF = bufferedMs / bufferedDurationMs`；`streaming RTF = streamMs /
(streamSamples / 24000)`。帧数按 12.5 Hz 计算，时长由实际输出 sample 数计算。
RSS 为 100 ms 轮询的进程 `VmRSS` 峰值；GPU 显存为同一轮询口径下的峰值减启动
基线。

| 模型 / 后端   |      加载 | Buffered（帧 / 时长） | Buffered RTF | Streaming（帧 / 时长） |      TTFA | Streaming RTF | 峰值 RSS |  显存增量 |
| ------------- | --------: | --------------------: | -----------: | ---------------------: | --------: | ------------: | -------: | --------: |
| 1.7B / CPU    | 571.81 ms |           45 / 3.60 s |       0.9531 |            51 / 4.08 s | 171.37 ms |        0.7622 | 4.89 GiB |      未测 |
| 0.6B / CPU    | 535.55 ms |           53 / 4.24 s |       0.9825 |            59 / 4.72 s | 109.02 ms |        0.8311 | 4.47 GiB |      未测 |
| 1.7B / CUDA   | 673.59 ms |           58 / 4.64 s |       0.1270 |            56 / 4.48 s |  33.91 ms |        0.1236 | 2.17 GiB | 3,850 MiB |
| 0.6B / CUDA   | 667.67 ms |           51 / 4.08 s |       0.1272 |            53 / 4.24 s |  33.34 ms |        0.1215 | 1.97 GiB | 3,683 MiB |
| 1.7B / Vulkan | 950.48 ms |           49 / 3.92 s |       0.1416 |            51 / 4.08 s |  26.70 ms |        0.1411 | 1.67 GiB | 3,717 MiB |
| 0.6B / Vulkan | 875.67 ms |           56 / 4.48 s |       0.1335 |            44 / 3.52 s |  29.68 ms |        0.1405 | 1.46 GiB | 3,452 MiB |

所有 buffered 输出都在对应 stderr 中报告了 EOS；streaming 的实际 frame 数分别
为 51、59、56、53、51、44，均低于 256 上限。六个输出目录中的
`buffered.wav`、`clone-reference.wav` 和 `clone-latent.wav` 均通过
`file` 检查：RIFF/WAVE、Microsoft PCM、16 bit、mono、24000 Hz。

### 能力验收

| 模型 / 后端   | Buffered | Streaming | Cancel         | Direct reference clone | Latent clone | Voice reference                     |
| ------------- | -------- | --------- | -------------- | ---------------------- | ------------ | ----------------------------------- |
| 1.7B / CPU    | 通过     | 通过      | 通过（1 poll） | 通过                   | 通过         | 2048 维 / 194 frames / 16 codebooks |
| 0.6B / CPU    | 通过     | 通过      | 通过（1 poll） | 通过                   | 通过         | 1024 维 / 194 frames / 16 codebooks |
| 1.7B / CUDA   | 通过     | 通过      | 通过（1 poll） | 通过                   | 通过         | 2048 维 / 194 frames / 16 codebooks |
| 0.6B / CUDA   | 通过     | 通过      | 通过（1 poll） | 通过                   | 通过         | 1024 维 / 194 frames / 16 codebooks |
| 1.7B / Vulkan | 通过     | 通过      | 通过（1 poll） | 通过                   | 通过         | 2048 维 / 194 frames / 16 codebooks |
| 0.6B / Vulkan | 通过     | 通过      | 通过（1 poll） | 通过                   | 通过         | 1024 维 / 194 frames / 16 codebooks |

probe 的退出码均为 0，`referenceCloneVerified` 和 `cloneLatentVerified` 均为
`true`。直接 clone 的输出时长为：1.7B CPU/CUDA/Vulkan 分别 3.04/2.64/2.88 s，
0.6B CPU/CUDA/Vulkan 均为 2.88 s；latent clone 分别为 3.20/2.96/3.28 s 和
3.28/3.36/3.52 s。

## 固定输入和测试口径

每个组合均使用以下真实 Voice Brief fixture 作为参考音频和逐字稿：

- 音频：`apps/daemon/test/fixtures/voice-brief/thoughtful.wav`
- 逐字稿：`apps/daemon/test/fixtures/voice-brief/thoughtful.txt`
- 逐字稿内容：目前整体流程已经验证完成，模型加载、音色提取和语音合成的结果都符合预期。需要留意的是，服务重启后仍要保持配置与音色状态一致，接下来我会继续核对这部分边界。
- 所有 probe：`--max-new 256`

probe 还固定执行以下合成文本：buffered 为“你好，这是 VoxSpeech 原生语音验证。”，
streaming 为“你好，这是 VoxSpeech 流式语音验证。”；取消用例在第一次轮询时
合作式取消。直接 clone 和 latent clone 使用 probe 内置中文文本，并共享上述
fixture 的逐字稿。

### 固定原生版本

| 组件          | Revision                                                               |
| ------------- | ---------------------------------------------------------------------- |
| qwentts.cpp   | `ServeurpersoCom/qwentts.cpp@a8a7716b530e49fed537c57711247c12fbbb903c` |
| ggml          | `ServeurpersoCom/ggml@c044c6f03892f9d5e98213b05f8afea1f8b0d3c9`        |
| GGUF revision | `Serveurperso/Qwen3-TTS-GGUF@e0f336a048a3de02b29b8ad92969217d9ecffe3`  |

CPU probe 使用 `/tmp/voxspeech-qwentts-cpu-probe/voxspeech-native-probe`；
CUDA probe 使用 `/tmp/voxspeech-qwentts-cuda-static-13.3-gpu/voxspeech-probe/voxspeech-native-probe`；
Vulkan probe 使用 `/tmp/voxspeech-qwentts-vulkan-static/voxspeech-probe/voxspeech-native-probe`。

## 资源代价和后端定位

- 0.6B Q8_0 的 Talker 文件约 946 MiB，比 1.7B Q4_K_M 的约 1.14 GiB 小；CPU
  峰值 RSS 约少 0.42 GiB，CUDA/Vulkan 显存增量约少 167/265 MiB。
- 本机 CPU 合成接近实时：1.7B streaming RTF 0.7622，0.6B 为 0.8311；没有
  独立 GPU 的用户可优先选择 0.6B。
- CUDA 和 Vulkan 均显著快于实时，但本机两者显存增量仍约 3.45–3.85 GiB，
  实际部署还需为桌面和驱动预留空间。
- CUDA 是 NVIDIA 默认后端；Vulkan 在本机同样通过，适合作为跨厂商兼容路径。
  Vulkan 首次 shader/pipeline cache 的一次性成本仍需在发布构建上单独复测。

### 后端交付差异

| 对比项               | CPU                     | CUDA                       | Vulkan                           |
| -------------------- | ----------------------- | -------------------------- | -------------------------------- |
| 本轮测试设备         | Intel Core Ultra 9 386H | RTX 5070 Ti Laptop         | RTX 5070 Ti Laptop               |
| 本轮推理速度         | 接近实时                | 显著快于实时               | 显著快于实时                     |
| 本轮 GPU 显存增量    | 不使用 GPU              | 约 3.68–3.85 GiB           | 约 3.45–3.72 GiB                 |
| 本轮进程峰值 RSS     | 约 4.47–4.89 GiB        | 约 1.97–2.17 GiB           | 约 1.46–1.67 GiB                 |
| 首次运行额外成本     | 无                      | 无明显额外成本             | 建立 shader/pipeline cache       |
| 最终用户运行时       | 常规 Linux 系统库       | NVIDIA 驱动的 `libcuda.so` | 显卡驱动的 `libvulkan.so`        |
| 构建工具是否随包分发 | 不需要                  | 不需要 CUDA Toolkit        | 不需要 Vulkan SDK 或 shader 工具 |
| 后端定位             | 无 GPU 时兼容回退       | NVIDIA 默认后端            | 跨厂商 GPU 兼容                  |

RSS 与显存是不同资源，不能相加后当作精确的最低硬件要求。表中的 GPU 数据只代表
当前测试机；其他 GPU 和驱动组合仍需单独验证。

## 历史拒绝项：0.6B Q4_K_M Vulkan

0.6B Q4_K_M 不属于当前正式模型，主表不再列入。此前该组合的有限输出曾通过
WAV 格式和短时性能检查，但完整生成实际跑满 2048 frame（163.84 s）、不产生
EOS，试听为纯噪音。因此该组合被拒绝，产品模型改为 0.6B Base Q8_0；以后不得
用有限 frame、WAV 头或进程退出掩盖音频质量和 EOS 失败。

## 可复现命令

先按 `native/engine/probe/README.md` 准备模型和 probe。以下是六个组合的共同
命令模板；每次将 `<model>`、`<backend>` 和 `<output-dir>` 替换为对应值：

```bash
<backend> \
	--model /tmp/voxspeech-p1-models/<model> \
	--codec /tmp/voxspeech-p1-models/qwen-tokenizer-12hz-Q4_K_M.gguf \
	--ref-wav apps/daemon/test/fixtures/voice-brief/thoughtful.wav \
	--ref-text "目前整体流程已经验证完成，模型加载、音色提取和语音合成的结果都符合预期。需要留意的是，服务重启后仍要保持配置与音色状态一致，接下来我会继续核对这部分边界。" \
	--output-dir /tmp/voxspeech-p1-current-<model>-<backend-name> \
	--max-new 256
```

实际 `<backend>` 分别为：

```bash
/tmp/voxspeech-qwentts-cpu-probe/voxspeech-native-probe
/tmp/voxspeech-qwentts-cuda-static-13.3-gpu/voxspeech-probe/voxspeech-native-probe
GGML_BACKEND=Vulkan0 /tmp/voxspeech-qwentts-vulkan-static/voxspeech-probe/voxspeech-native-probe
```

GPU 运行应在能访问 NVIDIA 驱动的环境中执行，并在进程期间以约 100 ms 间隔
采集 `/proc/<pid>/status` 的 `VmRSS` 和
`nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits`；显存报告为
峰值减启动基线。结果目录固定为：

```text
/tmp/voxspeech-p1-current-1.7b-cpu
/tmp/voxspeech-p1-current-0.6b-cpu
/tmp/voxspeech-p1-current-1.7b-cuda
/tmp/voxspeech-p1-current-0.6b-cuda
/tmp/voxspeech-p1-current-1.7b-vulkan
/tmp/voxspeech-p1-current-0.6b-vulkan
```

本轮 GPU 设备为 NVIDIA GeForce RTX 5070 Ti Laptop GPU；RSS 和显存采样是本机
运行时资源证据，不应直接解释为最低硬件要求。
