// avaliar-cv.mjs — Avalia a aderência do CV do Maurício a uma vaga
// Recebe o texto da descrição da vaga e retorna score + gaps + recomendações.
// Pode ser usado standalone ou importado pelo monitor.

import { readFile } from "node:fs/promises";

const PERFIL_FILE = new URL("./perfil.json", import.meta.url);

const norm = (s) =>
  (s ?? "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9áéíóúãõç ]/g, " ");

/**
 * Avalia o CV contra a descrição de uma vaga.
 * @param {string} descricao - Texto completo da vaga (título + descrição + requisitos)
 * @param {string} titulo - Título da vaga
 * @param {string} empresa - Nome da empresa
 * @returns {{ score, max, pct, matches, gaps, alertas, recomendacoes, resumo }}
 */
export async function avaliar(descricao, titulo = "", empresa = "") {
  const perfil = JSON.parse(await readFile(PERFIL_FILE, "utf8"));
  const txt = norm(descricao + " " + titulo);

  const result = {
    titulo,
    empresa,
    score: 0,
    max: 0,
    pct: 0,
    matches: [],
    gaps: [],
    alertas: [],
    recomendacoes: [],
  };

  // 1. Skills core (peso 3 cada — são requisitos)
  const coreFound = [];
  const coreMissing = [];
  for (const skill of perfil.skills_core) {
    const presente = txt.includes(norm(skill));
    if (presente) {
      result.score += 3;
      coreFound.push(skill);
    }
    if (presente) result.max += 3; // só conta no máximo o que a vaga pede
  }
  // Skills que a vaga pede e o perfil não tem → gap
  // (invertido: skills no texto que NÃO estão no perfil)

  // 2. Skills diferenciais (peso 2)
  for (const skill of perfil.skills_diferencial) {
    if (txt.includes(norm(skill))) {
      result.score += 2;
      result.max += 2;
      coreFound.push(`[dif] ${skill}`);
    }
  }

  // 3. Setores (peso 2 — experiência no segmento)
  let setorMatch = false;
  for (const setor of perfil.setores) {
    if (txt.includes(norm(setor))) {
      result.score += 2;
      result.max += 2;
      setorMatch = true;
      coreFound.push(`[setor] ${setor}`);
      break; // conta só 1 vez
    }
  }

  // 4. Ferramentas (peso 1)
  for (const tool of perfil.ferramentas) {
    if (txt.includes(norm(tool))) {
      result.score += 1;
      result.max += 1;
      coreFound.push(`[tool] ${tool}`);
    }
  }

  // 5. Senioridade compatível (peso 5)
  const senOk = perfil.senioridade.some((s) => txt.includes(norm(s)));
  if (senOk) {
    result.score += 5;
    result.max += 5;
    coreFound.push("[senioridade] compatível");
  } else if (/pleno|mid.?level|middle/.test(txt)) {
    result.max += 5;
    result.alertas.push("⚠️ Vaga parece ser para nível pleno — considere se vale se candidatar");
  }

  // 6. Contrato compatível
  const pjOk = /\bpj\b|pessoa jur[ií]dica|cnpj/.test(txt);
  const cltOk = /\bclt\b/.test(txt);
  if (pjOk || cltOk) {
    result.score += 3;
    result.max += 3;
    coreFound.push(`[contrato] ${pjOk ? "PJ" : ""}${pjOk && cltOk ? "/" : ""}${cltOk ? "CLT" : ""}`);
  }

  // 7. Localidade compatível
  const remotoOk = /remot|home.?office|anywhere|h[ií]brido.*bras[ií]lia/.test(txt);
  if (remotoOk) {
    result.score += 3;
    result.max += 3;
    coreFound.push("[local] remoto/compatível");
  }

  // 8. Pontos fracos / alertas (usa word boundary para evitar falsos positivos)
  for (const fraco of perfil.pontos_fracos) {
    for (const palavra of fraco.palavras) {
      const re = new RegExp(`\\b${norm(palavra).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(txt)) {
        result.alertas.push(`🔴 ${fraco.tema}: "${palavra}" — ${fraco.nota}`);
        result.gaps.push(fraco.tema);
        result.score -= 5; // penaliza gaps críticos
        result.max += 5;
        break;
      }
    }
  }

  // 9. Keywords da vaga que NÃO estão no perfil (possíveis gaps)
  const vagaKeywords = extrairKeywords(txt);
  const perfilAll = norm([
    ...perfil.skills_core,
    ...perfil.skills_diferencial,
    ...perfil.setores,
    ...perfil.ferramentas,
  ].join(" "));

  for (const kw of vagaKeywords) {
    if (!perfilAll.includes(norm(kw)) && !coreFound.some((f) => norm(f).includes(norm(kw)))) {
      result.gaps.push(kw);
    }
  }

  // Deduplica gaps
  result.gaps = [...new Set(result.gaps)].slice(0, 8);

  // Score final
  result.max = Math.max(result.max, 1);
  result.pct = Math.round((result.score / result.max) * 100);
  result.matches = coreFound;

  // Recomendações
  if (result.pct >= 80) {
    result.recomendacoes.push("✅ Alta aderência — candidate-se");
  } else if (result.pct >= 60) {
    result.recomendacoes.push("🟡 Aderência média — candidate-se mas prepare respostas para os gaps");
  } else {
    result.recomendacoes.push("🔴 Aderência baixa — avalie se vale o esforço");
  }

  if (result.gaps.length > 0) {
    result.recomendacoes.push(`📝 Gaps: ${result.gaps.join(", ")}`);
    result.recomendacoes.push("Ajuste a carta de apresentação para cobrir os gaps acima");
  }

  if (!setorMatch) {
    result.recomendacoes.push("💡 Setor novo — destaque a transferibilidade da sua experiência na carta");
  }

  // Resumo para Telegram
  const barra = gerarBarra(result.pct);
  result.resumo = [
    `\n📊 <b>Aderência do CV: ${result.pct}%</b> ${barra}`,
    result.pct >= 80 ? "✅ Alta" : result.pct >= 60 ? "🟡 Média" : "🔴 Baixa",
    result.matches.length ? `✓ Match: ${coreFound.slice(0, 6).map(s => s.replace(/\[.*?\] ?/, "")).join(", ")}${coreFound.length > 6 ? ` (+${coreFound.length - 6})` : ""}` : "",
    result.gaps.length ? `✗ Gaps: ${result.gaps.slice(0, 4).join(", ")}${result.gaps.length > 4 ? ` (+${result.gaps.length - 4})` : ""}` : "",
    result.alertas.length ? result.alertas[0] : "",
  ].filter(Boolean).join("\n");

  return result;
}

function gerarBarra(pct) {
  const filled = Math.round(pct / 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function extrairKeywords(txt) {
  // Extrai termos relevantes de vagas de design
  const patterns = [
    /(?:experi[eê]ncia (?:com|em) )([a-záéíóúãõç /]+)/g,
    /(?:conhecimento (?:de|em) )([a-záéíóúãõç /]+)/g,
    /(?:dom[ií]nio (?:de|em) )([a-záéíóúãõç /]+)/g,
    /(?:familiaridade com )([a-záéíóúãõç /]+)/g,
  ];
  const kws = new Set();
  for (const pat of patterns) {
    for (const m of txt.matchAll(pat)) {
      const term = m[1].trim();
      if (term.length > 3 && term.length < 40) kws.add(term);
    }
  }

  // Termos comuns de vagas de design que podem ser gaps
  const designTerms = [
    "product analytics", "amplitude", "mixpanel", "fullstory",
    "lean ux", "jobs to be done", "jtbd", "double diamond",
    "liderança", "mentoria", "squad",
    "b2b", "b2c", "saas", "marketplace", "e-commerce", "edtech", "healthtech",
    "storybook", "handoff", "dev mode",
    "pesquisa quantitativa", "pesquisa qualitativa", "survey",
    "figma make", "framer", "webflow",
    "scrum", "kanban", "agile", "ágil",
    "inglês avançado", "inglês fluente",
    "liderança técnica", "tech lead design",
    "data driven", "data informed",
    "atomic design", "design ops",
  ];
  for (const dt of designTerms) {
    if (txt.includes(norm(dt))) kws.add(dt);
  }

  return [...kws];
}

// ---------- CLI standalone ----------
if (process.argv[1]?.endsWith("avaliar-cv.mjs") && process.argv[2]) {
  const input = await readFile(process.argv[2], "utf8");
  const r = await avaliar(input, process.argv[3] ?? "Vaga", process.argv[4] ?? "Empresa");
  console.log(JSON.stringify(r, null, 2));
}
