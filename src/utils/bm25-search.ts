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
  /**
   * Precomputed document frequency per term. Cached at construction time
   * to avoid O(N) recomputation on every search() call. The cache is
   * immutable for a given document corpus, so it's safe to share across
   * search() invocations.
   */
  private readonly dfCache: Map<string, number>;

  constructor(documents: T[], fieldWeights: Record<string, number> = {}, config: BM25Config = {}) {
    this.documents = documents;
    this.fieldWeights = fieldWeights;
    this.k1 = config.k1 ?? 1.5;
    this.b = config.b ?? 0.75;
    this.N = documents.length;

    this.docLenMap = new Map();
    this.dfCache = new Map();

    for (const doc of documents) {
      const fieldValues = Object.values(doc.fields).join(" ");
      const len = fieldValues.split(/\s+/).filter(Boolean).length;
      this.docLenMap.set(doc.id, len);
    }

    const totalLen = [...this.docLenMap.values()].reduce((a, b) => a + b, 0);
    this.avgDocLen = totalLen / this.N || 1;

    // Precompute df for all terms in the corpus. We do this once instead
    // of on-demand to avoid the O(Q * N * field_count) cost per search call.
    this.precomputeDocumentFrequencies();
  }

  /**
   * Build a map of term -> document frequency. O(N * avg_terms * field_count).
   * Called once in the constructor.
   */
  private precomputeDocumentFrequencies(): void {
    for (const doc of this.documents) {
      for (const field of Object.keys(this.fieldWeights)) {
        const text = (doc.fields[field] ?? "").toLowerCase();
        // Extract unique terms via split on whitespace
        const terms = new Set(text.split(/\s+/).filter(Boolean));
        for (const term of terms) {
          if (term.length === 0) continue;
          this.dfCache.set(term, (this.dfCache.get(term) ?? 0) + 1);
        }
      }
    }
  }

  /**
   * Get document frequency for a term. Returns the precomputed value.
   * O(1) lookup.
   */
  private df(term: string): number {
    return this.dfCache.get(term.toLowerCase()) ?? 0;
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
          // Use indexOf for linear-time substring counting instead of regex
          const termLower = term.toLowerCase();
          let tf = 0;
          let pos = 0;
          while ((pos = textLower.indexOf(termLower, pos)) !== -1) {
            tf++;
            pos += termLower.length;
            // Cap tf to prevent runaway on repeated patterns
            if (tf > 100) break;
          }
          if (tf === 0) continue;

          const df = this.df(termLower);
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
		// LAZY: defer dynamic import of ../agents/discover-agents.ts to its call site.
  const { discoverAgents, allAgents } = await import("../agents/discover-agents.ts");
  const discovery = discoverAgents(process.cwd());
  const all = allAgents(discovery);

  const docs: (SearchDocument & { agent: AgentConfig })[] = all.map((agent: AgentConfig) => ({
    id: agent.name,
    fields: {
      name: agent.name,
      description: agent.description ?? "",
      skills: (agent.skills ?? []).join(" "),
    },
    agent,
  }));

  const engine = new BM25Search(docs, {
    name: 3.0,
    description: 1.5,
    skills: 1.0,
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
		// LAZY: defer dynamic import of ../teams/discover-teams.ts to its call site.
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
