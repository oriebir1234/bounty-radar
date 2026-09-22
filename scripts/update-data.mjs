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

    // LOG TEMPORÁRIO DE DEPURAÇÃO — pra entender por que a extração de bounties
    // do First Dollar está falhando. Remover depois de resolvido.
    console.log(
      `  [debug-fd] html.length=${html.length} ` +
      `hasNextData=${html.includes('__NEXT_DATA__')} ` +
      `hasNextF=${html.includes('self.__next_f')} ` +
      `bountyMentions=${(html.match(/bounty/gi) || []).length}`
    );
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

    // Site usa Next.js App Router (RSC streaming), não __NEXT_DATA__. Os dados reais
    // vêm espalhados em várias chamadas self.__next_f.push([id, "pedaço de string"]).
    // Juntamos todos os pedaços (decodificando os escapes JS) e tentamos achar, dentro
    // do texto combinado, um array JSON com objetos de bounty (bracket-matching manual,
    // já que não é um JSON único válido do início ao fim).
    if (!items.length && html.includes('self.__next_f')) {
      const pushMatches = [...html.matchAll(/self\.__next_f\.push\(\[(\d+),("(?:[^"\\]|\\.)*")\]\)/gs)];
      let combined = '';
      for (const m of pushMatches) {
        try {
          combined += JSON.parse(m[2]);
        } catch {
          // ignora pedaço que não decodifica
        }
      }

      console.log(
        `  [debug-fd] pushes=${pushMatches.length} combinedLen=${combined.length} ` +
        `bountyMentionsCombined=${(combined.match(/bounty/gi) || []).length}`
      );

      // Acha candidatos a array JSON de bounties: procura '[' e tenta parsear com
      // bracket-matching; guarda os que parseiam como array de objetos com "title".
      const candidates = [];
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] !== '[') continue;
        // bracket matching simples respeitando strings
        let depth = 0, inStr = false, esc = false, j = i;
        for (; j < combined.length; j++) {
          const c = combined[j];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
          } else {
            if (c === '"') inStr = true;
            else if (c === '[') depth++;
            else if (c === ']') { depth--; if (depth === 0) break; }
          }
          if (j - i > 200000) break; // trava de segurança
        }
        if (depth !== 0) continue;
        const slice = combined.slice(i, j + 1);
        if (slice.length < 40 || slice.length > 150000) continue;
        if (!/"title"/i.test(slice)) continue;
        try {
          const parsed = JSON.parse(slice);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => x && typeof x === 'object' && 'title' in x)) {
            candidates.push(parsed);
          }
        } catch {
          // não é JSON válido isolado (comum em RSC, refs tipo "$5") — ignora
        }
      }

      if (candidates.length) {
        items = candidates.sort((a, b) => b.length - a.length)[0];
        console.log(`  [debug-fd] achou ${candidates.length} array(s) candidato(s) via RSC; usando o maior com ${items.length} item(ns).`);
      } else {
        const bountyIdx = combined.search(/bounty/i);
        if (bountyIdx >= 0) {
          console.log(
            '  [debug-fd] nenhum array JSON isolado encontrado; trecho ao redor da 1a menção de "bounty":',
            JSON.stringify(combined.slice(Math.max(0, bountyIdx - 300), bountyIdx + 1500))
          );
        } else {
          console.log('  [debug-fd] nenhuma menção de "bounty" nos chunks combinados (raro).');
        }
      }
    }

    if (!items.length) {
      console.error('[firstdollar] não foi possível localizar a lista de bounties automaticamente — mantendo os dados anteriores dessa fonte.');
      for (const [id, b] of existing) {
        if (b.source === 'firstdollar') bounties.push({ ...b, lastSeenAt: b.lastSeenAt });
      }
      return bounties;
    }

    // LOG TEMPORÁRIO DE DEPURAÇÃO — pra ver os nomes reais dos campos (reward,
    // empresa, prazo) e corrigir o mapeamento abaixo. Remover depois.
    console.log(
      '  [debug-fd] chaves do 1o item:',
      JSON.stringify(Object.keys(items[0]))
    );
    console.log(
      '  [debug-fd] 1o item completo:',
      JSON.stringify(items[0]).slice(0, 2000)
    );

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

// ---------- Notificação no Telegram (multi-usuário) ----------
// Qualquer pessoa pode se inscrever mandando qualquer mensagem pro bot (o site
// tem um botão/link pra isso). A cada rodada, o script:
//   1. Busca mensagens novas no bot via getUpdates (com offset, pra não reler
//      mensagens antigas) e atualiza a lista de inscritos em subscribers.json.
//      Quem manda "/stop" ou "parar" sai da lista.
//   2. Se aparecer bounty novo elegível, manda a mesma notificação pra todo
//      mundo que está na lista.
// Só precisa do secret TELEGRAM_BOT_TOKEN configurado no repositório
// (Settings → Secrets and variables → Actions). Sem ele, o script só avisa no
// log e segue em frente — nunca quebra a atualização do data.json.

const SUBSCRIBERS_PATH = new URL('../subscribers.json', import.meta.url);

const PT_REGIONS = ['brazil', 'brasil', 'portugal'];

function isEligibleRegion(region) {
  const r = String(region || '').toLowerCase();
  return r === 'global' || PT_REGIONS.includes(r);
}

function isPtExplicitBounty(b) {
  const r = String(b.region || '').toLowerCase();
  return PT_REGIONS.includes(r) || b.language === 'pt_confirmed';
}

async function loadSubscribers() {
  try {
    const raw = await fs.readFile(SUBSCRIBERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      chatIds: Array.isArray(parsed.chatIds) ? parsed.chatIds : [],
      lastUpdateId: typeof parsed.lastUpdateId === 'number' ? parsed.lastUpdateId : 0,
    };
  } catch {
    return { chatIds: [], lastUpdateId: 0 };
  }
}

async function syncTelegramSubscribers(state) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return state;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${state.lastUpdateId + 1}&timeout=0`
    );
    if (!res.ok) {
      console.error('  [telegram] falha ao buscar novos inscritos:', res.status);
      return state;
    }
    const json = await res.json();
    if (!json.ok || !Array.isArray(json.result)) return state;

    const chatIds = new Set(state.chatIds);
    let maxUpdateId = state.lastUpdateId;
    let added = 0;
    let removed = 0;

    for (const update of json.result) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);
      const msg = update.message;
      if (!msg || !msg.chat) continue;
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim().toLowerCase();

      if (text === '/stop' || text === 'parar') {
        if (chatIds.has(chatId)) {
          chatIds.delete(chatId);
          removed++;
        }
      } else if (!chatIds.has(chatId)) {
        chatIds.add(chatId);
        added++;
        // Confirma a inscrição na hora, pra quem acabou de entrar já saber que funcionou.
        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '✅ Inscrito! Você vai receber uma mensagem aqui sempre que aparecer um bounty novo no Bounty Radar. Pra sair, manda "parar" a qualquer momento.',
            }),
          });
        } catch {
          // não crítico — a inscrição já foi salva de qualquer forma
        }
      }
    }

    if (added || removed) {
      console.log(`  [telegram] inscritos: +${added} novo(s), -${removed} removido(s). Total: ${chatIds.size}.`);
    }

    return { chatIds: [...chatIds], lastUpdateId: maxUpdateId };
  } catch (err) {
    console.error('  [telegram] erro ao sincronizar inscritos:', err.message);
    return state;
  }
}

// Envia um texto já pronto pra todo mundo inscrito. Usado tanto pro aviso de
// bounty novo quanto pra lista de bounties abertos que vai logo em seguida.
async function sendTelegramText(text, chatIds, label) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('  [telegram] TELEGRAM_BOT_TOKEN não configurado — pulando envio.');
    return;
  }
  if (!chatIds.length) {
    console.log('  [telegram] nenhum inscrito ainda — pulando envio.');
    return;
  }

  // Telegram limita mensagens a 4096 caracteres.
  const trimmed = text.length > 4000 ? text.slice(0, 3970) + '\n\n(…lista cortada, cabe mais no site)' : text;

  for (const chatId of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: trimmed, disable_web_page_preview: true }),
      });
      if (!res.ok) {
        console.error(`  [telegram] falha ao enviar ${label || 'mensagem'} pra ${chatId}:`, res.status, await res.text());
      }
    } catch (err) {
      console.error(`  [telegram] erro ao enviar ${label || 'mensagem'} pra ${chatId}:`, err.message);
    }
  }
  console.log(`  [telegram] ${label || 'mensagem'} enviada pra ${chatIds.length} inscrito(s).`);
}

function formatBountyLine(b) {
  const ptTag = isPtExplicitBounty(b) ? ' [PT]' : '';
  const reward = b.reward != null ? `${b.reward} ${b.currency || ''}`.trim() : 'valor não informado';
  const d = b.deadline ? new Date(b.deadline) : null;
  const prazo = d && !isNaN(d.getTime())
    ? `expira ${d.toLocaleDateString('pt-BR')}`
    : 'sem prazo informado';
  return `• ${b.title}${ptTag}\n  ${reward} — ${b.sponsor || ''} (${prazo})\n  ${b.url}`;
}

async function sendTelegramNotification(newBounties, chatIds) {
  const shown = newBounties.slice(0, 15);
  const lines = shown.map(formatBountyLine);
  const extra = newBounties.length > shown.length
    ? `\n\n…e mais ${newBounties.length - shown.length} bounty(s) novo(s).`
    : '';
  const text = `🆕 ${newBounties.length} bounty(s) novo(s) no Bounty Radar:\n\n${lines.join('\n\n')}${extra}`;
  await sendTelegramText(text, chatIds, 'aviso de bounty(s) novo(s)');
}

// Lista completa dos bounties abertos e elegíveis, ordenada por prazo (quem
// vence primeiro aparece primeiro; quem não tem prazo informado vai pro final).
async function sendOpenBountiesList(openBounties, chatIds) {
  if (!openBounties.length) return;

  const withDeadline = [];
  const withoutDeadline = [];
  for (const b of openBounties) {
    const d = b.deadline ? new Date(b.deadline) : null;
    if (d && !isNaN(d.getTime())) withDeadline.push({ b, d });
    else withoutDeadline.push(b);
  }
  withDeadline.sort((a, b) => a.d - b.d);
  const ordered = [...withDeadline.map((x) => x.b), ...withoutDeadline];

  const shown = ordered.slice(0, 20);
  const lines = shown.map(formatBountyLine);
  const extra = ordered.length > shown.length
    ? `\n\n…e mais ${ordered.length - shown.length} bounty(s) aberto(s). Lista completa no site.`
    : '';
  const text = `📋 Bounties abertos agora (${ordered.length}), do prazo mais próximo pro mais distante:\n\n${lines.join('\n\n')}${extra}`;
  await sendTelegramText(text, chatIds, 'lista de bounties abertos');
}

async function main() {
  const existing = await loadExisting();

  console.log('Sincronizando inscritos do Telegram...');
  let subscribers = await loadSubscribers();
  subscribers = await syncTelegramSubscribers(subscribers);
  await fs.writeFile(SUBSCRIBERS_PATH, JSON.stringify(subscribers, null, 2) + '\n', 'utf8');

  console.log('Buscando Superteam Earn...');
  const superteam = await fetchSuperteam(existing);
  console.log(`  -> ${superteam.length} listings`);

  console.log('Buscando First Dollar...');
  const firstdollar = await fetchFirstDollar(existing);
  console.log(`  -> ${firstdollar.length} bounties`);

  const freshAll = [...superteam, ...firstdollar];

  // Bounty "novo de verdade" = não existia na rodada anterior (não é só
  // reclassificação de um "Unknown" virando "Global", por exemplo).
  const newEligible = freshAll.filter(
    (b) => !existing.has(b.id) && b.status === 'OPEN' && isEligibleRegion(b.region)
  );

  const freshIds = new Set(freshAll.map((b) => b.id));
  const closed = [];
  for (const [id, b] of existing) {
    if (!freshIds.has(id) && b.status !== 'CLOSED') {
      closed.push({ ...b, status: 'CLOSED', lastSeenAt: b.lastSeenAt });
    }
  }

  const allBounties = [...freshAll, ...closed];

  const payload = {
    bounties: allBounties,
    lastCheckedAt: nowIso(),
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`data.json atualizado: ${allBounties.length} bounties (${closed.length} marcados como CLOSED).`);

  if (newEligible.length) {
    console.log(`Encontrados ${newEligible.length} bounty(s) novo(s) elegível(is) — notificando no Telegram...`);
    await sendTelegramNotification(newEligible, subscribers.chatIds);

    const openEligible = freshAll.filter((b) => b.status === 'OPEN' && isEligibleRegion(b.region));
    console.log(`Enviando lista atualizada de ${openEligible.length} bounty(s) aberto(s), ordenada por prazo...`);
    await sendOpenBountiesList(openEligible, subscribers.chatIds);
  } else {
    console.log('Nenhum bounty novo elegível nessa rodada — sem notificação.');
  }
}

main().catch((err) => {
  console.error('Falha geral no update-data.mjs:', err);
  process.exit(1);
});
