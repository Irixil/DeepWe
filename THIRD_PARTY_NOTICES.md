# 第三方材料与设计参考

本项目的非商业许可证仅适用于相应权利人有权授权的项目自有部分，不替换第三方许可证，也不限制第三方材料原有的独立授权。

## 依赖与字体

Next.js、React、Motion、Hono、better-sqlite3 及其依赖继续适用各自许可证。版本与依赖关系保留在两个 `package-lock.json` 中。现有运行依赖声明见 [公开资源中的完整第三方声明](public/third-party-notices.txt)；得意黑字体许可见 [字体声明](public/fonts/SmileySans-LICENSE.txt)。本仓库不分发 `node_modules` 或预编译的第三方运行库。

## 调解与对话策略参考

- [goutoujunshi](https://github.com/powerycy/goutoujunshi)，本地审查版本 `8d30c86`，MIT，Copyright (c) 2026 powerycy。提示词中的五步调解思路和安全规则有参考改写，原 MIT 声明保存在 [第三方许可证](THIRD_PARTY_LICENSES/goutoujunshi-MIT.txt)。
- [SoulChat-R1 / CATCH](https://github.com/scutcyr/SoulChat-R1)，参考版本 `f35ebbda4653830f35ce8160a7ec175d21633da2`，登记为 Apache-2.0，用于阶段对齐与协作检查的设计参考。
- [APTNESS](https://github.com/CAS-SIAT-XinHai/APTNESS)，参考版本 `a8151400867c630a5ba7b094e964262a8e53bd17`，登记为 CC0-1.0，用于情绪支持策略分类与回应评估维度的设计参考。
- [CPsyCoun](https://github.com/CAS-SIAT-XinHai/CPsyCoun)，参考版本 `1954f2e2d01d3b0f568e1673a525a6d3d9a34c03`，登记为 CC-BY-4.0，用于完整性、专业性、真实性和安全评估维度的设计参考。
- [PersonaConflicts Corpus](https://github.com/mitmedialab/persona-conflicts-corpus-emnlp-2025)，参考版本 `c41ea89aaa143d49688dfcda3110bbeb846cbe7a`，登记为 MIT，用于关系冲突分类的设计参考。

上述登记同时保留在 `backend/src/open-source-components.ts`。本次不分发这些研究项目的数据集、模型权重、咨询报告或原始案例，也不把设计参考描述为完整集成。
