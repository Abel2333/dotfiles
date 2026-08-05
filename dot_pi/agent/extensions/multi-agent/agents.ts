import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentName } from "./types";

const SUPPORTED_AGENTS = new Set<AgentName>([
  "scout",
  "feasibility",
  "reviewer",
]);

export function discoverAgents(): AgentConfig[] {
  const dir = path.join(getAgentDir(), "agents");
  if (!fs.existsSync(dir)) return [];

  const agents: AgentConfig[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const { frontmatter, body } =
        parseFrontmatter<Record<string, string>>(content);
      const name = frontmatter.name as AgentName | undefined;
      if (!name || !SUPPORTED_AGENTS.has(name) || !frontmatter.description) {
        continue;
      }
      agents.push({
        name,
        description: frontmatter.description,
        model: frontmatter.model || undefined,
        systemPrompt: body.trim(),
        filePath,
      });
    } catch {
      // Ignore unreadable or malformed user agent files.
    }
  }
  return agents;
}

export function findAgent(name: AgentName): AgentConfig | undefined {
  return discoverAgents().find((agent) => agent.name === name);
}
