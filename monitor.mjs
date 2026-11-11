// Monitor de vagas -> Telegram
// Lê as APIs públicas de vagas (Greenhouse, Lever, Ashby, InHire e os portais da Gupy e da Sólides),
// filtra por cargo/local e avisa no Telegram só o que for novo.
// Node 20+ (usa fetch nativo). Sem dependências.

import { readFile, writeFile } from "node:fs/promises";
import { avaliar } from "./avaliar-cv.mjs";

const CONFIG_FILE = new URL("./config.json", import.meta.url);
const STATE_FILE = new URL("./seen.json", import.meta.url);
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = process.env;

const norm = (s) =>
  (s ?? "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Fontes: cada uma devolve { id, title, company, location, url, postedAt } ----------

const sources = {
  async greenhouse({ slug, name }) {
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (data.jobs ?? []).map((j) => ({
      id: `greenhouse:${slug}:${j.id}`,
      title: j.title,
      company: name ?? slug,
      location: j.location?.name ?? "",
      url: j.absolute_url,
      postedAt: j.first_published ?? j.updated_at,
    }));
  },

  async lever({ slug, name }) {
    const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!Array.isArray(data)) return [];
    return data.map((j) => ({
      id: `lever:${slug}:${j.id}`,
      title: j.text,
      company: name ?? slug,
      location: [j.categories?.location, j.workplaceType].filter(Boolean).join(" · "),
      url: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
    }));
  },

  async ashby({ slug, name }) {
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (data.jobs ?? []).map((j) => ({
      id: `ashby:${slug}:${j.id}`,
      title: j.title,
      company: name ?? slug,
      location: [j.location, j.isRemote ? "Remote" : ""].filter(Boolean).join(" · "),
      url: j.jobUrl,
      postedAt: j.publishedAt,
    }));
  },

  // Página de carreiras no Workable (API v3, um endereço por empresa).
  async workable({ slug, name }) {
    const res = await fetch(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.results ?? []).map((j) => ({
      id: `workable:${slug}:${j.shortcode}`,
      title: j.title,
      company: name ?? slug,
      location: [j.location?.city, j.location?.country, j.workplace].filter(Boolean).join(", "),
      url: `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
      postedAt: j.published,
    }));
  },

  // Página de carreiras no InHire (um endereço por empresa; a API não informa a data de publicação).
  async inhire({ slug, name }) {
    const data = await getJson("https://api.inhire.app/job-posts/public/pages", { "X-Tenant": slug });
    return (data.jobsPage ?? []).map((j) => ({
      id: `inhire:${slug}:${j.jobId}`,
      title: j.displayName,
      company: name ?? data.tenantName ?? slug,
      location: [j.location, j.workplaceType].filter(Boolean).join(" · "),
      url: `https://${slug}.inhire.app/vagas/${j.jobId}/${norm(j.displayName).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    }));
  },

  // Página de vagas da ilegra (sistema próprio, "Recru"; não informa a data de publicação).
  async ilegra() {
    const data = await getJson("https://recru-backend.hub.ilegra.com/vacancies?page=0&size=100");
    return (data.content ?? []).map((j) => ({
      id: `ilegra:${j.id}`,
      title: j.title,
      company: "ilegra",
      location: (j.tags ?? []).map((t) => t.name).filter((n) => n && !/PCD|Efetivo/i.test(n)).join(" · "),
      url: `https://vagas.ilegra.com/vacancy/${j.id}`,
    }));
  },

  // Página de vagas da Arbitralis (site próprio, sem API; lê o HTML e extrai os links).
  async arbivagas() {
    const res = await fetch("https://arbivagas.win/vagas", { headers: { accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Links no formato /vagas/<slug>
    const seen = new Set();
    return [...html.matchAll(/href="\/vagas\/([^"]+)"/g)]
      .filter(([, slug]) => !seen.has(slug) && seen.add(slug))
      .map(([, slug]) => {
        const title = slug.replace(/-/g, " ").replace(/\w/g, (c) => c.toUpperCase());
        return {
          id: `arbivagas:${slug}`,
          title,
          company: "Arbitralis",
          location: "",
          url: `https://arbivagas.win/vagas/${slug}`,
        };
      });
  },

  // Busca por palavra-chave no portal público da Gupy (cobre todas as empresas que usam Gupy).
  async gupy({ term }) {
    const url = `https://portal.gupy.io/api/job-search/jobs?jobName=${encodeURIComponent(term)}&limit=50&offset=0&sortBy=publishedDate&sortOrder=desc`;
    const data = await getJson(url);
    return (data.data ?? []).map((j) => ({
      id: `gupy:${j.id}`,
      title: j.name,
      company: (j.jobUrl ?? "").match(/\/\/([^.]+)\.gupy\.io/)?.[1] ?? j.careerPageName ?? "Gupy",
      location: [j.city, j.state, j.workplaceType, j.isRemoteWork ? "remoto" : ""]
        .filter(Boolean)
        .join(" · "),
      url: j.jobUrl,
      postedAt: j.publishedDate,
      brasil: true,
    }));
  },

  // Busca por palavra-chave no portal Sólides Vagas (resultados do mais recente para o mais antigo).
  async solides({ term }) {
    const url = `https://vagas.solides.com.br/api/vacancies?page=1&take=14&title=${encodeURIComponent(term)}&locations=`;
    const data = await getJson(url);
    return (data.data ?? []).map((j) => ({
      id: `solides:${j.id}`,
      title: j.title,
      company: j.companyName ?? j.slug ?? "Sólides",
      location: [j.city?.name, j.state?.name, j.jobType, j.homeOffice ? "remoto" : ""].filter(Boolean).join(" · "),
      url: j.slug ? `https://${j.slug}.vagas.solides.com.br/vaga/${j.id}` : "https://vagas.solides.com.br/",
      postedAt: j.createdAt ? `${j.createdAt}T12:00:00-03:00` : undefined,
      dateOnly: true,
      brasil: true,
    }));
  },

  // Página de vagas no Mindsight (um endereço por empresa; extrai o JSON embutido no __NEXT_DATA__).
  async mindsight({ slug, name }) {
    const res = await fetch(`https://oportunidades.mindsight.com.br/${slug}?page=1&pageSize=100`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return [];
    const data = JSON.parse(m[1]);
    const postings = data?.props?.pageProps?.publicJobPostings ?? [];
    return postings.map((j) => ({
      id: `mindsight:${slug}:${j.id}`,
      title: j.name,
      company: name ?? slug,
      location: [j.city, j.state, j.work_model === "REMOTE" ? "Remoto" : j.work_model].filter(Boolean).join(", "),
      url: `https://oportunidades.mindsight.com.br/${slug}/${j.id}`,
      postedAt: j.external_publication_start_at || j.created_at,
      brasil: true,
    }));
  },
};

// ---------- Filtro ----------

function matches(job, cfg, boardIsBrazilian) {
  const title = norm(job.title);
  if (!cfg.titulos.some((t) => title.includes(norm(t)))) return false;
  if (cfg.excluir.some((t) => title.includes(norm(t)))) return false;
  if (cfg.empresasExcluidas.some((e) => norm(job.company).includes(norm(e)))) return false;

  const loc = norm(job.location);
  if (boardIsBrazilian || job.brasil) {
    // Empresa brasileira: aceita remoto, Brasília ou local não informado.
    if (!loc) return true;
    return cfg.locaisBrasil.some((l) => loc.includes(norm(l)));
  }
  // Empresa de fora: só se a vaga citar Brasil/LatAm.
  return cfg.locaisGlobais.some((l) => loc.includes(norm(l)));
}

// ---------- Buscar descrição completa da vaga ----------

async function fetchDescricao(job) {
  try {
    const [source] = job.id.split(":");
    // Greenhouse: API retorna HTML da descrição
    if (source === "greenhouse") {
      const parts = job.id.split(":");
      const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${parts[1]}/jobs/${parts[2]}`);
      return stripHtml(data.content ?? "") + " " + (data.departments?.map(d => d.name).join(" ") ?? "");
    }
    // Lever: API retorna listas de texto
    if (source === "lever") {
      const parts = job.id.split(":");
      const data = await getJson(`https://api.lever.co/v0/postings/${parts[1]}/${parts[2]}`);
      return (data.descriptionPlain ?? "") + " " + (data.lists ?? []).map(l => l.text + " " + l.content).join(" ");
    }
    // Ashby
    if (source === "ashby") {
      const parts = job.id.split(":");
      const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${parts[1]}`);
      const j = (data.jobs ?? []).find(j => j.id === parts[2]);
      return stripHtml(j?.descriptionHtml ?? j?.descriptionPlain ?? "");
    }
    // Gupy: busca individual — a URL contém o job encoded
    if (source === "gupy" && job.url) {
      const res = await fetch(job.url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const html = await res.text();
        return stripHtml(html).slice(0, 8000);
      }
    }
    // Sólides
    if (source === "solides") {
      const parts = job.id.split(":");
      const data = await getJson(`https://vagas.solides.com.br/api/vacancies/${parts[1]}`);
      return stripHtml(data.description ?? "") + " " + (data.requirements ?? "");
    }
  } catch (e) {
    console.warn(`Não consegui buscar descrição de ${job.id}: ${e.message}`);
  }
  // Fallback: usa título + location
  return `${job.title} ${job.company} ${job.location}`;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

// ---------- Telegram ----------

const esc = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function formatJob(job) {
  const when = job.postedAt
    ? new Date(job.postedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", ...(job.dateOnly ? {} : { timeStyle: "short" }) })
    : "data não informada pela fonte";

  // Busca descrição e avalia aderência
  let aderencia = "";
  try {
    const desc = await fetchDescricao(job);
    const r = await avaliar(desc, job.title, job.company);
    aderencia = "\n" + r.resumo;
  } catch (e) {
    console.warn(`Avaliação falhou para ${job.title}: ${e.message}`);
  }

  return [
    `🆕 <b>${esc(job.title)}</b>`,
    `🏢 ${esc(job.company)}`,
    `📍 ${esc(job.location || "local não informado")}`,
    `🕒 Publicada: ${when}`,
    `<a href="${esc(job.url)}">Abrir vaga</a>`,
    aderencia,
  ].filter(Boolean).join("\n");
}

async function sendTelegram(text) {
  if (DRY_RUN) return console.log(`\n[DRY_RUN]\n${text}`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Faltam TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID");
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram: HTTP ${res.status} ${await res.text()}`);
}

// Envia uma lista de vagas em uma ou mais mensagens (limite do Telegram: 4096 caracteres).
async function sendList(head, jobs) {
  const day = (j) => (j.postedAt ? new Date(j.postedAt).getTime() : 0);
  const lines = [...jobs]
    .sort((a, b) => day(b) - day(a))
    .map((j) => {
      const d = j.postedAt
        ? new Date(j.postedAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
        : "s/ data";
      return `• ${d} · <a href="${esc(j.url)}">${esc(j.title.trim())}</a> · ${esc(j.company)}`;
    });
  let chunk = head;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3500) {
      await sendTelegram(chunk);
      chunk = "(continuação)";
    }
    chunk += `\n${line}`;
  }
  await sendTelegram(chunk);
}

// ---------- Execução ----------

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  let seen = null;
  try {
    seen = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    /* primeira execução */
  }
  const firstRun = seen === null;
  seen ??= {};
  const seeded = []; // vagas já abertas em fontes novas: vão juntas em uma lista, sem aviso individual

  const tasks = [
    ...cfg.empresas.map((b) => ({ label: `${b.ats}:${b.slug}`, brasil: !!b.brasil, run: () => sources[b.ats](b) })),
    ...cfg.gupyTermos.map((term) => ({ label: `gupy:"${term}"`, brasil: true, run: () => sources.gupy({ term }) })),
    ...(cfg.solidesTermos ?? []).map((term) => ({ label: `solides:"${term}"`, brasil: true, run: () => sources.solides({ term }) })),
    ...(cfg.arbivagas ? [{ label: "arbivagas", brasil: true, run: () => sources.arbivagas() }] : []),
    ...(cfg.mindsight ?? []).map((b) => ({ label: `mindsight:${b.slug}`, brasil: true, run: () => sources.mindsight(b) })),
  ];

  // Fontes já consultadas com sucesso. Fonte nova entra em silêncio na primeira vez,
  // para não despejar no Telegram tudo o que já estava aberto.
  const known = new Set(seen._fontes ?? (firstRun ? [] : cfg.empresas.map((b) => `${b.ats}:${b.slug}`)));

  const fresh = [];
  const errors = [];
  // Consulta em grupos de 6 fontes por vez, com uma pausa curta entre os grupos.
  for (let i = 0; i < tasks.length; i += 6) {
    const group = tasks.slice(i, i + 6);
    const results = await Promise.allSettled(group.map((t) => t.run()));
    results.forEach((res, k) => {
      const t = group[k];
      if (res.status === "rejected") return errors.push(`${t.label}: ${res.reason?.message ?? res.reason}`);
      const isNewSource = !firstRun && !known.has(t.label);
      for (const job of res.value) {
        if (!job.url || !job.title || seen[job.id]) continue;
        if (!matches(job, cfg, t.brasil)) continue;
        seen[job.id] = new Date().toISOString();
        if (firstRun || isNewSource) seeded.push(job);
        else fresh.push(job);
      }
      known.add(t.label);
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  if (errors.length) console.warn(`Fontes com erro:\n- ${errors.join("\n- ")}`);

  for (const job of fresh) await sendTelegram(await formatJob(job));

  if (firstRun || seeded.length) {
    const head = firstRun
      ? `✅ Monitor de vagas ativo. ${seeded.length} vaga(s) já abertas batem com o filtro:`
      : `➕ Fonte nova no monitor. ${seeded.length} vaga(s) já abertas batem com o filtro:`;
    await sendList(head, seeded);
    if (firstRun) await sendTelegram("A partir de agora, cada vaga nova chega em uma mensagem separada.");
  }

  // Limpa registros com mais de 90 dias para o arquivo não crescer sem limite.
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(seen)) if (id !== "_fontes" && new Date(ts).getTime() < cutoff) delete seen[id];
  seen._fontes = [...known].sort();

  if (!DRY_RUN) await writeFile(STATE_FILE, JSON.stringify(seen, null, 2) + "\n");
  console.log(`${fresh.length} vaga(s) nova(s), ${seeded.length} já aberta(s) listada(s), ${errors.length} fonte(s) com erro.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
