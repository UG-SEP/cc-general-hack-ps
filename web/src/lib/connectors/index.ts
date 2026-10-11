import type { ConnectorId, ConnectorResult } from "../types";
import { coingecko, githubRepos, hackernews, wikipedia } from "./apis";
import { arbeitnowJobs, remoteokJobs, remotiveJobs } from "./jobs";
import { urlFetch, webSearch } from "./web";

export interface Connector {
  label: string;
  description: string;
  run: (query: string, limit: number) => Promise<ConnectorResult>;
}

export const CONNECTORS: Record<ConnectorId, Connector> = {
  remotive_jobs: {
    label: "Remotive (remote jobs)",
    description:
      "Remote-only job postings from Remotive.com, worldwide; no on-site jobs and nothing tied to a specific city (mostly tech: software, data, devops, design, marketing, support). Structured fields: title, company, location, salary, job_type, tags, posted_at, apply_url. Query: 1-3 short keywords like a role or skill, e.g. \"python\", \"frontend react\", \"data engineer\". Do NOT include words like 'remote' or locations.",
    run: remotiveJobs,
  },
  arbeitnow_jobs: {
    label: "Arbeitnow (EU jobs)",
    description:
      "Recent job postings from Arbeitnow, Europe only (mostly Germany/Switzerland/Austria); never use it for jobs in other regions (many on-site/hybrid, some remote, some in German). Structured fields: title, company, location, remote, job_type, tags, posted_at, apply_url. Query: keywords matched client-side against title/company/tags/location, e.g. \"backend developer berlin\" or \"marketing\".",
    run: arbeitnowJobs,
  },
  remoteok_jobs: {
    label: "RemoteOK (remote jobs)",
    description:
      "Latest ~100 remote-only job postings from RemoteOK (no on-site or city-specific jobs) (tech/startups, often with salary ranges). Structured fields: title, company, location, salary, tags, posted_at, apply_url. Query: skill/role keywords matched against title/company/tags, e.g. \"golang\", \"devops\", \"senior engineer\".",
    run: remoteokJobs,
  },
  hackernews: {
    label: "Hacker News",
    description:
      "Hacker News stories via Algolia search: tech news, startup launches (Show HN), discussions. Fields: title, points, author, num_comments, url, hn_url, posted_at. Query: plain keywords, e.g. \"Show HN AI agents\", \"rust web framework\".",
    run: hackernews,
  },
  github_repos: {
    label: "GitHub repositories",
    description:
      "GitHub repository search sorted by stars: open-source projects, libraries, tools. Fields: name, full_name, description, stars, forks, language, owner, homepage, topics, license, url. Query uses GitHub search syntax, e.g. \"vector database language:rust\", \"topic:llm stars:>1000\", \"react component library\".",
    run: githubRepos,
  },
  wikipedia: {
    label: "Wikipedia",
    description:
      "English Wikipedia articles: summaries of companies, people, places, concepts, and list articles. Returns title + lead-section summary text per article. Query: an entity or topic, e.g. \"largest semiconductor companies\", \"Y Combinator\", \"List of unicorn startup companies\".",
    run: wikipedia,
  },
  web_search: {
    label: "Web search",
    description:
      "General web search (Firecrawl when configured, otherwise DuckDuckGo/Bing) that also fetches and extracts readable text from the top result pages. Best for anything not covered by a dedicated API: companies, events, sponsors, conferences, product lists, news, pricing. Query: a concise search-engine query, e.g. \"AI startups hiring in Bangalore 2026\", \"KubeCon 2026 sponsors\".",
    run: webSearch,
  },
  url_fetch: {
    label: "Fetch URL",
    description:
      "Fetch specific web page(s) directly and extract their main text plus up to 30 outbound links (anchor text + URL), which is useful for extracting lists of companies/sponsors/exhibitors/team members from a known page. Query: one or more full URLs separated by spaces or commas, e.g. \"https://example.com/sponsors\". Only use when the user gave a URL or you are confident of the exact URL.",
    run: urlFetch,
  },
  coingecko: {
    label: "CoinGecko (crypto prices)",
    description:
      "Live cryptocurrency market data from CoinGecko. Fields: name, symbol, price_usd, market_cap, market_cap_rank, change_24h_pct, volume_24h, url. Query: either generic (\"top coins by market cap\") to get the top N by market cap, a category (\"top meme coins\", \"defi tokens\", \"stablecoins\", \"layer 2\", \"AI coins\") to get the top N in it, or specific coin names separated by commas (\"bitcoin, usd coin, shiba inu\").",
    run: coingecko,
  },
};

export const CONNECTOR_IDS = Object.keys(CONNECTORS) as ConnectorId[];
