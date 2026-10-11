import { CONNECTORS } from "../connectors";
import { UserFacingError } from "../errors";
import { llmJSON } from "../llm";
import type { ConnectorId, FieldSpec, SourceStep, WorkflowPlan } from "../types";
import { blockedReason, REJECTION_MESSAGE, RejectedRequestError } from "./safety";

const CONNECTOR_IDS = Object.keys(CONNECTORS) as ConnectorId[];

const SYSTEM = `You are the planning agent of a data intelligence platform. A business user describes the dataset they need in plain English. You design a data-collection workflow.

Available connectors (only use these ids):
${CONNECTOR_IDS.map((id) => `- ${id}: ${CONNECTORS[id].description}`).join("\n")}

Return JSON:
{
  "title": short dataset title (max 60 chars),
  "intent": one sentence restating exactly what data is wanted,
  "entity": what one row represents (e.g. "job posting", "company", "sponsor"),
  "fields": [{"name": snake_case, "type": "string"|"number"|"url"|"date"|"email"|"list", "description": str, "required": bool}]  (4-9 fields; always include a name/title field and one url field; mark as required the name/title field and every field the user explicitly asked for, e.g. salary in "jobs with salary info", stars in "repos with star counts"; rows missing a required field rank lower),
  "sources": [{"connector": id, "query": str, "limit": int (20-40), "reason": short why}] (3-5 steps, so the dataset has enough rows: combine every connector that fits and add web_search steps with different phrasings; prefer structured API connectors when they fit; use web_search for open-ended business lists like sponsors, leads, events; use url_fetch only if the user gave URLs; queries must be short keyword queries tailored to each connector),
  "filters": [plain-English constraints from the request, e.g. "must mention salary", "posted in last 7 days", "based in India"],
  "subject_filters": [the filters (copied exactly) that define WHAT a row is: its topic, skill, technology or kind of thing, e.g. "must be a React or React Native role", "must be a vector database". A row failing one of these is not what the user asked for at all. Never list details like salary, location, dates or size here],
  "dedupe_on": [field names that identify a unique row],
  "sort_by": {"field": a number or date field, "direction": "desc"|"asc"} when the request implies an order ("top/largest by market cap" → market_cap desc, "most starred" → stars desc, "latest" → posted_at desc, "cheapest" → price asc), otherwise null,
  "max_results": int (default 50, max 150; "top 15" → 15)
}

The "intent" and "entity" must keep the user's subject (what kind of thing, about what): a place is only a constraint, never the whole request. "Video editing jobs in Lucknow" → entity "job posting", intent about video editing jobs; never "anything related to Lucknow".

Time words: write recency filters as rolling windows ("this week" → "posted in the last 7 days", "this month" → "posted in the last 30 days", "this year" → "posted in the last 12 months"), never calendar periods like "current month".

Locations: if the user names a place (city, state, country, region), it is a HARD constraint. Add a filter like "located in <place> (or <nearby places> if the user said near)" and do NOT widen it to "remote" or "anywhere" unless the user explicitly asks for remote work. "Freelance", "contract" or "part-time" describe the job type, not the location: a freelance job must still be in or open to the named place. For a named place outside Europe, never use arbeitnow_jobs (Europe only), and use remotive_jobs/remoteok_jobs only if the user explicitly accepts remote work. Instead plan 2-3 web_search steps with different phrasings that name the place and its main cities, e.g. "video editor jobs Lucknow", "video editing jobs Noida Uttar Pradesh", "freelance video editor Uttar Pradesh".

Refuse instead of planning when the request asks for sexual or adult content, rates or lists people by their looks or as dating/sexual prospects (e.g. "hot girls in <city>"), seeks private individuals or their personal details (home addresses, private phone numbers, people "near me"), or serves something illegal or harmful. Then return only {"rejected": true, "reason": one short sentence}. Never reinterpret such a request into a different, acceptable dataset. Ordinary business, public-figure and job requests are fine and must not be refused.

If the request is vague or ambiguous (and not refused), you MUST commit to the single most plausible business interpretation (never ask for clarification in "intent") (e.g. people, companies, products, jobs, events), state it explicitly in "intent", and plan concrete keyword queries for it. Never search for "disambiguation", never plan around the literal meaning of a single word, and prefer specific multi-word queries over one-word ones.`;

export async function planWorkflow(prompt: string): Promise<WorkflowPlan> {
  const blocked = blockedReason(prompt);
  if (blocked) throw new RejectedRequestError(blocked);
  try {
    const plan = await llmJSON<Omit<WorkflowPlan, "planner"> & { rejected?: boolean; reason?: string }>(SYSTEM, `User request:\n"""${prompt}"""`, 1200);
    if (plan?.rejected) throw new RejectedRequestError(`${REJECTION_MESSAGE}${plan.reason ? ` Reason: ${String(plan.reason).slice(0, 200)}` : ""}`);
    if (plan) return sanitize({ ...plan, planner: "llm" }, prompt);
  } catch (e) {
    if (e instanceof RejectedRequestError) throw e; // never fall back to the heuristic planner for a refused request
    console.error("LLM planning failed, using heuristic", e);
  }
  return heuristicPlan(prompt);
}

function sanitize(plan: WorkflowPlan, prompt: string): WorkflowPlan {
  const sources = (plan.sources ?? [])
    .filter((s) => CONNECTOR_IDS.includes(s.connector) && s.query?.trim())
    .slice(0, 5)
    .map((s) => ({ ...s, limit: Math.min(Math.max(s.limit ?? 25, 15), 40) }));
  const fields = (plan.fields ?? []).filter((f) => f?.name).slice(0, 10);
  if (!sources.length || !fields.length) return { ...heuristicPlan(prompt), title: plan.title || prompt.slice(0, 60) };
  return {
    title: (plan.title || prompt).slice(0, 80),
    intent: plan.intent || prompt,
    entity: plan.entity || "record",
    fields,
    sources,
    filters: cleanFilters(plan.filters),
    subject_filters: subjectFilters(cleanFilters(plan.filters), plan.subject_filters),
    sort_by: sortBy(fields, plan.sort_by),
    dedupe_on: (plan.dedupe_on ?? []).filter((d) => fields.some((f) => f.name === d)),
    max_results: Math.min(plan.max_results || 50, 150),
    planner: "llm",
  };
}

/** Keep sort_by only when it names a number or date column of the plan. */
function sortBy(fields: FieldSpec[], s: unknown): WorkflowPlan["sort_by"] {
  const { field, direction } = (s ?? {}) as { field?: unknown; direction?: unknown };
  const f = fields.find((x) => x.name === field);
  if (!f || (f.type !== "number" && f.type !== "date")) return undefined;
  return { field: f.name, direction: direction === "asc" ? "asc" : "desc" };
}

/** "top 15 …" / "15 largest …" → 15 */
const topN = (p: string) => {
  const m = p.match(/\b(?:top|best|largest|biggest)\s+(\d{1,3})\b|\b(\d{1,3})\s+(?:top|best|largest|biggest|most)\b/);
  const n = Number(m?.[1] ?? m?.[2]);
  return n >= 1 && n <= 150 ? n : undefined;
};

/** Same trimming as applyPlanEdits, so a reviewed plan sent back unchanged keeps its subject filters. */
const cleanFilters = (filters: unknown) =>
  (Array.isArray(filters) ? filters : []).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 8);

/** Keep only subject filters that are real filters of the plan (the model must not invent new ones). */
function subjectFilters(filters: string[], subject: unknown): string[] {
  if (!Array.isArray(subject)) return [];
  const known = new Map(filters.map((f) => [f.trim().toLowerCase(), f]));
  return [...new Set(subject.map((s) => known.get(String(s).trim().toLowerCase())).filter((f): f is string => !!f))];
}

// ---------- Heuristic fallback (no LLM key configured) ----------

const STOP = new Set(
  "find get list show me give collect gather scrape search for of the a an and or in on with from to that this these those all any some top best latest recent new who which are is be posted week month today companies company data about jobs job openings opening roles role hiring please i we need want github repo repos repository repositories open-source open source projects project tools most popular trending".split(
    " ",
  ),
);

function keywords(prompt: string, max = 5) {
  return prompt
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .slice(0, max)
    .join(" ");
}

const f = (name: string, type: FieldSpec["type"], description: string, required = false): FieldSpec => ({
  name,
  type,
  description,
  required,
});

export function heuristicPlan(prompt: string): WorkflowPlan {
  const p = prompt.toLowerCase();
  const kw = keywords(prompt) || prompt.slice(0, 50);
  const urls = prompt.match(/https?:\/\/\S+/g) ?? [];
  const sources: SourceStep[] = [];
  let fields: FieldSpec[];
  let entity = "record";
  let dedupe: string[] = ["name", "url"];

  // whole words: "internet companies" isn't "intern", and "developer tools on GitHub" is a repo search
  if (/\b(jobs?|hiring|developers?(?! (tools?|platforms?|experience|productivity|communit\w*|relations|portals?|docs))|engineers?|designers?|interns?|internships?|roles?|vacanc(y|ies)|openings?)\b/.test(p)) {
    entity = "job posting";
    const q = keywords(prompt, 3);
    sources.push(
      { connector: "remotive_jobs", query: q, limit: 30, reason: "Remote job board API" },
      { connector: "arbeitnow_jobs", query: q, limit: 30, reason: "Job board API" },
      { connector: "remoteok_jobs", query: q, limit: 30, reason: "Remote job board API" },
      { connector: "web_search", query: `${keywords(prompt, 6)} jobs`, limit: 10, reason: "Local and on-site job listings" },
    );
    fields = [
      f("title", "string", "Job title", true),
      f("company", "string", "Hiring company", true),
      f("location", "string", "Location / remote"),
      f("salary", "string", "Salary if listed"),
      f("job_type", "string", "Full-time, contract..."),
      f("tags", "list", "Skills / tags"),
      f("posted_at", "date", "Posting date"),
      f("apply_url", "url", "Where to apply"),
    ];
    dedupe = ["title", "company"];
  } else if (/\b(crypto\w*|coins?|bitcoin|ethereum|tokens?|market cap)\b/.test(p)) {
    entity = "cryptocurrency";
    sources.push({ connector: "coingecko", query: kw, limit: 40, reason: "Live market data API" });
    fields = [
      f("name", "string", "Asset name", true),
      f("symbol", "string", "Ticker"),
      f("price_usd", "number", "Price in USD"),
      f("market_cap", "number", "Market cap USD"),
      f("change_24h_pct", "number", "24h change %"),
      f("volume_24h", "number", "24h volume"),
      f("url", "url", "Source page"),
    ];
    dedupe = ["symbol"];
  } else if (/\b(github|repo|repositor|open[- ]source|library|framework)/.test(p)) {
    entity = "repository";
    sources.push({ connector: "github_repos", query: kw, limit: 30, reason: "GitHub search API" });
    fields = [
      f("name", "string", "Repository", true),
      f("owner", "string", "Owner / org"),
      f("description", "string", "What it does"),
      f("stars", "number", "GitHub stars"),
      f("language", "string", "Primary language"),
      f("homepage", "url", "Website"),
      f("url", "url", "Repository URL", true),
    ];
    dedupe = ["url"];
  } else {
    entity = /sponsor/.test(p) ? "sponsor" : /lead|compan|startup|vendor|agenc/.test(p) ? "company" : "result";
    if (urls.length) sources.push({ connector: "url_fetch", query: urls.join(" "), limit: 10, reason: "User-provided URLs" });
    sources.push(
      { connector: "web_search", query: kw, limit: 8, reason: "Open web search for matching pages" },
      { connector: "wikipedia", query: kw, limit: 8, reason: "Encyclopedic background entities" },
    );
    if (/\b(news|discussion|trend|hacker|launch)/.test(p))
      sources.push({ connector: "hackernews", query: kw, limit: 20, reason: "Tech community discussions" });
    fields = [
      f("name", "string", `Name of the ${entity}`, true),
      f("description", "string", "Short summary"),
      f("category", "string", "Category / type"),
      f("location", "string", "Location if known"),
      f("url", "url", "Source / website", true),
    ];
  }

  return {
    title: prompt.length > 60 ? prompt.slice(0, 57) + "…" : prompt,
    intent: prompt,
    entity,
    fields,
    sources,
    filters: [],
    dedupe_on: dedupe,
    sort_by:
      entity === "cryptocurrency"
        ? { field: "market_cap", direction: "desc" }
        : entity === "repository" && /\b(top|popular|most starred|best|largest)\b/.test(p)
          ? { field: "stars", direction: "desc" }
          : undefined,
    max_results: topN(p) ?? 60,
    planner: "heuristic",
  };
}

// ---------- User-edited plans (review step) ----------

const FIELD_TYPES = new Set<FieldSpec["type"]>(["string", "number", "url", "date", "email", "list"]);

// edits come from the client: anything that isn't a list of objects falls back to the stored plan
const editList = <T>(v: unknown, stored: T[]) => (Array.isArray(v) ? v : stored).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");

/**
 * Accept the user's edits to columns/sources/filters, keeping everything else from the stored plan. Each field and
 * step is rebuilt from known keys, so stray client keys never reach the plan; throws UserFacingError or
 * RejectedRequestError (edited queries go through the same safety check as prompts).
 */
export function applyPlanEdits(original: WorkflowPlan, edited: Partial<WorkflowPlan>): WorkflowPlan {
  const fields: FieldSpec[] = editList(edited.fields, original.fields)
    .map((f) => ({
      name: String(f.name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40),
      type: FIELD_TYPES.has(f.type as FieldSpec["type"]) ? (f.type as FieldSpec["type"]) : "string",
      description: String(f.description ?? "").slice(0, 200),
      ...(f.required === true ? { required: true } : {}),
    }))
    .filter((f, i, all) => f.name && all.findIndex((g) => g.name === f.name) === i)
    .slice(0, 14);
  const sources: SourceStep[] = editList(edited.sources, original.sources)
    .filter((s) => CONNECTOR_IDS.includes(s.connector as ConnectorId) && String(s.query ?? "").trim())
    .slice(0, 6)
    .map((s) => ({
      connector: s.connector as ConnectorId,
      query: String(s.query).trim().slice(0, 300),
      limit: Math.min(Math.max(Number(s.limit) || 20, 3), 40),
      ...(typeof s.reason === "string" ? { reason: s.reason.slice(0, 200) } : {}),
    }));
  if (!fields.length) throw new UserFacingError("Keep at least one column.");
  if (!sources.length) throw new UserFacingError("Keep at least one source.");
  const filters = (Array.isArray(edited.filters) ? edited.filters : original.filters).map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 8);
  // only text the user typed: the planner's own wording already passed (the prompt check and the LLM's judgement)
  const before = new Set([...original.sources.map((s) => s.query), ...original.filters, ...original.fields.map((f) => f.description)]);
  const typed = [...sources.map((s) => s.query), ...filters, ...fields.map((f) => f.description)].filter((t) => !before.has(t));
  const blocked = blockedReason(typed.join("\n"));
  if (blocked) throw new RejectedRequestError(blocked);
  const dedupe = original.dedupe_on.filter((d) => fields.some((f) => f.name === d));
  // a filter whose text the user changed is no longer known to define the subject, so it becomes a detail filter
  const subject_filters = (original.subject_filters ?? []).filter((s) => filters.includes(s));
  // a sort on a column the user renamed or removed is dropped rather than silently doing nothing
  const sort_by = sortBy(fields, original.sort_by);
  return { ...original, fields, sources, filters, subject_filters, sort_by, dedupe_on: dedupe.length ? dedupe : [fields[0].name] };
}
