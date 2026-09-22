// Atualiza data.json com os bounties abertos do Superteam Earn e First Dollar.
// Roda no GitHub Actions (cron), não depende de nada além de fetch nativo do Node 20+.
//
// Regras importantes (não mude sem entender por quê):
// - "language" só recebe "pt_confirmed" quando a página do bounty disser EXPLICITAMENTE
//   que aceita português / não exige inglês. NUNCA infira isso pela ausência de uma
//   restrição de idioma. Se não houver certeza, o campo "language" fica de fora.
// - "region" só vira "Global" quando a página do listing carregou de verdade e não
//   tem link de restrição regional. Se não der pra confirmar (erro de rede, página
//   não carregou etc.), region fica "Unknown" — o site trata "Unknown" como NÃO
//   elegível (esconde), nunca como Global. Nunca assuma Global por padrão.

import fs from 'node:fs/promises';

const DATA_PATH = new URL('../data.json', import.meta.url);

function nowIso() {
  return new Date().toISOString();
}

async function loadExisting() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const byId = new Map();
    for (const b of parsed.bounties || []) byId.set(b.id ?? `${b.source}_${b.url}`, b);
    return byId;
  } catch {
    return new Map();
  }
}

// ---------- Superteam Earn ----------
// API pública, sem auth: retorna a lista de listings, mas NÃO traz region/skills.
// Para region/skills/idioma, precisamos olhar a página de cada listing novo.

const SUPERTEAM_CATEGORY_MAP = {
  content: 'Content',
  design: 'Design',
  development: 'Dev',
  growth: 'Growth',
  community: 'Growth',
  other: 'Other',
};

function mapSuperteamCategory(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return 'Other';
  const s = skills.map((x) => String(x).toLowerCase());
  if (s.some((x) => x.includes('content'))) return 'Content';
  if (s.some((x) => x.includes('design'))) return 'Design';
  if (s.some((x) => x.includes('frontend') || x.includes('backend') || x.includes('blockchain') || x.includes('dev'))) return 'Dev';
  if (s.some((x) => x.includes('growth'))) return 'Growth';
  return 'Other';
}

async function classifySuperteamListing(slug) {
  // Estratégia: usar links estruturais da página em vez de casar frases soltas
  // (frases quebram fácil quando o nome do país vem dentro de outra tag).
  // - Um link para /earn/regions/<pais> só existe quando o listing é restrito
  //   a uma região específica. Se não existir esse link NUMA PÁGINA QUE
  //   CARREGOU DE VERDADE, o listing é Global.
  // - IMPORTANTE: se não conseguirmos confirmar que a página carregou de fato
  //   (erro de rede, HTML vazio, bloqueio etc.), NUNCA assumimos "Global" por
  //   padrão — isso já causou um bug real (bounty da Superteam Ukraine
  //   aparecendo pra quem não pode participar). Em caso de dúvida, region
  //   fica "Unknown", que o site trata como NÃO elegível (fica escondido) até
  //   uma próxima rodada conseguir classificar direito.
  const out = { region: 'Unknown', category: 'Other' };
  try {
    const res = await fetch(`https://superteam.fun/earn/listing/${slug}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (bounty-radar bot)' },
    });
    if (!res.ok) {
      console.log(`    [debug] ${slug}: HTTP ${res.status}`);
      return out;
    }
    const html = await res.text();

    // Confirma que a página realmente carregou o conteúdo do listing (não uma
    // página de erro/challenge) antes de confiar em qualquer coisa nela.
    const looksLikeRealListingPage = /earn\/skill\//i.test(html) || /SKILLS NEEDED/i.test(html);
    if (!looksLikeRealListingPage) {
      console.error(`  [superteam] página de ${slug} não parece ter carregado o listing de verdade — deixando como Unknown`);
      return out;
    }

    // O link pra página da região restrita (ex: /earn/regions/ukraine) às vezes
    // vem dentro de outro tipo de atributo/estrutura, não sempre em href="...".
    // Por isso procuramos o padrão direto no HTML, sem depender de estar dentro
    // de um href="" literal — isso foi confirmado com logs reais do GitHub
    // Actions: o texto "/earn/regions/<pais>" está lá mesmo quando a regex
    // baseada em href="" não casava.
    const regionMatch = html.match(/\/earn\/regions\/([a-z0-9-]+)/i);
    if (regionMatch) {
      out.region = regionMatch[1]
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    } else {
      out.region = 'Global';
    }

    const skillMatches = [...html.matchAll(/\/earn\/skill\/([a-z0-9-]+)/gi)];
    const skills = [...new Set(skillMatches.map((m) => m[1].toLowerCase()))];
    if (skills.some((s) => s.includes('content'))) out.category = 'Content';
    else if (skills.some((s) => s.includes('design'))) out.category = 'Design';
    else if (skills.some((s) => ['frontend', 'backend', 'blockchain'].includes(s))) out.category = 'Dev';
    else if (skills.some((s) => s.includes('growth'))) out.category = 'Growth';

    // Idioma: só marca pt_confirmed se houver texto explícito nesse sentido
    // (procurado no texto puro, sem tags no meio, pra não perder o match).
    const plain = html.replace(/<[^>]+>/g, ' ');
    if (/portuguese is (ok|accepted|fine)|submissions? in portuguese are (ok|accepted|fine)/i.test(plain)) {
      out.language = 'pt_confirmed';
    } else if (/english is required|submissions? must be in english|only in english/i.test(plain)) {
      out.language = 'english_required';
    }
  } catch (err) {
    console.error(`  [superteam] falha ao classificar ${slug}:`, err.message);
  }
  return out;
}

async function fetchSuperteam(existing) {
  const bounties = [];
  try {
    const res = await fetch('https://superteam.fun/api/listings', {
      headers: { 'user-agent': 'Mozilla/5.0 (bounty-radar bot)' },
    });
    if (!res.ok) {
      console.error('[superteam] HTTP', res.status);
      return bounties;
    }
    const json = await res.json();
    const listings = Array.isArray(json) ? json : json.listings || json.data || [];

    for (const item of listings) {
      const slug = item.slug;
      if (!slug) continue;
      const id = `superteam_${slug}`;
      const status = (item.status || '').toUpperCase() === 'OPEN' || item.isWinnersAnnounced === false ? 'OPEN' : (item.status || 'OPEN').toUpperCase();

      const base = {
        id,
        source: 'superteam',
        title: item.title,
        sponsor: item.sponsor?.name || 'Superteam',
        reward: item.rewardAmount ?? item.usdValue ?? null,
        currency: item.token || 'USD',
        deadline: item.deadline || null,
        url: `https://superteam.fun/earn/listing/${slug}`,
        status,
        firstSeenAt: existing.get(id)?.firstSeenAt || nowIso(),
        lastSeenAt: nowIso(),
      };

      const prev = existing.get(id);
      if (prev && prev.region && prev.region !== 'Unknown') {
        // já classificado antes com sucesso: reaproveita region/category/language
        base.region = prev.region;
        base.category = prev.category;
        if (prev.language) base.language = prev.language;
      } else {
        // listing novo, ou classificação anterior ficou "Unknown" — tenta de novo
        console.log(`  [superteam] classificando listing: ${slug}`);
        const classified = await classifySuperteamListing(slug);
        base.region = classified.region;
        base.category = classified.category !== 'Other' ? classified.category : mapSuperteamCategory(item.skills);
        if (classified.language) base.language = classified.language;
      }

      bounties.push(base);
    }
  } catch (err) {
    console.error('[superteam] erro geral:', err.message);
  }
  return bounties;
}

// ---------- First Dollar ----------
// Sem API pública. A página /bounties é renderizada no servidor (provavelmente Next.js),
// então tentamos achar o JSON embutido em __NEXT_DATA__. Se a estrutura mudar, o script
// não quebra o resto do fluxo — só retorna uma lista vazia pra essa fonte.

async function fetchFirstDollar(existing) {
  const bounties = [];
  try {
    const res = await fetch('https://app.firstdollar.money/bounties', {
      headers: { 'user-agent': 'Mozilla/5.0 (bounty-radar bot)' },
    });
    if (!res.ok) {
      console.error('[firstdollar] HTTP', res.status);
      return bounties;
    }
    const html = await res.text();

    let raw = null;
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        raw = JSON.parse(nextDataMatch[1]);
      } catch (err) {
        console.error('[firstdollar] __NEXT_DATA__ não é JSON válido:', err.message);
      }
    }

    let items = [];
    if (raw) {
      // Procura, em qualquer lugar da árvore, um array de objetos que pareça bounty
      // (tem "title" e algo de reward/company). Isso é uma heurística propositalmente
      // frouxa porque não temos acesso ao HTML real pra confirmar o formato exato.
      const found = [];
      const seen = new Set();
      function walk(node, depth) {
        if (!node || typeof node !== 'object' || depth > 8) return;
        if (seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node)) {
          const looksLikeBounties = node.length > 0 && node.every(
            (x) => x && typeof x === 'object' && ('title' in x || 'name' in x)
          );
          if (looksLikeBounties) found.push(node);
          for (const child of node) walk(child, depth + 1);
        } else {
          for (const key of Object.keys(node)) walk(node[key], depth + 1);
        }
      }
      walk(raw, 0);
      if (found.length) {
        // pega o maior array candidato
        items = found.sort((a, b) => b.length - a.length)[0];
      }
    }

    if (!items.length) {
      console.error('[firstdollar] não foi possível localizar a lista de bounties automaticamente — mantendo os dados anteriores dessa fonte.');
      for (const [id, b] of existing) {
        if (b.source === 'firstdollar') bounties.push({ ...b, lastSeenAt: b.lastSeenAt });
      }
      return bounties;
    }

    for (const item of items) {
      const slug = item.slug || item.id || item.title;
      if (!slug) continue;
      const id = `firstdollar_${String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const prev = existing.get(id);
      bounties.push({
        id,
        source: 'firstdollar',
        title: item.title || item.name,
        sponsor: item.company?.name || item.companyName || item.sponsor || 'First Dollar',
        reward: item.reward ?? item.amount ?? item.rewardAmount ?? null,
        currency: item.currency || 'USD',
        deadline: item.deadline || item.deadlineText || null,
        url: item.url || `https://app.firstdollar.money${item.path || ''}`,
        status: 'OPEN',
        region: prev?.region || 'Global',
        category: prev?.category || item.category || 'Other',
        ...(prev?.language ? { language: prev.language } : {}),
        firstSeenAt: prev?.firstSeenAt || nowIso(),
        lastSeenAt: nowIso(),
      });
    }
  } catch (err) {
    console.error('[firstdollar] erro geral:', err.message);
  }
  return bounties;
}

async function main() {
  const existing = await loadExisting();

  console.log('Buscando Superteam Earn...');
  const superteam = await fetchSuperteam(existing);
  console.log(`  -> ${superteam.length} listings`);

  console.log('Buscando First Dollar...');
  const firstdollar = await fetchFirstDollar(existing);
  console.log(`  -> ${firstdollar.length} bounties`);

  const freshIds = new Set([...superteam, ...firstdollar].map((b) => b.id));
  const closed = [];
  for (const [id, b] of existing) {
    if (!freshIds.has(id) && b.status !== 'CLOSED') {
      closed.push({ ...b, status: 'CLOSED', lastSeenAt: b.lastSeenAt });
    }
  }

  const allBounties = [...superteam, ...firstdollar, ...closed];

  const payload = {
    bounties: allBounties,
    lastCheckedAt: nowIso(),
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`data.json atualizado: ${allBounties.length} bounties (${closed.length} marcados como CLOSED).`);
}

main().catch((err) => {
  console.error('Falha geral no update-data.mjs:', err);
  process.exit(1);
});
