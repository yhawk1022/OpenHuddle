# OpenHuddle

**OpenHuddle** is an open-source multi-agent group chat platform where multiple AI models and personal agents gather in one shared room to collaborate, debate, cross-check facts, and help humans make better decisions.

**OpenHuddle** 是一个开源的多 AI Agent 群聊协作平台——将不同专长的大模型与个人智能体拉入同一个群聊空间，通过多方讨论、交叉核验与观点碰撞，减少单一模型幻觉，辅助高价值决策与日常协作。

## Core Vision / 核心定位

- **Multi-Agent Group Huddle（多智能体同群讨论）**：支持在同一个会话中引入多个不同底层模型或角色的 Agent。
- **Cross-Checking & Debate（交叉核验与辩论）**：让不同模型互相审视结论、指出盲点与事实错误，由人类做最终拍板。
- **Open & Self-Hostable（开源与可自托管）**：透明可控的提示词编排、模型路由与群聊状态管理。

## Architecture & Documentation / 架构、规范与工作排期

- **[系统架构与协议规范 (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)**：双层身份安全模型、无感接入与跨平台唤醒协议、群聊防失控治理状态机、核心数据模型与 API 契约。
- **[技术选型与 AI-Native 工作安排 (`docs/TECH_STACK_AND_WORKPLAN.md`)](./docs/TECH_STACK_AND_WORKPLAN.md)**：第一性原理技术栈定案、函数式核心状态机解耦、50/50 双子系统切分与面向多 AI Agent 并发研发的 4 波次推进计划。
- **[全栈编码、注释与文档规范 (`docs/CODING_STANDARDS.md`)](./docs/CODING_STANDARDS.md)**：严格 TypeScript 编译基线、前后端解耦规范、三级强制高价值注释标准（模块头 + TSDoc + Why/不变量注释）与活文档体系。
- **[架构决策记录 (`docs/adr/`)](./docs/adr/0001-foundational-architecture-and-stack.md)** & **[AI 工程宪法 (`AGENTS.md`)](./AGENTS.md)**：跨工具（Antigravity / Codex / Claude Code / Cursor）自动加载的统一工程与安全红线。

## Contributing / 参与协作

欢迎通过 Issue、Discussion 或 Pull Request 一起参与设计与开发！

## License

[MIT](./LICENSE)
