// Monitor de vagas -> Telegram
// Lê as APIs públicas de vagas (Greenhouse, Lever, Ashby e portal da Gupy),
// filtra por cargo/local e avisa no Telegram só o que for novo.
// Node 20+ (usa fetch nativo). Sem dependências.

import { readFile, writeFile } from "node:fs/promises";

const CONFIG_FILE = new URL("./config.json", import.meta.url);
const STATE_FILE = new URL("./seen.json", import.meta.url);
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN } = process.env;

const norm = (s) =>
  (s ?? "").toString().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
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

// ---------- Telegram ----------

const esc = (s) => (s ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function formatJob(job) {
  const when = job.postedAt
    ? new Date(job.postedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })
    : "horário não informado";
  return [
    `🆕 <b>${esc(job.title)}</b>`,
    `🏢 ${esc(job.company)}`,
    `📍 ${esc(job.location || "local não informado")}`,
    `🕒 Publicada: ${when}`,
    `<a href="${esc(job.url)}">Abrir vaga</a>`,
  ].join("\n");
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
  let seeded = 0;

  const tasks = [
    ...cfg.empresas.map((b) => ({ label: `${b.ats}:${b.slug}`, brasil: !!b.brasil, run: () => sources[b.ats](b) })),
    ...cfg.gupyTermos.map((term) => ({ label: `gupy:"${term}"`, brasil: true, run: () => sources.gupy({ term }) })),
  ];

  // Fontes já consultadas com sucesso. Fonte nova entra em silêncio na primeira vez,
  // para não despejar no Telegram tudo o que já estava aberto.
  const known = new Set(seen._fontes ?? (firstRun ? [] : cfg.empresas.map((b) => `${b.ats}:${b.slug}`)));

  const fresh = [];
  const errors = [];
  for (const t of tasks) {
    try {
      const jobs = await t.run();
      const isNewSource = !firstRun && !known.has(t.label);
      for (const job of jobs) {
        if (!job.url || seen[job.id]) continue;
        if (!matches(job, cfg, t.brasil)) continue;
        seen[job.id] = new Date().toISOString();
        if (isNewSource) seeded++;
        else fresh.push(job);
      }
      known.add(t.label);
    } catch (err) {
      errors.push(`${t.label}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400)); // gentileza com as APIs
  }

  if (errors.length) console.warn(`Fontes com erro:\n- ${errors.join("\n- ")}`);

  if (firstRun) {
    // Não inunda o Telegram com tudo que já estava aberto.
    await sendTelegram(
      `✅ Monitor de vagas ativo. ${fresh.length} vaga(s) já abertas foram registradas; a partir de agora aviso só as novas.` +
        (errors.length ? `\n⚠️ ${errors.length} fonte(s) com erro, confira o log.` : "")
    );
  } else {
    for (const job of fresh) await sendTelegram(formatJob(job));
    if (seeded) await sendTelegram(`➕ Fonte nova no monitor: ${seeded} vaga(s) já abertas foram registradas sem aviso.`);
  }

  // Limpa registros com mais de 90 dias para o arquivo não crescer sem limite.
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(seen)) if (id !== "_fontes" && new Date(ts).getTime() < cutoff) delete seen[id];
  seen._fontes = [...known].sort();

  if (!DRY_RUN) await writeFile(STATE_FILE, JSON.stringify(seen, null, 2) + "\n");
  console.log(`${fresh.length} vaga(s) nova(s), ${errors.length} fonte(s) com erro.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
