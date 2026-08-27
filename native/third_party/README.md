# Native third-party dependencies

`glaze/` 固定为 7.9.0，保留上游 MIT License、README 与 VERSION。VoxSpeech C++
协议层使用它定义 JSON-RPC 类型并完成 JSON 解析与序列化。

`qwentts.cpp/` 是 Git 子模块，固定到提交 `a8a7716b530e49fed537c57711247c12fbbb903c`；
其 `ggml/` 嵌套子模块由上游固定到 `c044c6f03892f9d5e98213b05f8afea1f8b0d3c9`。
VoxSpeech 的 probe 与适配代码保留在 `native/engine`，不修改子模块内容。
