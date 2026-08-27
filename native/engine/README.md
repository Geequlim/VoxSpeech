# VoxSpeech Engine

本目录当前包含 C++23 engine 的私有协议基线：

- Glaze JSON-RPC version 1 类型；
- 最大 1 MiB、LF framing 的增量 NDJSON codec；
- engine method 的请求分类与参数校验骨架；
- stdout 协议输出与 stderr 日志输出的隔离组件；
- 读取共享 golden fixtures 的 CTest。

当前阶段不包含推理、模型加载或 qwentts.cpp 适配。

独立验证：

```bash
cmake -S native/engine -B /tmp/voxspeech-native-build -G Ninja
cmake --build /tmp/voxspeech-native-build
ctest --test-dir /tmp/voxspeech-native-build --output-on-failure
```
