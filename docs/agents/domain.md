# 领域文档约定

本文档说明工程技能探索本仓库代码时，如何使用领域文档。

## 探索前必须阅读

- 根目录的 **`CONTEXT.md`**；或者
- 如果根目录存在 **`CONTEXT-MAP.md`**，先阅读它指向的、与当前主题相关的各个上下文 `CONTEXT.md`。
- 阅读 **`docs/adr/`** 中与当前工作范围相关的 ADR。在多上下文仓库中，还要检查 `src/<context>/docs/adr/` 下的上下文专属 ADR。

如果这些文件不存在，**静默继续**即可；不要专门提示缺失，也不要提前建议创建。`/domain-modeling` 技能（可由 `/grill-with-docs` 和 `/improve-codebase-architecture` 触发）会在术语或决策真正确定时按需创建它们。

## 文件结构

本仓库采用 single-context（单一上下文）结构，也就是所有代码共用一个领域上下文：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库以根目录存在 `CONTEXT-MAP.md` 为标志，表示不同代码区域拥有独立的领域上下文。结构示例：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文专属决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表中的词汇

在 Issue（问题单）标题、重构提案、假设或测试名称中使用领域概念时，应采用 `CONTEXT.md` 中定义的术语，不要随意改用术语表明确避免的同义词。

如果所需概念尚未出现在术语表中，这通常意味着：项目可能没有使用这个概念（应重新考虑命名），或者领域文档确实存在缺口（记录下来并交给 `/domain-modeling` 处理）。

## 标记 ADR 冲突

如果输出内容与已有 ADR 冲突，应明确指出，不要静默覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但由于……，值得重新讨论。_
