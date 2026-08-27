# Native third-party dependencies

`glaze/` 固定为 7.9.0，保留上游 MIT License、README 与 VERSION。VoxSpeech C++
协议层使用它定义 JSON-RPC 类型并完成 JSON 解析与序列化。

P0 阶段将在此固定 qwentts.cpp 上游版本。正式接入前先完成 CUDA 构建、流式合成、
Voice Clone、取消和显存释放验证。
