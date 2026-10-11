import type { ConnectorResult, RawItem } from "../types";
import { clip, fetchJson, htmlToText, queryWords } from "./http";

// Seniority and role words appear in most postings, so they can't be the only reason a job matches.
const GENERIC = new Set(["senior", "junior", "mid", "lead", "staff", "principal", "head", "engineer", "engineering", "developer", "development", "manager", "specialist", "intern", "software", "full", "time", "part", "contract", "freelance"]);

// Words about the listing, not the job: a posting rarely says "salary" or "this week", so requiring them dropped everything
const NOISE = new Set(["salary", "salaries", "pay", "compensation", "posted", "this", "week", "weeks", "month", "today", "latest", "recent", "new", "info", "information", "details", "hiring", "openings", "opening", "opportunities", "vacancies", "top", "best", "worldwide", "anywhere"]);
// boards write a skill differently from the query: "go" jobs say "Golang"
const ALIASES: Record<string, string[]> = { go: ["golang"], golang: ["go"], js: ["javascript"], ts: ["typescript"], k8s: ["kubernetes"] };

/**
 * Keep jobs that mention the query's specific words (skills, places: not "senior", "engineer"): all of them when
 * there are one or two, else all but one; best first, title hits counting most. Tags and descriptions are weak on
 * their own: boards tag freely (a "Quality Dispense Technician" tagged golang) and descriptions list whole stacks.
 * So a job also needs a specific word in its title, or in both its tags and description.
 */
function matchJobs<T>(items: T[], query: string, parts: (t: T) => { title: string; tags: string; text?: string }): T[] {
  const words = queryWords(query).filter((w) => !NOISE.has(w));
  if (!words.length) return items;
  const specific = words.some((w) => !GENERIC.has(w)) ? words.filter((w) => !GENERIC.has(w)) : words;
  const squash = (s: string) => s.replace(/[-\s]+/g, "");
  // "front-end" / "front end" match "frontend"; only for longer words, where joining can't fake a match
  // short words match whole words only: "ai" mustn't hit "maintenance", nor "go" hit "google"
  const forms = (w: string) => [w, ...(ALIASES[w] ?? [])];
  const short = new Map(
    [...new Set(words.flatMap(forms))].filter((w) => w.length <= 3).map((w) => [w, new RegExp(`(^|[^a-z0-9])${w.replace(/[+#.]/g, "\\$&")}(?![a-z0-9])`)]),
  );
  const hasForm = (hay: string, w: string) => short.get(w)?.test(hay) ?? (hay.includes(w) || (w.length >= 5 && squash(hay).includes(w)));
  const has = (hay: string, w: string) => forms(w).some((f) => hasForm(hay, f));
  const scored = items.map((it, i) => {
    const p = parts(it);
    const [title, tags, text] = [p.title.toLowerCase(), p.tags.toLowerCase(), (p.text ?? "").toLowerCase()];
    let found = 0;
    let strong = false;
    let score = 0;
    for (const w of words) {
      const [inTitle, inTags, inText] = [has(title, w), has(tags, w), has(text, w)];
      if (specific.includes(w) && (inTitle || inTags || inText)) found++;
      if (specific.includes(w) && (inTitle || (inTags && inText))) strong = true;
      score += (inTitle ? 3 : 0) + (inTags ? 1 : 0) + (inText ? 1 : 0);
    }
    return { it, i, found, strong, score };
  });
  // half the words let "backend developer berlin" keep every Berlin developer job; one miss allowed from three on
  const need = specific.length <= 2 ? specific.length : specific.length - 1;
  return scored
    .filter((x) => x.strong && x.found >= need)
    .sort((a, b) => b.found - a.found || b.score - a.score || a.i - b.i)
    .map((x) => x.it);
}

// Pay in English and German (Arbeitnow): a salary-sized amount (3+ digits or "90k") next to a currency or pay word.
const MONEY = /[$€£₹]\s?\d|\d\s?[$€£₹]|\b(usd|eur|gbp|chf|inr)\s?\d|\d\s?(usd|eur|gbp|chf|inr)\b/i;
const AMOUNT = /(\d[\d,.\s]*\d\d|\d{2,3}\s?k\b|\d{1,3}(\.\d+)?\s?(lpa|lakhs?|lacs?)\b)(?!\s?%)/i; // "100%" is not an amount; "12 LPA" is
const PAY_WORD = /\b(salary|salaries|compensation|pay|wage|stipend|ctc|lpa|lakhs?|gehalt|vergütung|bezahlung)\b|per (year|annum|month|hour)|\/\s?(yr|year|month|hr|hour)\b/i;
// Money that isn't the job's pay: funding, market size, product prices, perks
const NOT_PAY = /\d\s?[mb]\b|million|billion|\b(raised|funding|valuation|revenue|market|series [a-e]|investors?|paid out|start for|price|allowance|voucher|gutschein|ticket|coupon|discount|holiday|vacation|urlaub|coworking|401\s?\(?k\)?)/i;

/**
 * Job APIs often leave salary empty and state it deep in the description, but extraction only reads the start of
 * an API item's text. Put the sentences that state pay at the front so the AI sees them.
 */
function payFirst(text: string): string {
  const pay = text
    .split(/[.!?]\s+|\n+|\\n/) // some feeds keep "\n" as literal text
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 300 && AMOUNT.test(s) && (MONEY.test(s) || PAY_WORD.test(s)) && !NOT_PAY.test(s))
    .slice(0, 3);
  return pay.length ? `Pay mentioned: ${pay.join(" … ")}`.slice(0, 350) + `\n\n${text}` : text;
}

// ---------------- Remotive ----------------
interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

export async function remotiveJobs(query: string, limit: number): Promise<ConnectorResult> {
  const q = query.trim();
  const url = `https://remotive.com/api/remote-jobs?${q ? `search=${encodeURIComponent(q)}&` : ""}limit=${Math.max(limit * 2, 20)}`;
  const data = await fetchJson<{ jobs?: RemotiveJob[] }>(url);
  let jobs = data.jobs ?? [];
  // Remotive's search is phrase-ish; if nothing, retry with the first keyword.
  if (!jobs.length && queryWords(q).length > 1) {
    const kw = queryWords(q)[0];
    const d2 = await fetchJson<{ jobs?: RemotiveJob[] }>(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(kw)}&limit=${Math.max(limit * 3, 30)}`,
    );
    jobs = d2.jobs ?? [];
  }
  // Remotive's search also returns jobs that don't mention the query anywhere; drop those instead of padding with them
  const desc = new Map(jobs.map((j) => [j, htmlToText(j.description)]));
  jobs = matchJobs(jobs, q, (j) => ({
    title: j.title,
    // location too, so "react developer europe" can match a job open to Europe
    tags: `${(j.tags ?? []).join(" ")} ${j.category ?? ""} ${j.candidate_required_location ?? ""}`,
    text: desc.get(j),
  }));
  const items: RawItem[] = jobs.slice(0, limit).map((j) => {
    const text = desc.get(j) ?? "";
    const fields = {
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location ?? null,
      salary: j.salary || null,
      job_type: j.job_type ?? null,
      tags: j.tags ?? [],
      category: j.category ?? null,
      posted_at: j.publication_date ?? null,
      apply_url: j.url,
    };
    return {
      source: "remotive_jobs",
      url: j.url,
      title: `${j.title} — ${j.company_name}`,
      text: clip(j.salary ? text : payFirst(text), 4000),
      fields,
      published_at: j.publication_date,
    };
  });
  return { items, url };
}

// ---------------- Arbeitnow ----------------
interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

// same rule as the other boards: any one word used to be enough, so "backend developer berlin" kept every developer job
const arbeitnowText = new WeakMap<ArbeitnowJob, string>(); // matched after every page: convert each description once
const matchArbeitnow = (jobs: ArbeitnowJob[], query: string) =>
  matchJobs(jobs, query, (j) => {
    if (!arbeitnowText.has(j)) arbeitnowText.set(j, htmlToText(j.description));
    return { title: j.title, tags: `${j.tags.join(" ")} ${j.company_name} ${j.location}`, text: arbeitnowText.get(j) };
  });

export async function arbeitnowJobs(query: string, limit: number): Promise<ConnectorResult> {
  const base = "https://www.arbeitnow.com/api/job-board-api";
  const all: ArbeitnowJob[] = [];
  // Pull a few pages so client-side filtering has something to chew on.
  for (let page = 1; page <= 3; page++) {
    const d = await fetchJson<{ data?: ArbeitnowJob[] }>(`${base}?page=${page}`).catch((e) => {
      if (page === 1) throw e;
      return { data: [] as ArbeitnowJob[] };
    });
    const batch = d.data ?? [];
    all.push(...batch);
    if (!batch.length) break;
    if (matchArbeitnow(all, query).length >= limit) break;
  }
  const ranked = matchArbeitnow(all, query);
  const items: RawItem[] = ranked.slice(0, limit).map((j) => {
    const posted = j.created_at ? new Date(j.created_at * 1000).toISOString() : undefined;
    return {
      source: "arbeitnow_jobs",
      url: j.url,
      title: `${j.title} — ${j.company_name}`,
      text: clip(payFirst(htmlToText(j.description)), 4000), // Arbeitnow has no salary field
      fields: {
        title: j.title,
        company: j.company_name,
        location: j.location || null,
        remote: j.remote,
        salary: null,
        job_type: (j.job_types ?? []).join(", ") || null,
        tags: j.tags ?? [],
        posted_at: posted ?? null,
        apply_url: j.url,
      },
      published_at: posted,
    };
  });
  return { items, url: base };
}

// ---------------- RemoteOK ----------------
interface RemoteOkJob {
  id?: string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  apply_url?: string;
  url?: string;
  legal?: string;
}

export async function remoteokJobs(query: string, limit: number): Promise<ConnectorResult> {
  const url = "https://remoteok.com/api";
  const data = await fetchJson<RemoteOkJob[]>(url);
  const jobs = (Array.isArray(data) ? data : []).filter((j) => !j.legal && j.position);
  // any single word used to be enough ("senior" kept a Senior Accountant); now every word, title or description first
  const desc = new Map(jobs.map((j) => [j, htmlToText(j.description)]));
  const ranked = matchJobs(jobs, query, (j) => ({
    title: j.position ?? "",
    tags: `${(j.tags ?? []).join(" ")} ${j.company ?? ""} ${j.location ?? ""}`,
    text: desc.get(j),
  }));
  const items: RawItem[] = ranked.slice(0, limit).map((j) => {
    const pageUrl = j.url || `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`;
    // one end missing is "from" / "up to", never "$? - $120000"
    const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
    const salary =
      j.salary_min && j.salary_max
        ? `${usd(j.salary_min)} - ${usd(j.salary_max)}`
        : j.salary_max
          ? `up to ${usd(j.salary_max)}`
          : j.salary_min
            ? `from ${usd(j.salary_min)}`
            : null;
    return {
      source: "remoteok_jobs",
      url: pageUrl,
      title: `${j.position} — ${j.company}`,
      text: clip(salary ? (desc.get(j) ?? "") : payFirst(desc.get(j) ?? ""), 4000),
      fields: {
        title: j.position,
        company: j.company,
        location: j.location || null,
        salary,
        job_type: null,
        tags: j.tags ?? [],
        posted_at: j.date ?? null,
        apply_url: j.apply_url || pageUrl,
      },
      published_at: j.date,
    };
  });
  return { items, url };
}
