# VoxSpeech Engine

本目录包含 C++23 engine 的 stdio JSON-RPC 进程壳：

- Glaze JSON-RPC version 1 类型与请求校验（`voxspeech_engine_protocol`）；
- 可替换的 Runtime 接口（`include/voxspeech/engine/runtime.hpp`）：load、status、
  synthesize、extractVoice、shutdown，不暴露任何 qwentts/GGML 类型；
- 进程壳 server（`voxspeech_engine_server`）：stdin NDJSON 读取、冻结状态机、
  单一推理 worker、有序 stdout writer、PCM16/Base64 流式音频转换、cooperative
  cancellation、shutdown/EOF 编排；
- deterministic fake runtime（`voxspeech_engine_fake_runtime`）：不访问模型或
  GPU，按 scenario 产生受控的多 chunk 音频、延迟、失败与取消；
- fixture executable 与读取共享 golden fixtures 的 CTest，含真实 pipes 的
  子进程 NDJSON 验证。

真实 qwentts runtime 以固定 submodule 的 CMake overlay 构建，不复制或修改上游源码。
每个 build directory 只生成一个后端的 `voxspeech-engine`：

```bash
cmake -S native/third_party/qwentts.cpp -B dist/engine-cpu -G Ninja \
  -DCMAKE_PROJECT_INCLUDE="$PWD/native/engine/qwentts-inject.cmake" \
  -DVOXSPEECH_ENGINE_ENABLE_QWENTTS=ON \
  -DVOXSPEECH_ENGINE_BUILD_TESTS=OFF \
  -DVOXSPEECH_ENGINE_BACKEND=cpu \
  -DGGML_CUDA=OFF -DGGML_VULKAN=OFF
cmake --build dist/engine-cpu --target voxspeech-engine
```

CUDA profile 使用 `VOXSPEECH_ENGINE_BACKEND=cuda`、`GGML_CUDA=ON` 和
`GGML_STATIC=ON`；Vulkan profile 使用 `VOXSPEECH_ENGINE_BACKEND=vulkan`、
`GGML_VULKAN=ON` 和 `GGML_STATIC=ON`。

## 线程与输出模型

- 主线程只读取和分发 stdin，不执行阻塞推理；
- 同时最多一个推理 worker；P2 的 `maxBatch` 只接受 1；
- 所有 response 和 notification 进入同一个 FIFO writer 队列，由唯一 writer
  线程写 stdout；
- stdout 只有紧凑 JSON-RPC NDJSON，日志全部写 stderr；
- `speech.started` 在接受合成后立即发送，`speech.audio` 的 sequence 从 0
  严格递增，解码后单个 chunk 不超过 64 KiB；
- shutdown 先取消活动合成、等待 worker 写出原请求的 cancelled error，再写
  shutdown response 并退出；stdin EOF 执行无响应的有界 shutdown。

## Fixture executable

`voxspeech_engine_fixture` 只链接 fake runtime，通过环境变量
`VOXSPEECH_ENGINE_SCENARIO` 指向 scenario JSON 文件（缺省为默认 scenario）：

```json
{
	"load": {"ok": true, "backend": "cuda", "modelType": "base", "runtimeVersion": "0.1.0", "delayMs": 0},
	"synthesis": {"failure": "none", "chunkCount": 30, "samplesPerChunk": 1200, "amplitude": 0.5, "delayMs": 40},
	"extract": {"ok": true, "speakerDimension": 1024, "codebookCount": 16, "frameCount": 42, "delayMs": 0}
}
```

`failure` 允许 `none`、`synthesis_failed` 和 `invalid_params`；失败时合成仍先
产出已配置的 chunk 再返回错误。

独立验证：

```bash
cmake -S . -B /tmp/voxspeech-native-build -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build /tmp/voxspeech-native-build
ctest --test-dir /tmp/voxspeech-native-build --output-on-failure
```
