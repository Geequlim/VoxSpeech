# Daemon 测试 Fixture

`voice-brief/` 中的五组样本由本机 Voice Brief 在 2026-08-28 生成，分别覆盖：

| ID           | Voice Brief 人设 |     时长 |
| ------------ | ---------------- | -------: |
| `neighbor`   | 邻家妹妹         | 13.95 秒 |
| `default`    | 默认中文助理     | 13.17 秒 |
| `sweet`      | 甜妹助理         | 15.39 秒 |
| `energetic`  | 元气搭子         | 15.10 秒 |
| `thoughtful` | 知性姐姐         | 15.57 秒 |

内容均为纯中文，并按对应人设编写。音频经 FFmpeg 规范化为 24 kHz、mono、PCM 16-bit
WAV；同名 `.txt` 是严格对应的逐字稿。

这些音频由项目所有者明确授权复制到仓库，用于 1.7B/0.6B 的真实 Voice clone 回归测试。
