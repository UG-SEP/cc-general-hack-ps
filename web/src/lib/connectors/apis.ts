import type { ConnectorResult, RawItem } from "../types";
import { clip, fetchJson, stripTags } from "./http";

// ---------------- Hacker News (Algolia) ----------------
interface HnHit {
  objectID: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  story_text?: string;
}

export async function hackernews(query: string, limit: number): Promise<ConnectorResult> {
  // Algolia ranks all-time popular stories first, so recent requests found almost nothing. Fetch the best
  // matches from the last 60 days alongside the all-time ones, recent first, and dedupe.
  const n = Math.min(Math.max(limit, 20), 100);
  const base = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${n}`;
  const since = Math.floor(Date.now() / 1000) - 60 * 86_400;
  const url = `${base}&numericFilters=created_at_i>${since}`;
  const [recent, allTime] = await Promise.all([
    fetchJson<{ hits?: HnHit[] }>(url).catch(() => ({ hits: [] as HnHit[] })),
    fetchJson<{ hits?: HnHit[] }>(base),
  ]);
  const seen = new Set<string>();
  const hits = [...(recent.hits ?? []), ...(allTime.hits ?? [])].filter((h) => !seen.has(h.objectID) && seen.add(h.objectID));
  const items: RawItem[] = hits.slice(0, Math.max(limit, 30)).map((h) => {
    const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
    return {
      source: "hackernews",
      url: h.url || hnUrl,
      title: h.title ?? "(untitled)",
      text: clip(
        `${h.title ?? ""}\nPoints: ${h.points ?? 0} · Comments: ${h.num_comments ?? 0} · by ${h.author ?? "?"}\n${stripTags(h.story_text)}`,
        4000,
      ),
      fields: {
        title: h.title,
        points: h.points ?? 0,
        author: h.author,
        num_comments: h.num_comments ?? 0,
        url: h.url || hnUrl,
        hn_url: hnUrl,
        posted_at: h.created_at,
      },
      published_at: h.created_at,
    };
  });
  return { items, url };
}

// ---------------- GitHub repos ----------------
interface GhRepo {
  name: string;
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  owner: { login: string };
  homepage: string | null;
  topics?: string[];
  html_url: string;
  updated_at?: string;
  license?: { spdx_id?: string } | null;
}

export async function githubRepos(query: string, limit: number): Promise<ConnectorResult> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(limit, 100)}`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const d = await fetchJson<{ items?: GhRepo[] }>(url, { headers });
  const items: RawItem[] = (d.items ?? []).slice(0, limit).map((r) => ({
    source: "github_repos",
    url: r.html_url,
    title: r.full_name,
    text: clip(`${r.full_name}: ${r.description ?? ""}\nTopics: ${(r.topics ?? []).join(", ")}`, 4000),
    fields: {
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      forks: r.forks_count,
      language: r.language,
      owner: r.owner?.login,
      homepage: r.homepage || null,
      topics: r.topics ?? [],
      license: r.license?.spdx_id ?? null,
      updated_at: r.updated_at,
      url: r.html_url,
    },
    published_at: r.updated_at,
  }));
  return { items, url };
}

// ---------------- Wikipedia ----------------
interface WikiSearchHit {
  title: string;
  snippet: string;
  pageid: number;
}
interface WikiSummary {
  title: string;
  type?: string;
  extract?: string;
  description?: string;
  content_urls?: { desktop?: { page?: string } };
}

export async function wikipedia(query: string, limit: number): Promise<ConnectorResult> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${Math.min(limit, 50)}&srsearch=${encodeURIComponent(query)}`;
  const d = await fetchJson<{ query?: { search?: WikiSearchHit[] } }>(url);
  const hits = (d.query?.search ?? []).slice(0, limit);
  const items = await Promise.all(
    hits.map(async (h): Promise<RawItem | null> => {
      const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`;
      let text = stripTags(h.snippet);
      let description: string | undefined;
      if (hits.indexOf(h) < 10) {
        try {
          const s = await fetchJson<WikiSummary>(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
          );
          if (s.type === "disambiguation") return null; // lists of unrelated meanings, never a real entity
          if (s.extract) text = s.extract;
          description = s.description;
        } catch {
          /* keep snippet */
        }
      }
      return {
        source: "wikipedia",
        url: pageUrl,
        title: h.title,
        text: clip(text, 4000),
        fields: { title: h.title, description: description ?? null, url: pageUrl },
      };
    }),
  );
  return { items: items.filter((i): i is RawItem => i !== null && !/\(disambiguation\)$/i.test(i.title)), url };
}

// ---------------- CoinGecko ----------------
interface CgMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  price_change_percentage_24h: number | null;
  total_volume: number | null;
  last_updated?: string;
}

// Words that aren't coin names. Anything else is looked up as a coin, and CoinGecko's search always returns
// something: "in" → Bitcoin, "usd" → Tether, "defi" → Definitive, which replaced the top-coins list with them.
const GENERIC_CRYPTO = new RegExp(
  "^(" +
    [
      "top", "crypto", "cryptocurrenc(y|ies)", "coins?", "tokens?", "market", "markets", "cap", "by", "largest", "biggest",
      "price", "prices", "\\d+", "all", "the", "of", "and", "list", "in", "on", "for", "with", "to", "a", "an",
      "usd", "eur", "inr", "gbp", "dollars?", "rupees?", "euros?",
      "defi", "meme", "memecoins?", "layer", "layer-?[12]", "l[12]", "stablecoins?", "altcoins?",
      "today", "current", "currently", "latest", "now", "live", "value", "values", "rank", "ranking", "rankings",
      "volume", "trending", "best", "popular", "new", "highest", "most",
    ].join("|") +
    ")$",
  "i",
);
// Generic words that can still be part of a coin's name ("USD Coin", "Bitcoin Cash"): kept inside a phrase
const NAME_PART = /^(coins?|tokens?|usd|eur|gbp|inr|cash|network|protocol|finance)$/i;

// Category words → CoinGecko categories. Without this, "top meme coins" dropped "meme" and listed BTC, ETH, USDT.
const CATEGORIES: [RegExp, string, string][] = [
  [/\bmeme ?(coins?|tokens?)?\b|\bmemecoins?\b/i, "meme-token", "meme coins"],
  [/\bdefi\b|\bdecentrali[sz]ed finance\b/i, "decentralized-finance-defi", "DeFi"],
  [/\bstable ?coins?\b/i, "stablecoins", "stablecoins"],
  [/\blayer[- ]?1\b|\bl1s?\b/i, "layer-1", "layer 1"],
  [/\blayer[- ]?2\b|\bl2s?\b/i, "layer-2", "layer 2"],
  [/\bai (coins?|tokens?|crypto\w*)\b|\bartificial intelligence\b/i, "artificial-intelligence", "AI"],
  [/\bnfts?\b/i, "non-fungible-tokens-nft", "NFT"],
  [/\bgaming (coins?|tokens?|crypto\w*)\b/i, "gaming", "gaming"],
];

/**
 * What a crypto query asks for: a category, and the coins it names. Names are phrases split on commas / "and" /
 * "vs", with filler trimmed from both ends ("price of usd coin" → "usd coin"); `words` are each phrase's
 * non-generic words, tried one by one when the whole phrase isn't a coin ("bitcoin ethereum solana").
 */
function parseCryptoQuery(query: string) {
  let rest = query;
  let category: { id: string; label: string } | undefined;
  for (const [re, id, label] of CATEGORIES)
    if (re.test(rest)) {
      category ??= { id, label };
      rest = rest.replace(re, " ");
    }
  const filler = (w: string) => GENERIC_CRYPTO.test(w) && !NAME_PART.test(w);
  const names = rest
    .split(/,|&|\/|\band\b|\bvs\.?\b/i)
    .map((chunk) => {
      const words = chunk.split(/\s+/).filter(Boolean);
      while (words.length && filler(words[0])) words.shift();
      while (words.length && filler(words[words.length - 1])) words.pop();
      const specific = words.filter((w) => !GENERIC_CRYPTO.test(w));
      // "coins" alone is no name; "usd coin" (two words, all generic) may be
      return { phrase: words.join(" "), words: specific, lookup: specific.length > 0 || words.length > 1 };
    })
    .filter((n) => n.lookup);
  return { category, names };
}

type CoinHit = { id: string; name: string; symbol: string };
const squashName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
// a hit counts only when it IS the term (name, id or symbol): the most popular coin merely containing "inu" isn't Shiba Inu
const exactHit = (term: string, hits: CoinHit[]) => hits.find((h) => [h.name, h.id, h.symbol].some((v) => v && squashName(v) === squashName(term)));

/** Ids for the coins a query names. Search errors propagate: a 429 must reach the fallback, not look like "no match". */
async function resolveCoins(names: ReturnType<typeof parseCryptoQuery>["names"], search: (term: string) => Promise<CoinHit[]>) {
  const missed: string[] = [];
  const perName = await Promise.all(
    names.slice(0, 5).map(async (n): Promise<string[]> => {
      const whole = exactHit(n.phrase, await search(n.phrase));
      if (whole) return [whole.id];
      // one word that was the whole phrase: already searched
      if (!n.words.length || (n.words.length === 1 && n.words[0] === n.phrase)) {
        missed.push(n.phrase);
        return [];
      }
      const found = await Promise.all(n.words.slice(0, 5).map(async (w) => exactHit(w, await search(w))?.id ?? (missed.push(w), null)));
      return found.filter((x): x is string => !!x);
    }),
  );
  return { ids: [...new Set(perName.flat())], missed };
}

const noMatchWarning = (missed: string[]) => `No coin matched ${missed.map((m) => `"${m}"`).join(", ")}, so no market data was added for it`;

export async function coingecko(query: string, limit: number): Promise<ConnectorResult> {
  try {
    return await coingeckoPrimary(query, limit);
  } catch (e) {
    // CoinGecko's public API often 403/429s shared IPs; fall back to CoinPaprika (also keyless).
    try {
      return await coinpaprika(query, limit);
    } catch (e2) {
      throw new Error(`coingecko failed (${String(e)}); coinpaprika fallback failed (${String(e2)})`);
    }
  }
}

interface PaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  last_updated?: string;
  quotes?: { USD?: { price: number; market_cap: number; volume_24h: number; percent_change_24h: number } };
}

async function coinpaprika(query: string, limit: number): Promise<ConnectorResult> {
  const { category, names } = parseCryptoQuery(query);
  const { ids, missed } = await resolveCoins(names, (term) =>
    fetchJson<{ currencies?: CoinHit[] }>(`https://api.coinpaprika.com/v1/search?c=currencies&limit=5&q=${encodeURIComponent(term)}`).then(
      (r) => r.currencies ?? [],
    ),
  );
  const warnings = missed.length ? [noMatchWarning(missed)] : [];
  let url = "https://api.coinpaprika.com/v1/tickers";
  let tickers: PaprikaTicker[] = [];
  if (ids.length) {
    tickers = (await Promise.all(ids.map((id) => fetchJson<PaprikaTicker>(`https://api.coinpaprika.com/v1/tickers/${id}`).catch(() => null)))).filter(
      (t): t is PaprikaTicker => !!t,
    );
    url = `https://api.coinpaprika.com/v1/tickers/${ids.join(",")}`;
  } else if (missed.length) {
    // the user named coins and none matched: the top list instead would look like the answer
    return { items: [], url, warnings };
  } else if (category) {
    // CoinPaprika has no category filter, and its overall top list would pass for "top meme coins"
    return { items: [], url, warnings: [`The backup market data source can't filter by ${category.label}, so it added nothing`] };
  } else {
    const all = await fetchJson<PaprikaTicker[]>(url);
    tickers = (Array.isArray(all) ? all : []).filter((t) => t.rank > 0).sort((a, b) => a.rank - b.rank);
  }
  const items: RawItem[] = tickers.slice(0, limit).map((t) => {
    const q = t.quotes?.USD;
    const pageUrl = `https://coinpaprika.com/coin/${t.id}/`;
    return {
      source: "coingecko",
      url: pageUrl,
      title: `${t.name} (${t.symbol})`,
      text: `${t.name} (${t.symbol}): price $${q?.price}, market cap $${q?.market_cap}, rank #${t.rank}, 24h change ${q?.percent_change_24h}%, 24h volume $${q?.volume_24h}`,
      fields: {
        name: t.name,
        symbol: t.symbol,
        price_usd: q?.price ?? null,
        market_cap: q?.market_cap ?? null,
        market_cap_rank: t.rank,
        change_24h_pct: q?.percent_change_24h ?? null,
        volume_24h: q?.volume_24h ?? null,
        url: pageUrl,
        data_provider: "coinpaprika",
      },
      published_at: t.last_updated,
    };
  });
  return { items, url, warnings };
}

async function coingeckoPrimary(query: string, limit: number): Promise<ConnectorResult> {
  const { category, names } = parseCryptoQuery(query);
  const { ids, missed } = await resolveCoins(names, (term) =>
    fetchJson<{ coins?: CoinHit[] }>(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(term)}`).then((r) => (r.coins ?? []).slice(0, 10)),
  );
  const warnings = missed.length ? [noMatchWarning(missed)] : [];
  const base = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&page=1";
  if (!ids.length && missed.length) return { items: [], url: base, warnings };
  // named coins win over a category ("meme coins like pepe" → pepe)
  const perPage = Math.min(Math.max(ids.length || limit, 1), 250);
  const url = `${base}&per_page=${perPage}` + (ids.length ? `&ids=${ids.join(",")}` : category ? `&category=${category.id}` : "");
  const data = await fetchJson<CgMarket[]>(url);
  const items: RawItem[] = (Array.isArray(data) ? data : []).slice(0, limit).map((c) => {
    const pageUrl = `https://www.coingecko.com/en/coins/${c.id}`;
    return {
      source: "coingecko",
      url: pageUrl,
      title: `${c.name} (${c.symbol.toUpperCase()})`,
      text: `${c.name} (${c.symbol.toUpperCase()}): price $${c.current_price}, market cap $${c.market_cap}, rank #${c.market_cap_rank}, 24h change ${c.price_change_percentage_24h?.toFixed(2)}%, 24h volume $${c.total_volume}`,
      fields: {
        name: c.name,
        symbol: c.symbol.toUpperCase(),
        price_usd: c.current_price,
        market_cap: c.market_cap,
        market_cap_rank: c.market_cap_rank,
        change_24h_pct: c.price_change_percentage_24h,
        volume_24h: c.total_volume,
        url: pageUrl,
        ...(category && !ids.length ? { category: category.label } : {}),
      },
      published_at: c.last_updated,
    };
  });
  return { items, url, warnings };
}
