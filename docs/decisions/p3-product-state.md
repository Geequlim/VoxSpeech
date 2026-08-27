# P3 配置、模型与 Voice 契约

> 状态：已冻结
>
> 生效范围：P3 产品状态与 CLI
>
> 前置基线：P2 真实 Engine 集成

## 1. 阶段目标与边界

P3 把已经可合成的真实链路补成可持久使用的本地产品：

```text
空 XDG 目录
→ 创建 YAML v1 配置
→ 安装并验证内置模型
→ 选择默认模型
→ 从 WAV 克隆 Voice Profile
→ 使用默认或显式 Voice 合成
→ daemon 重启后状态仍然有效
```

P3 不实现 HTTP API、请求队列、idle unload、engine 崩溃自动恢复、systemd、安装包或运行时
动态模型切换。`model.use` 在 P3 只持久化下次 daemon/engine 受控启动采用的默认模型。

## 2. 并行所有权

| 执行线 | 可修改目录                                                    | 工作                                       |
| ------ | ------------------------------------------------------------- | ------------------------------------------ |
| Config | `packages/config/**`                                          | YAML v1、XDG 路径、校验、原子持久化        |
| Models | `apps/daemon/src/models/**` 及对应测试                        | catalog、安装、离线校验、选择、删除        |
| Voices | `apps/daemon/src/voices/**` 及对应测试                        | Profile 仓库、clone 事务、租约、选择、删除 |
| 主集成 | protocol、package manifests、daemon server/runtime、CLI、文档 | RPC/CLI 组合与阶段验收                     |

执行线不得修改其他执行线目录，不得修改 downloader 实现，不得进入 P4。共享契约有缺口时
停止并报告，由主集成裁决。

## 3. 配置契约

配置文件固定为完整 YAML v1。缺失配置返回内建默认值但不自动落盘；解析、版本或 schema
错误必须明确失败，不得静默覆盖。P3 没有历史配置版本，`version` 不是 `1` 时拒绝，不虚构
迁移。

默认值：

- backend `auto`、idle timeout `10m`、max batch `1`；
- default model `qwen3-tts-1.7b-base-q4_k_m`；
- default voice `null`；
- download hub URL、proxy 和 connections 均为 `null`，交由环境与 downloader 默认值处理；
- API 和 audio 保持现有 v1 默认值。

`idleTimeout` 只接受正整数加 `ms|s|m|h`。保存采用同目录临时文件、权限 `0600`、file
fsync、rename 与 parent directory fsync。`config.validate` 只校验；`config.update` 只有原子
提交成功后才替换内存快照。P3 不因 config update 启停 HTTP 或重启 engine。

## 4. 模型契约

P3 内置 catalog 包含已验收的 1.7B 与 0.6B Base Q4_K_M；`setup` 固定安装并启用
`qwen3-tts-1.7b-base-q4_k_m`。两个条目固定：

- repository `Serveurperso/Qwen3-TTS-GGUF`；
- revision `e0f336a048a3de02b29b8ad92969217d9ecffe3e`；
- talker 与 tokenizer 的路径、size、SHA256 使用 P1 固定值。

安装使用 `@tinyaxis/model-downloader` 的 manifest API，不重新实现网络传输。下载目录为
`<cache>/downloads/<id>.staging`，允许跨重启续传。cache 与 data 同文件系统时，完整校验并写入
私有 metadata 后直接原子 rename；跨文件系统时，先复制到 `<data>/models` 内的私有 promotion
staging，重新校验并 fsync，再原子 rename 到最终目录。只有完整最终目录且 metadata 与 catalog
匹配才视为 installed。`model.verify` 必须离线重新计算 size/SHA256。

镜像、代理和连接数优先级：

```text
model.install 显式参数
→ YAML download 配置
→ HF_ENDPOINT / HTTP(S)_PROXY / NO_PROXY
→ downloader 默认值
```

同一 model ID 的 install/remove 串行。已加载或被租约占用的模型拒绝删除。默认模型删除
必须先通过同一 daemon 串行事务把 config default 清为 `null`；失败时不删除模型。

## 5. Voice Profile 契约

Profile 位于 `<data>/voices/<id>/`，只包含：

```text
voice.yaml
speaker.spk
reference.rvq
```

`voice.yaml` 是 daemon 私有 schema：version、id、transcript、modelId、speakerDimension、
codebookCount、frameCount。Voice ID 必须是安全的单个目录名，不允许斜杠、`.`、`..`。

clone 在 voices 根目录的同文件系统 staging 目录执行。daemon 把临时 `.spk/.rvq` 路径交给
已加载 Base engine 的 `voice.extract`，校验两个输出为非空 regular file、权限为私有并写入
metadata；全部 fsync 后原子 rename 成最终 Profile。失败清理 staging，不产生可见 Profile。

合成时 Voice ID 解析为固定 reference path 与 transcript，绝不把 ID 当文件路径。一次请求
持有 Profile 租约直到 engine 返回；活动 Profile 拒绝删除。未显式传 Voice 时使用配置默认
值；两者均为 null 时执行无 reference 的 Base 合成。

## 6. RPC 与 CLI 冻结

现有 JSON-RPC version 1 方法保持不变。`model.install` params 向后兼容地扩展为：

```text
{ id, hubUrl?, proxy?, connections? }
```

其他 model、voice 与 config schema 保持现状。CLI 使用 Commander 构建命令树、参数校验与帮助，
固定新增：

```text
voxspeech setup [--hub-url URL] [--proxy URL] [--connections N]
voxspeech model <list|install|verify|use|remove>
voxspeech voice <list|clone|show|use|remove>
voxspeech config <path|show|validate|apply>
voxspeech speak [--voice ID]
```

`setup` 是 CLI orchestration：读取配置、安装默认模型并调用 `model.use`，不增加 setup RPC。
CLI 不直接操作 model/Voice 仓库；`config path` 只解析本地 XDG 路径。

## 7. P3 验收门

- 空 XDG 目录完成 setup，模型从 staging 原子进入 installed；
- 中断可续传，错误 SHA256 不产生 installed 模型；
- mirror、显式代理、环境代理与 `NO_PROXY` 通过测试；
- 篡改 GGUF 后离线 verify 失败；
- 一条 CLI 命令完成 Voice clone，随后可显式或默认 Voice 合成；
- daemon 重启后 config、模型与 Voice 状态保持；
- 删除活动 model/Voice 被拒绝，已开始请求不受破坏；
- 全量 `yarn tiny check` 与一次真实 0.6B/1.7B 产品流程通过；
- 完成后停在 P3 验收点，不启动 P4。
