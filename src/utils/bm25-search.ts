import type { AgentConfig } from "../agents/agent-config.ts";
import type { TeamConfig } from "../teams/team-config.ts";

interface SearchDocument {
  id: string;
  fields: Record<string, string>;
}

interface SearchResult<T> {
  item: T;
  score: number;
  matchedOn: string[];
}

interface BM25Config {
  k1?: number;
  b?: number;
}

export class BM25Search<T extends SearchDocument> {
  private readonly documents: T[];
  private readonly fieldWeights: Record<string, number>;
  private readonly avgDocLen: number;
  private readonly k1: number;
  private readonly b: number;
  private readonly docLenMap: Map<string, number>;
  private readonly N: number;

  constructor(documents: T[], fieldWeights: Record<string, number> = {}, config: BM25Config = {}) {
    this.documents = documents;
    this.fieldWeights = fieldWeights;
    this.k1 = config.k1 ?? 1.5;
    this.b = config.b ?? 0.75;
    this.N = documents.length;

    this.docLenMap = new Map();

    for (const doc of documents) {
      const fieldValues = Object.values(doc.fields).join(" ");
      const len = fieldValues.split(/\s+/).filter(Boolean).length;
      this.docLenMap.set(doc.id, len);
    }

    const totalLen = [...this.docLenMap.values()].reduce((a, b) => a + b, 0);
    this.avgDocLen = totalLen / this.N || 1;
  }

  /**
   * Compute document frequency for a query term using substring matching,
   * consistent with the regex-based tf computation in search().
   */
  private df(term: string): number {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    let count = 0;
    for (const doc of this.documents) {
      for (const field of Object.keys(this.fieldWeights)) {
        const text = (doc.fields[field] ?? "").toLowerCase();
        if (re.test(text)) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  search(query: string, options?: { limit?: number; minScore?: number }): SearchResult<T>[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) return [];

    const results: SearchResult<T>[] = [];

    for (const doc of this.documents) {
      let totalScore = 0;
      const matchedOn: string[] = [];

      for (const [field, weight] of Object.entries(this.fieldWeights)) {
        const text = doc.fields[field] ?? "";
        const textLower = text.toLowerCase();
        let fieldScore = 0;

        for (const term of queryTerms) {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const tf = (textLower.match(new RegExp(escaped, "g")) ?? []).length;
          if (tf === 0) continue;

          const df = this.df(term);
          if (df === 0) continue;

          const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
          const docLen = this.docLenMap.get(doc.id) ?? this.avgDocLen;
          const numerator = tf * (this.k1 + 1);
          const denominator = tf + this.k1 * (1 - this.b + this.b * docLen / this.avgDocLen);
          fieldScore += idf * (numerator / denominator);

          matchedOn.push(field);
        }

        totalScore += fieldScore * (weight || 1);
      }

      if (totalScore > 0) {
        results.push({
          item: doc,
          score: totalScore,
          matchedOn: [...new Set(matchedOn)],
        });
      }
    }

    results.sort((a, b) => b.score - a.score);

    const limit = options?.limit ?? 10;
    const minScore = options?.minScore ?? 0.01;

    return results.filter((r) => r.score >= minScore).slice(0, limit);
  }
}

// Agent search interface
interface AgentSearchResult {
  agent: AgentConfig;
  score: number;
  matchedOn: string[];
}

/**
 * Search agents using BM25 ranking.
 * Uses dynamic import to avoid ESM/CJS issues at module load time.
 */
export async function searchAgents(query: string, options?: { limit?: number }): Promise<AgentSearchResult[]> {
  const { discoverAgents, allAgents } = await import("../agents/discover-agents.ts");
  const discovery = discoverAgents(process.cwd());
  const all = allAgents(discovery);

  const docs: (SearchDocument & { agent: AgentConfig })[] = all.map((agent: AgentConfig) => ({
    id: agent.name,
    fields: {
      name: agent.name,
      description: agent.description ?? "",
      skills: (agent.skills ?? []).join(" "),
      tags: (agent.tags ?? []).join(" "),
    },
    agent,
  }));

  const engine = new BM25Search(docs, {
    name: 3.0,
    description: 1.5,
    skills: 1.0,
    tags: 1.0,
  });

  const results = engine.search(query, {
    limit: options?.limit ?? 10,
    minScore: 0.1,
  });

  return results.map((r) => ({
    agent: r.item.agent,
    score: r.score,
    matchedOn: r.matchedOn,
  }));
}

// Team search interface
interface TeamSearchResult {
  team: TeamConfig;
  score: number;
  matchedOn: string[];
}

/**
 * Search teams using BM25 ranking.
 * Uses dynamic import to avoid ESM/CJS issues at module load time.
 */
export async function searchTeams(query: string, options?: { limit?: number }): Promise<TeamSearchResult[]> {
  const { discoverTeams, allTeams } = await import("../teams/discover-teams.ts");
  const discovery = discoverTeams(process.cwd());
  const all = allTeams(discovery);

  const docs: (SearchDocument & { team: TeamConfig })[] = all.map((team: TeamConfig) => ({
    id: team.name,
    fields: {
      name: team.name,
      description: team.description ?? "",
      roles: (team.roles ?? []).map((r: { name: string }) => r.name).join(" "),
    },
    team,
  }));

  const engine = new BM25Search(docs, {
    name: 2.0,
    description: 1.5,
    roles: 1.0,
  });

  const results = engine.search(query, {
    limit: options?.limit ?? 5,
    minScore: 0.1,
  });

  return results.map((r) => ({
    team: r.item.team,
    score: r.score,
    matchedOn: r.matchedOn,
  }));
}
