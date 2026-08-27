# VoxSpeech Engine

此目录用于 VoxSpeech 自有的 C++17 推理适配器。它通过私有子进程协议接收 daemon
请求，调用固定版本的 qwentts.cpp C ABI，并返回状态事件与流式 PCM。

首个实现阶段只加入能力探针，不在这里承载配置、模型下载、HTTP 或 Voice 元数据管理。
