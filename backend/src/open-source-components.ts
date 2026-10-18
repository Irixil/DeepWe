export type OpenSourceId = "soulchat-r1" | "aptness" | "cpsycoun" | "persona-conflicts";

export interface OpenSourceRecord {
  id: OpenSourceId;
  name: string;
  url: string;
  commit: string;
  license: string;
  used: string[];
  excluded: string[];
}

// 开源项目只提供设计依据。运行时使用 DeepWe 已改写的对话策略，不再注入第二套策略清单。
export const OPEN_SOURCE_REGISTRY: OpenSourceRecord[] = [
  {
    id: "soulchat-r1",
    name: "SoulChat-R1 / CATCH",
    url: "https://github.com/scutcyr/SoulChat-R1",
    commit: "f35ebbda4653830f35ce8160a7ec175d21633da2",
    license: "Apache-2.0",
    used: ["progressive stage alignment", "memory-plan-strategy-check planning loop", "collaboration checks"],
    excluded: ["hidden chain-of-thought samples", "automatic ending", "therapy claims", "homework assignment"],
  },
  {
    id: "aptness",
    name: "APTNESS",
    url: "https://github.com/CAS-SIAT-XinHai/APTNESS",
    commit: "a8151400867c630a5ba7b094e964262a8e53bd17",
    license: "CC0-1.0",
    used: ["emotional-support strategy taxonomy", "turn-level response quality dimensions"],
    excluded: ["Python runtime", "LlamaIndex", "Ollama embeddings", "self-disclosure", "raw dialogue retrieval corpus"],
  },
  {
    id: "cpsycoun",
    name: "CPsyCoun",
    url: "https://github.com/CAS-SIAT-XinHai/CPsyCoun",
    commit: "1954f2e2d01d3b0f568e1673a525a6d3d9a34c03",
    license: "CC-BY-4.0",
    used: ["comprehensiveness", "professionalism", "authenticity", "safety evaluation dimensions"],
    excluded: ["counseling reports", "diagnosis", "hypnosis", "treatment instructions", "raw case responses"],
  },
  {
    id: "persona-conflicts",
    name: "PersonaConflicts Corpus",
    url: "https://github.com/mitmedialab/persona-conflicts-corpus-emnlp-2025",
    commit: "c41ea89aaa143d49688dfcda3110bbeb846cbe7a",
    license: "MIT",
    used: ["relationship-conflict scenario taxonomy", "NVC/violent-communication evaluation labels"],
    excluded: ["persona imitation", "character backstories in runtime", "verbatim dialogue generation"],
  },
];

export function checkOpenSourceBoundaries(reply: string): string[] {
  const reasons: string[] = [];
  if (/(我也经历过|我也遇到过|我的亲身经历|我以前也)/.test(reply)) {
    reasons.push("false_self_disclosure");
  }
  if (/(我保证|一定会好|肯定会好|一定能挽回|保证能)/.test(reply)) {
    reasons.push("unsupported_reassurance");
  }
  if (/(给你布置|你的作业是|必须完成作业|疗程|催眠治疗|我来治疗你)/.test(reply)) {
    reasons.push("therapy_or_homework_overreach");
  }
  return reasons;
}
