import { ToolError, type AgentTool } from "./types";

/** Hosts an agent may reach. Empty allowlist disables the tool entirely. */
export interface HttpToolConfig {
  allowedHosts: string[];
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Outbound HTTP, gated by an explicit host allowlist.
 *
 * Autonomous agents are treated as untrusted callers: there is no default-open
 * mode, private address ranges are refused outright, and the response is capped
 * so a single tool call cannot exhaust the run's context or memory.
 */
export function createHttpTool(config: HttpToolConfig): AgentTool<{ url: string }, unknown> {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxBytes = config.maxBytes ?? 200_000;
  const allowed = config.allowedHosts.map((h) => h.toLowerCase());

  return {
    name: "http_get",
    description:
      "Fetch a document over HTTPS from an allowlisted host and register it as citable evidence. Returns a `ref` index for linking claims.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute https:// URL." } },
      required: ["url"],
      additionalProperties: false,
    },
    async execute(input, context) {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new ToolError(this.name, `"${input.url}" is not a valid URL`);
      }

      if (url.protocol !== "https:") {
        throw new ToolError(this.name, "only https:// URLs are permitted");
      }
      if (isPrivateHost(url.hostname)) {
        throw new ToolError(this.name, "requests to private address ranges are refused");
      }
      const host = url.hostname.toLowerCase();
      const permitted = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
      if (!permitted) {
        throw new ToolError(this.name, `host "${host}" is not on this agent's allowlist`);
      }

      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "text/plain, text/html, application/json" },
          redirect: "follow",
        });
        if (!response.ok) {
          throw new ToolError(this.name, `${response.status} ${response.statusText}`);
        }

        const body = (await response.text()).slice(0, maxBytes);
        const ref = context.evidence.record({
          type: "WEB",
          source: url.toString(),
          title: url.hostname + url.pathname,
          content: body,
          // Unvetted web content is worth materially less than stake-curated
          // upstream data, and the weighting must reflect that.
          reliability: 0.35,
          metadata: { status: response.status, contentType: response.headers.get("content-type") },
        });

        context.logger("http_get", { host, bytes: body.length });
        return { ref, url: url.toString(), status: response.status, content: body };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(this.name, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
      }
    },
  };
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h === "::1" || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}
