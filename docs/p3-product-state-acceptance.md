# P3 配置、模型、Voice 与 CLI 验收报告

> 日期：2026-08-28
>
> 状态：实现完成；1.7B 通过，0.6B 真实试听失败，P3 尚未通过最终验收

## 1. 交付结果

P3 已把 P2 的真实推理链路补成可持久使用的本地产品流程：

```text
空 XDG 目录
→ Commander CLI setup
→ daemon Unix Socket JSON-RPC
→ Range/多连接下载与离线 SHA256
→ 原子安装并选择模型
→ 受控重启加载 engine
→ Voice clone / 默认 Voice
→ 合成 WAV
→ 再次重启后状态仍有效
```

已交付：

- YAML v1 默认配置、严格校验、私有原子保存和队列内字段事务；
- 1.7B/0.6B Base Q4_K_M 固定 catalog；`setup` 固定选择 1.7B；
- 下载续传、mirror、proxy、连接数、离线校验、跨文件系统原子 promotion；
- 模型损坏恢复、默认选择、租约与 loaded 模型删除保护；
- Voice Profile 原子 clone、损坏隔离/恢复、取消清理、模型匹配和引用租约；
- daemon 的 config/model/voice RPC、操作进度、断连取消与稳定错误；
- Commander CLI 完整命令树与可直接运行的 Yarn 开发入口；
- engine 启动失败时 daemon 降级为 stopped，管理与诊断能力保持可用。

## 2. 关键组合规则

- `model.use` 持久化下次 daemon 受控启动所用模型，不在 P3 动态切换 engine；
- `setup` 完成后 CLI 明确输出 `restartRequired`；
- 同一 model/Voice 的删除与租约互斥，已加载模型、默认 Voice 或请求租约存在时拒绝删除；
- Voice metadata 记录创建它的 model ID，合成时必须与当前加载模型一致；
- `config.update` 是完整替换，model/Voice 内部选择使用队列内 mutator，避免并发丢失更新；
- cache/data 跨挂载点时先复制到 data 同文件系统 staging，再执行最终原子 rename。

## 3. 自动化验收

纵向产品测试使用真实 ConfigStore、ModelRepository、VoiceRepository、Commander CLI、Unix
Socket 和下载器，仅把大模型和原生计算替换为小 manifest 与 deterministic engine。它覆盖：

- 空 XDG `setup`、进度通知与最终 result；
- 配置文件 `0600`、模型 metadata 与最终安装目录；
- daemon 重启后加载模型；
- Voice clone/use、显式 Voice 合成；
- 再次重启后默认 Voice 解析到真实 Profile 文件路径；
- 长操作不受普通 RPC 30 秒 timeout 影响；
- 下载/clone 断连取消、损坏目录恢复、跨设备 promotion 分支；
- model/Voice remove 与新租约的交错竞态；
- 配置字段并发 mutation 不互相覆盖。

完整质量门使用：

```bash
yarn tiny fix-worktree
yarn tiny check
```

最终结果：TypeScript 类型检查、Oxlint、Oxfmt 全部通过；Vitest 为 173 passed、2 个显式环境门
测试 skipped；C++ `ctest` 为 4/4 passed。真实 1.7B 测试通过；0.6B 可以完成协议和文件流程，
但没有生成 EOS，且人工试听为纯噪音，因此真实验收失败。

## 4. 真实 Vulkan 产品流程

真实验收直接复用 P1 已校验的 GGUF 与 Vulkan engine，通过 P3 的 Config/Model/Voice/CLI/daemon
组合层执行；本地模型注入只跳过重复网络传输，安装 metadata、离线 SHA256、engine load、Voice
提取和两次重启均为真实路径。

Voice clone 输入使用仓库内 `apps/daemon/test/fixtures/voice-brief/` 的五组 Voice Brief 样本，分别
覆盖邻家妹妹、默认中文助理、甜妹助理、元气搭子和知性姐姐。每条内容都按对应人设编写，只含
中文且时长为 13 至 16 秒；音频统一规范化为 24 kHz 单声道 PCM WAV，同名文件保存严格对应的
逐字稿。两组真实模型测试都会依次提取全部五个 Voice，1.7B 使用甜妹助理完成合成，0.6B 使用
知性姐姐完成合成。

| 模型             | 后端   | 输出时长 |        输出大小 | 结果 |
| ---------------- | ------ | -------: | --------------: | ---- |
| 1.7B Base Q4_K_M | Vulkan |   2.48 s |   119,084 bytes | 通过 |
| 0.6B Base Q4_K_M | Vulkan | 163.84 s | 7,864,364 bytes | 失败 |

两份文件均由 `file` 确认为 RIFF/WAVE、PCM 16-bit、mono、24 kHz。1.7B 输出为 2.48 秒且试听
内容正确。0.6B 输出为 163.84 秒，恰好等于 2048 个 80 ms frame，说明模型没有生成 EOS，最终
触发 `max_new_tokens`；人工试听确认为纯噪音。文件格式检查不能作为语音质量验收。

真实测试现已增加 30 秒上限，短句输出达到最大 frame 上限时会直接失败。测试同时验证：

- setup/install/use 后重启可加载真实模型；
- 五组纯中文人设样本逐一完成真实 Voice latent 提取；
- 默认 Voice 在 daemon 再次重启后仍可合成；
- 已加载模型的 remove 返回 `resource_busy`。

## 5. 阶段边界

P3 不包含 HTTP API、请求队列、idle unload、engine 自动恢复、systemd 或发行包。开发态入口为
`yarn tiny cli` 与 `yarn tiny daemon`；正式安装命令和系统服务属于后续打包阶段。

当前停止推进，不进入 P4。后续需要决定暂时下架 0.6B，或继续调查其 GGUF/量化与上游 Runtime。
