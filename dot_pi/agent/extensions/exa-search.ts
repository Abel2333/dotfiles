import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai/compat";

// ---------------------------------------------------------------------------
// Exa API client
// ---------------------------------------------------------------------------

const EXA_API_BASE = "https://api.exa.ai";

interface ExaSearchResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
  highlightScores?: number[];
  score?: number;
}

interface ExaSearchResponse {
  results?: ExaSearchResult[];
  autopromptString?: string;
  requestId?: string;
  costDollars?: { total: number; search?: { neural?: number }; contents?: { text?: number } };
}

function getApiKey(): string | null {
  const key = process.env.EXA_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function recencyToStartDate(filter: string): string {
  const offsets: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  const days = offsets[filter] ?? 0;
  return new Date(Date.now() - days * 86400000).toISOString();
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function exaSearch(params: {
  query: string;
  numResults?: number;
  recencyFilter?: string;
  domainFilter?: string[];
  includeContent?: boolean;
  signal?: AbortSignal;
}): Promise<ExaSearchResponse> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("EXA_API_KEY environment variable is not set");

  const body: Record<string, unknown> = {
    query: params.query,
    type: "auto",
    numResults: Math.min(params.numResults ?? 5, 20),
    contents: {
      text: params.includeContent ? true : { maxCharacters: 3000 },
      highlights: true,
    },
  };

  if (params.recencyFilter) {
    body.startPublishedDate = recencyToStartDate(params.recencyFilter);
  }

  if (params.domainFilter?.length) {
    const include: string[] = [];
    const exclude: string[] = [];
    for (const d of params.domainFilter) {
      const trimmed = d.trim();
      if (trimmed.startsWith("-")) {
        const domain = trimmed.slice(1).trim();
        if (domain) exclude.push(domain);
      } else if (trimmed) {
        include.push(trimmed);
      }
    }
    if (include.length) body.includeDomains = include;
    if (exclude.length) body.excludeDomains = exclude;
  }

  const signal = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(60000)])
    : AbortSignal.timeout(60000);

  const response = await fetch(`${EXA_API_BASE}/search`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Exa API error ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json() as Promise<ExaSearchResponse>;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatResults(response: ExaSearchResponse, query: string): string {
  const results = response.results ?? [];
  if (results.length === 0) return `No results found for: "${query}"`;

  const lines: string[] = [];

  if (response.autoprintString) {
    lines.push(`**Auto-optimized query:** "${response.autoprintString}"`);
    lines.push("");
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title || `Result ${i + 1}`;
    const url = r.url || "";
    const domain = url ? extractDomain(url) : "";
    const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";

    lines.push(`### ${i + 1}. ${title}`);
    if (domain) lines.push(`**${domain}**${date} — ${url}`);
    else if (url) lines.push(url);

    const highlights = r.highlights?.filter((h): h is string => typeof h === "string" && h.length > 0);
    if (highlights?.length) {
      lines.push("");
      lines.push("> " + highlights.join("\n> "));
    } else if (typeof r.text === "string" && r.text.trim()) {
      // Truncate to reasonable snippet length
      const snippet = r.text.replace(/\s+/g, " ").trim().slice(0, 500);
      lines.push("");
      lines.push(snippet);
    }

    if (r.author) lines.push(`*By ${r.author}*`);
    lines.push("");
  }

  if (response.costDollars) {
    lines.push(
      `---\n*Search cost: $${response.costDollars.total.toFixed(5)}*`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const hasKey = !!getApiKey();

  pi.registerTool({
    name: "exa_search",
    label: "Exa Search",
    description:
      "Search the web using the Exa API. Returns high-quality results with content highlights and full text extraction. Exa excels at neural semantic search — finding relevant content even when keywords don't match. Best used for: deep research, finding specific articles, pages, or documents, competitive analysis, and content discovery. When includeContent is true, each result includes full page text (not just snippets). Use 'queries' with 2-4 varied angles for comprehensive research coverage.",
    promptSnippet:
      "Use for deep web research with Exa neural search. Prefer {queries:[...]} with 2-4 varied angles for broad coverage. Best for finding articles, documentation, or specific web pages.",
    promptGuidelines: [
      "Use exa_search for research questions that benefit from neural semantic matching (finding relevant pages even without keyword overlap). Use it when you need full page text extraction (includeContent: true) for deeper analysis.",
      "Exa search returns number of results as configured by numResults, with highlights and optional full text. Use get_search_content to retrieve full content when includeContent was true.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Single search query. For research tasks, prefer 'queries' with multiple varied angles instead.",
        }),
      ),
      queries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Multiple queries searched in sequence, each returning its own results. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries to get broader coverage. Good: ['React performance benchmarks 2026', 'React vs Vue developer experience', 'React ecosystem size']. Bad: ['React vs Vue', 'React vs Vue comparison', 'React vs Vue review'] (too similar).",
        }),
      ),
      numResults: Type.Optional(
        Type.Number({
          description: "Number of results per query (default: 5, max: 20)",
        }),
      ),
      includeContent: Type.Optional(
        Type.Boolean({
          description:
            "Include full page text for each result. Uses more API credits but enables deeper analysis.",
        }),
      ),
      recencyFilter: Type.Optional(
        StringEnum(["day", "week", "month", "year"], {
          description: "Filter results by publication date",
        }),
      ),
      domainFilter: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Limit results to specific domains, or exclude domains by prefixing with -. Example: ['github.com', '-reddit.com']",
        }),
      ),
    }),

    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as Record<string, unknown>;
      // Ensure queries is always an array when query is provided alone
      if (
        typeof input.query === "string" &&
        input.query.trim().length > 0 &&
        !Array.isArray(input.queries)
      ) {
        return { ...input, queries: [input.query.trim()] };
      }
      return args;
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!hasKey) {
        const errorMsg =
          "EXA_API_KEY environment variable is not set. Set it to your Exa API key to use this tool.";
        return {
          content: [{ type: "text", text: `Error: ${errorMsg}` }],
          details: { error: errorMsg },
        };
      }

      const queries: string[] = Array.isArray(params.queries) && params.queries.length > 0
        ? params.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        : typeof params.query === "string" && params.query.trim()
          ? [params.query.trim()]
          : [];

      if (queries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No query provided. Use 'query' for a single search or 'queries' (array) for multiple searches.",
            },
          ],
          details: { error: "No query provided" },
        };
      }

      const allResults: string[] = [];
      const allMetadata: Array<{
        query: string;
        resultCount: number;
        autopromptString?: string;
        requestId?: string;
        costDollars?: number;
      }> = [];
      const allUrls: string[] = [];
      let totalCost = 0;

      for (let i = 0; i < queries.length; i++) {
        if (signal?.aborted) {
          allResults.push(`Search cancelled after ${i}/${queries.length} queries.`);
          break;
        }

        const query = queries[i];
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Searching ${i + 1}/${queries.length}: "${query}"...`,
            },
          ],
          details: {
            phase: "searching",
            progress: i / queries.length,
            currentQuery: query,
          },
        });

        try {
          const response = await exaSearch({
            query,
            numResults: params.numResults,
            recencyFilter: params.recencyFilter,
            domainFilter: params.domainFilter,
            includeContent: params.includeContent,
            signal,
          });

          const resultCount = response.results?.length ?? 0;
          const cost = response.costDollars?.total ?? 0;
          totalCost += cost;

          allMetadata.push({
            query,
            resultCount,
            autoprintString: response.autoprintString,
            requestId: response.requestId,
            costDollars: cost,
          });

          if (queries.length > 1) {
            allResults.push(`## Query ${i + 1}/${queries.length}: "${query}"\n`);
          }
          allResults.push(formatResults(response, query));

          for (const r of response.results ?? []) {
            if (r.url && !allUrls.includes(r.url)) allUrls.push(r.url);
          }

          // Store full text content for later retrieval via get_search_content if available
          if (params.includeContent && ctx) {
            const fullContent = (response.results ?? [])
              .filter(
                (r): r is ExaSearchResult & { url: string; text: string } =>
                  !!r.url && typeof r.text === "string" && r.text.length > 0,
              )
              .map((r) => ({
                url: r.url!,
                title: r.title || "",
                content: r.text!,
                error: null as string | null,
              }));

            if (fullContent.length > 0) {
              // Store results for get_search_content tool to retrieve later
              (ctx as any)._exaFullContent = fullContent;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.toLowerCase().includes("abort")) {
            allResults.push(
              `## Query ${i + 1}: "${query}"\n*Search aborted.*\n`,
            );
            break;
          }
          allResults.push(
            `## Query ${i + 1}: "${query}"\n**Error:** ${message}\n`,
          );
          allMetadata.push({ query, resultCount: 0 });
        }
      }

      const output = allResults.join("\n\n---\n\n");

      onUpdate?.({
        content: [{ type: "text", text: "Search complete." }],
        details: {
          phase: "complete",
          progress: 1,
          totalQueries: queries.length,
          totalResults: allMetadata.reduce((s, m) => s + m.resultCount, 0),
          totalCost,
        },
      });

      return {
        content: [{ type: "text", text: output.trim() }],
        details: {
          queries,
          queryCount: queries.length,
          metadata: allMetadata,
          urls: allUrls,
          totalCost,
          includeContent: params.includeContent ?? false,
        },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const key = getApiKey();
    if (key) {
      // Key is set — tool is ready
    } else {
      ctx.ui?.notify?.(
        "exa-search: EXA_API_KEY not set. Tool will return an error until configured.",
        "warning",
      );
    }
  });
}
