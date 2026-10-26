# 分诊标签（Triage Labels）

本地 Markdown 追踪器没有标签，「标签」就是任务单 `Status:` 行的取值。各工程技能用五个分诊角色交流，下表把它们映射到本仓库的字符串。

| 角色（mattpocock/skills） | 本仓库 `Status:` 取值 | 含义                       |
| ------------------------- | --------------------- | -------------------------- |
| `needs-triage`            | `needs-triage`        | 维护者需要评估             |
| `needs-info`              | `needs-info`          | 等待报告者补充信息         |
| `ready-for-agent`         | `ready-for-agent`     | 规格完整，可交给离席智能体 |
| `ready-for-human`         | `ready-for-human`     | 需人工实现                 |
| `wontfix`                 | `wontfix`             | 不处理                     |

改映射就改第二列。

寻路子任务单与实现任务单共用 `.scratch/<effort>/issues/NN-<slug>.md` 这一路径形状，但 `Status:` 词汇不同：寻路子任务单写 `claimed` / `resolved`（见 `issue-tracker.md` 的寻路一节），分诊角色只用在 `.scratch/<feature>/` 下的实现任务单。
