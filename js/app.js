/* Leitor e editor do Livro de Oração Comum (IEAB 1987).
 * Sem dependências: HTML + CSS + JavaScript puro, pensado para rodar no GitHub Pages.
 * Os textos ficam em data/secoes/*.json (gerados pelo conversor Java).
 * Quem tem token configurado (painel ⚙) pode editar e gravar direto no repositório. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ utilidades

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const API = 'https://api.github.com';
  const TIPOS = { titulo: 'Título', subtitulo: 'Subtítulo', rubrica: 'Rubrica', texto: 'Texto', verso: 'Verso', tabela: 'Tabela' };
  // Atalhos (Ctrl+Shift+tecla) para mudar o tipo do bloco em que está o cursor. Para trocar as teclas, edite aqui.
  // Evitei Ctrl+Alt, que no Windows é o AltGr e atrapalha a digitação (¹ ² ³ £ ¢ no teclado ABNT2).
  const ATALHOS = { Digit1: 'titulo', Digit2: 'subtitulo', Digit3: 'rubrica', Digit4: 'texto', Digit5: 'verso', Digit6: 'tabela' };
  const DICA_ATALHOS = 'Atalhos: Ctrl+Shift+1 título · 2 subtítulo · 3 rubrica · 4 texto · 5 verso · 6 tabela';
  const LIMITES_TABELA = { linhas: [1, 100], colunas: [1, 12] };
  const ROTULO = /^(\p{Lu}[\p{L} .]{0,25}?\s[-–]\s)/u;       // "Oficiante - ", "Povo - ", "Todos - "...

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto != null) e.textContent = texto;
    return e;
  }

  function normalizar(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  function textoParaB64(texto) {
    const bytes = new TextEncoder().encode(texto);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function b64ParaTexto(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder('utf-8').decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  /** Mesmo formato do conversor Java: um bloco por linha, para o diff do Git ficar legível. */
  function serializar(s) {
    const j = JSON.stringify;
    const linhas = s.blocos.map(b => {
      let o = '    {"tipo":' + j(b.tipo) + ',"pagina":' + j(b.pagina);
      if (b.tipo === 'tabela') {
        o += ',"cabecalho":' + j(!!b.cabecalho);
        if (b.bordas !== undefined) o += ',"bordas":' + j(!!b.bordas);   // ausente = visual antigo (só linhas horizontais)
        o += ',"linhas":' + j(b.linhas);
      }
      else o += ',"texto":' + j(b.texto);
      return o + '}';
    });
    return '{\n  "id":' + j(s.id) + ',\n  "titulo":' + j(s.titulo) + ',\n  "modo":' + j(s.modo) +
      ',\n  "paginaInicial":' + j(s.paginaInicial) + ',\n  "paginaFinal":' + j(s.paginaFinal) +
      ',\n  "blocos":[\n' + linhas.join(',\n') + '\n  ]\n}\n';
  }

  // Armazenamento tolerante a navegadores que o bloqueiam (modo privado etc.)
  const guardar = (k, v, sessao = false) => { try { (sessao ? sessionStorage : localStorage).setItem(k, v); } catch { /* ignora */ } };
  const ler = (k, sessao = false) => { try { return (sessao ? sessionStorage : localStorage).getItem(k); } catch { return null; } };
  const apagar = k => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignora */ } };

  // ---------------------------------------------------------------------- estado

  const estado = {
    indice: [], secao: null, sha: null,
    editando: false, sujo: false, timer: null, navegacao: 0, indiceBusca: null,
    novas: new Set(),            // ids de seções criadas aqui e ainda não publicadas
    indiceSha: null,             // sha do indice.json no GitHub (quando lido pela API)
  };

  // ------------------------------------------------------------- configuração admin

  function lerConfig() {
    let cfg = { dono: '', repo: '', ramo: 'main', pasta: 'data', lembrar: false };
    try { cfg = { ...cfg, ...JSON.parse(ler('loc.admin') || '{}') }; } catch { /* usa padrão */ }
    cfg.token = ler('loc.token') || ler('loc.token', true) || '';
    return cfg;
  }

  function gravarConfig(cfg) {
    const { token, ...resto } = cfg;
    guardar('loc.admin', JSON.stringify(resto));
    apagar('loc.token');
    if (token) guardar('loc.token', token, !cfg.lembrar);
  }

  function adminAtivo() {
    const c = lerConfig();
    return !!(c.token && c.dono && c.repo);
  }

  // ------------------------------------------------------------------- API GitHub

  function cabecalhosGH(cfg, extra = {}) {
    return {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  function urlConteudo(cfg, caminho) {
    const cam = caminho.split('/').map(encodeURIComponent).join('/');
    return `${API}/repos/${encodeURIComponent(cfg.dono)}/${encodeURIComponent(cfg.repo)}/contents/${cam}`;
  }

  async function erroHTTP(resp) {
    let detalhe = '';
    try { detalhe = (await resp.json()).message || ''; } catch { /* sem corpo */ }
    const e = new Error(({
      401: 'Token inválido ou expirado.',
      403: 'Sem permissão (o token precisa de “Contents: Read and write”) ou limite de requisições atingido.',
      404: 'Não encontrado: confira usuário, repositório, ramo e pasta — e se o token tem acesso a este repositório.',
      409: 'Conflito: o arquivo mudou no GitHub desde que foi aberto.',
      422: 'O GitHub recusou a gravação (versão do arquivo desatualizada ou dados inválidos).',
    })[resp.status] || `Erro ${resp.status} do GitHub.`);
    if (detalhe) e.message += ' (' + detalhe + ')';
    e.status = resp.status;
    return e;
  }

  async function ghLer(cfg, caminho) {
    const url = urlConteudo(cfg, caminho) + '?ref=' + encodeURIComponent(cfg.ramo);
    const r = await fetch(url, { headers: cabecalhosGH(cfg), cache: 'no-store' });
    if (!r.ok) throw await erroHTTP(r);
    const j = await r.json();
    if (Array.isArray(j)) throw new Error('O caminho aponta para uma pasta.');
    let texto;
    if (j.content && j.encoding === 'base64') {
      texto = b64ParaTexto(j.content);
    } else {            // arquivos acima de 1 MB: pede o conteúdo bruto
      const bruto = await fetch(url, { headers: cabecalhosGH(cfg, { Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
      if (!bruto.ok) throw await erroHTTP(bruto);
      texto = await bruto.text();
    }
    return { texto, sha: j.sha };
  }

  async function ghGravar(cfg, caminho, texto, sha, mensagem) {
    const corpo = { message: mensagem, content: textoParaB64(texto), branch: cfg.ramo };
    if (sha) corpo.sha = sha;
    const r = await fetch(urlConteudo(cfg, caminho), {
      method: 'PUT',
      headers: cabecalhosGH(cfg, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(corpo),
    });
    if (!r.ok) throw await erroHTTP(r);
    return r.json();
  }

  const pastaDados = cfg => cfg.pasta.replace(/^\/+|\/+$/g, '');
  const caminhoSecao = (cfg, id) => `${pastaDados(cfg)}/secoes/${id}.json`;
  const caminhoIndice = cfg => `${pastaDados(cfg)}/indice.json`;

  /** Mesmo formato do indice.json original: uma seção por linha. */
  function serializarIndice(lista) {
    const j = JSON.stringify;
    const linhas = lista.map(it => {
      let o = '  {"id":' + j(it.id) + ',"titulo":' + j(it.titulo);
      if (it.paginaInicial != null) o += ',"paginaInicial":' + j(it.paginaInicial);
      if (it.paginaFinal != null) o += ',"paginaFinal":' + j(it.paginaFinal);
      return o + '}';
    });
    return '[\n' + linhas.join(',\n') + '\n]\n';
  }

  // ---------------------------------------------------------------------- avisos

  let timerAviso = null;
  function aviso(msg, erro = false) {
    const a = $('#aviso');
    a.textContent = msg;
    a.className = 'aviso' + (erro ? ' erro' : '');
    a.hidden = false;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => { a.hidden = true; }, erro ? 7000 : 3800);
  }

  // ----------------------------------------------------------- índice e navegação

  const CHAVE_INDICE = 'loc.indice.rascunho';

  function salvarIndiceRascunho() {
    if (!estado.novas.size) { apagar(CHAVE_INDICE); return; }
    guardar(CHAVE_INDICE, JSON.stringify({ indice: estado.indice, novas: [...estado.novas], shaBase: estado.indiceSha }));
  }

  async function carregarIndice() {
    const nav = $('#indice');
    try {
      let lido = null;
      if (adminAtivo()) {
        try {
          const cfg = lerConfig();
          const r = await ghLer(cfg, caminhoIndice(cfg));
          lido = { dados: JSON.parse(r.texto), sha: r.sha };
        } catch { /* cai para a versão publicada */ }
      }
      if (lido) { estado.indice = lido.dados; estado.indiceSha = lido.sha; }
      else {
        const r = await fetch('data/indice.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        estado.indice = await r.json();
        estado.indiceSha = null;
      }
    } catch (e) {
      nav.replaceChildren(el('p', 'carregando', 'Sem dados.'));
      $('#leitura').replaceChildren(
        el('h1', 'nome-secao', 'Dados ainda não gerados'),
        el('p', null, 'Não encontrei data/indice.json. Rode o conversor Java sobre o PDF (veja o README) e abra o site por um servidor — por exemplo “python3 -m http.server” dentro da pasta docs — ou pelo GitHub Pages. Abrir o arquivo direto (file://) não funciona.'));
      throw e;
    }
    estado.novas = new Set();
    if (adminAtivo()) {                                  // seções novas ainda não publicadas
      try {
        const r = JSON.parse(ler(CHAVE_INDICE) || 'null');
        if (r && Array.isArray(r.indice) && Array.isArray(r.novas)) {
          const publicados = new Set(estado.indice.map(i => i.id));
          const pendentes = r.novas.filter(id => !publicados.has(id) && lerRascunho(id));
          if (pendentes.length) {
            estado.novas = new Set(pendentes);
            estado.indice = r.indice.filter(i => publicados.has(i.id) || estado.novas.has(i.id));
            for (const it of estado.indice) it.nova = estado.novas.has(it.id) || undefined;
            aviso(pendentes.length + ' seção(ões) nova(s) ainda não publicada(s) neste navegador.');
          }
        }
      } catch { /* ignora rascunho corrompido */ }
      salvarIndiceRascunho();
    }
    renderNav();
  }

  function renderNav() {
    const nav = $('#indice');
    nav.replaceChildren();
    if (estado.editando) {
      const b = el('button', 'nova-secao', '＋ Nova seção');
      b.type = 'button';
      b.title = 'Criar uma seção nova no índice, além das que vêm do livro';
      b.addEventListener('click', abrirNovaSecao);
      nav.appendChild(b);
    }
    for (const it of estado.indice) {
      const a = el('a', null, it.titulo);
      a.href = '#/' + it.id;
      a.dataset.id = it.id;
      let nota = '';
      if (estado.novas.has(it.id)) nota = 'nova · não publicada';
      else if (it.paginaInicial != null) nota = it.paginaInicial === it.paginaFinal ? `p. ${it.paginaInicial}` : `pp. ${it.paginaInicial}–${it.paginaFinal}`;
      if (nota) a.appendChild(el('small', null, nota));
      nav.appendChild(a);
    }
    if (estado.secao) marcarNav(estado.secao.id);
  }

  function marcarNav(id) {
    document.querySelectorAll('#indice a').forEach(a => {
      if (a.dataset.id === id) { a.setAttribute('aria-current', 'page'); a.scrollIntoView({ block: 'nearest' }); }
      else a.removeAttribute('aria-current');
    });
  }

  function rotear() {
    const [, id, bloco] = location.hash.split('/');
    $('#resultados').hidden = true;
    $('#leitura').hidden = false;
    document.body.classList.remove('indice-aberto');
    const alvo = estado.indice.find(i => i.id === id) || estado.indice[0];
    if (!alvo) return;
    if (estado.secao && estado.secao.id === alvo.id) { rolarPara(bloco); return; }
    abrirSecao(alvo.id, { bloco });
  }

  function rolarPara(bloco) {
    document.querySelectorAll('.alvo').forEach(e => e.classList.remove('alvo'));
    const alvo = bloco != null && bloco !== '' ? document.querySelector(`[data-i="${bloco}"]`) : null;
    if (alvo) { alvo.scrollIntoView({ block: 'center' }); alvo.classList.add('alvo'); }
    else window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------ carregar a seção

  async function carregarJSON(id) {
    if (estado.novas.has(id)) {
      const r = lerRascunho(id);
      if (!r) throw new Error('Rascunho da seção nova não encontrado neste navegador.');
      return { dados: r.secao, sha: null };
    }
    if (adminAtivo()) {
      try {
        const cfg = lerConfig();
        const r = await ghLer(cfg, caminhoSecao(cfg, id));
        return { dados: JSON.parse(r.texto), sha: r.sha };
      } catch (e) {
        aviso('Não consegui ler pela API do GitHub; mostrando a versão publicada. ' + e.message, true);
      }
    }
    const r = await fetch(`data/secoes/${id}.json`, { cache: 'no-cache' });
    if (!r.ok) throw new Error('Não encontrei a seção ' + id);
    return { dados: await r.json(), sha: null };
  }

  const chaveRascunho = id => 'loc.rascunho.' + id;

  function lerRascunho(id) {
    try {
      const r = JSON.parse(ler(chaveRascunho(id)) || 'null');
      return r && r.secao && r.secao.id === id ? r : null;
    } catch { return null; }
  }

  async function abrirSecao(id, { ignorarRascunho = false, bloco = null } = {}) {
    const minha = ++estado.navegacao;
    marcarNav(id);
    $('#leitura').replaceChildren(el('p', 'carregando', 'Carregando…'));
    try {
      const { dados, sha } = await carregarJSON(id);
      if (minha !== estado.navegacao) return;           // o leitor já foi para outra seção
      estado.secao = dados; estado.sha = sha; estado.sujo = false;
      if (!ignorarRascunho && adminAtivo()) {
        const r = lerRascunho(id);
        if (r) {
          estado.secao = r.secao; estado.sujo = true;
          if (sha && r.shaBase && sha !== r.shaBase) aviso('Rascunho local carregado, mas o arquivo mudou no GitHub depois dele. Confira antes de publicar.', true);
          else aviso('Rascunho local não publicado carregado.');
        }
      }
      document.title = estado.secao.titulo + ' — LOC IEAB 1987';
      renderSecao();
      atualizarBarra();
      rolarPara(bloco);
    } catch (e) {
      if (minha !== estado.navegacao) return;
      $('#leitura').replaceChildren(el('p', 'carregando', 'Erro ao carregar: ' + e.message));
    }
  }

  // ------------------------------------------------------------------ renderização

  const PLAIN = typeof document !== 'undefined' && (() => {
    const d = document.createElement('div');
    d.setAttribute('contenteditable', 'plaintext-only');
    return d.contentEditable === 'plaintext-only';
  })();

  function tornarEditavel(e, bloqueiaEnter = false) {
    e.setAttribute('contenteditable', PLAIN ? 'plaintext-only' : 'true');
    e.spellcheck = true;
    e.lang = 'pt-BR';
    e.addEventListener('paste', ev => {                  // cola sempre como texto puro
      ev.preventDefault();
      const t = (ev.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, t);
    });
    if (bloqueiaEnter) e.addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });
  }

  function lerTexto(e) {
    return e.innerText.replace(/\r/g, '').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
  }

  function preencherComFalas(e, texto) {
    texto.split('\n').forEach((linha, i) => {
      if (i > 0) e.appendChild(document.createTextNode('\n'));
      const m = ROTULO.exec(linha);
      if (m) {
        e.appendChild(el('span', 'fala-rotulo', m[1]));
        e.appendChild(document.createTextNode(linha.slice(m[1].length)));
      } else e.appendChild(document.createTextNode(linha));
    });
  }

  function criarTabela(b) {
    const rolagem = el('div', 'tabela-rolagem');
    const tabela = el('table');
    if (b.bordas === true) tabela.className = 'com-bordas';
    else if (b.bordas === false) tabela.className = 'sem-bordas';
    const corpo = el('tbody');
    b.linhas.forEach((linha, r) => {
      const tr = el('tr');
      linha.forEach((cel, c) => {
        const td = el(b.cabecalho && r === 0 ? 'th' : 'td', null, cel);
        if (estado.editando) {
          tornarEditavel(td);
          td.addEventListener('input', () => { b.linhas[r][c] = lerTexto(td); marcarSujo(); });
        }
        tr.appendChild(td);
      });
      corpo.appendChild(tr);
    });
    tabela.appendChild(corpo);
    rolagem.appendChild(tabela);
    return rolagem;
  }

  function criarElemento(b) {
    if (b.tipo === 'tabela') return criarTabela(b);
    const mapa = { titulo: ['h2', 'bloco'], subtitulo: ['h3', 'bloco'], rubrica: ['p', 'bloco rubrica'], verso: ['p', 'bloco verso'] };
    const [tag, classe] = mapa[b.tipo] || ['p', 'bloco texto'];
    const e = el(tag, classe);
    if (estado.editando) {
      e.textContent = b.texto;
      tornarEditavel(e, b.tipo === 'titulo' || b.tipo === 'subtitulo');
      e.addEventListener('input', () => { b.texto = lerTexto(e); marcarSujo(); });
    } else if (b.tipo === 'texto') preencherComFalas(e, b.texto);
    else e.textContent = b.texto;
    return e;
  }

  function botao(rotulo, titulo, acao) {
    const b = el('button', null, rotulo);
    b.type = 'button';
    b.title = titulo;
    b.addEventListener('click', acao);
    return b;
  }

  function ferramentasBloco(b, i) {
    const f = el('div', 'ferr-bloco');
    f.contentEditable = 'false';
    const blocos = estado.secao.blocos;

    if (b.tipo !== 'tabela') {
      const sel = el('select');
      sel.title = 'Tipo do bloco. ' + DICA_ATALHOS;
      for (const [v, nome] of Object.entries(TIPOS)) {
        const o = el('option', null, nome);
        o.value = v; o.selected = v === b.tipo;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        if (sel.value === 'tabela') abrirTabela(i, () => { sel.value = b.tipo; });   // cancelou: volta ao tipo anterior
        else mudarTipo(i, sel.value);
      });
      f.appendChild(sel);
    } else {
      const colunas = () => Math.max(1, ...b.linhas.map(l => l.length));
      f.appendChild(el('span', 'dimensao', `${b.linhas.length}×${colunas()}`));
      f.lastChild.title = 'linhas × colunas';
      f.appendChild(botao('＋ linha', 'Acrescentar linha à tabela', () => {
        b.linhas.push(new Array(b.linhas[0] ? b.linhas[0].length : 1).fill(''));
        marcarSujo(); renderSecao(i);
      }));
      f.appendChild(botao('− linha', 'Remover a última linha', () => {
        if (b.linhas.length > 1 && confirm('Remover a última linha da tabela?')) { b.linhas.pop(); marcarSujo(); renderSecao(i); }
      }));
      f.appendChild(botao('＋ coluna', 'Acrescentar coluna à direita', () => {
        b.linhas.forEach(l => l.push(''));
        marcarSujo(); renderSecao(i);
      }));
      f.appendChild(botao('− coluna', 'Remover a última coluna', () => {
        const n = colunas();
        if (n > 1 && confirm('Remover a última coluna da tabela?')) {
          b.linhas.forEach(l => { if (l.length >= n) l.pop(); });
          marcarSujo(); renderSecao(i);
        }
      }));
      f.appendChild(botao(b.cabecalho ? '☑ cabeçalho' : '☐ cabeçalho', 'Primeira linha como cabeçalho', () => {
        b.cabecalho = !b.cabecalho; marcarSujo(); renderSecao(i);
      }));
      f.appendChild(botao(b.bordas === false ? '☐ bordas' : '☑ bordas', 'Mostrar ou esconder as bordas da tabela', () => {
        b.bordas = b.bordas === false; marcarSujo(); renderSecao(i);
      }));
    }
    f.appendChild(botao('↑', 'Mover para cima', () => {
      if (i > 0) { [blocos[i - 1], blocos[i]] = [blocos[i], blocos[i - 1]]; marcarSujo(); renderSecao(i - 1); }
    }));
    f.appendChild(botao('↓', 'Mover para baixo', () => {
      if (i < blocos.length - 1) { [blocos[i + 1], blocos[i]] = [blocos[i], blocos[i + 1]]; marcarSujo(); renderSecao(i + 1); }
    }));
    f.appendChild(botao('＋', 'Inserir parágrafo abaixo', () => {
      blocos.splice(i + 1, 0, { tipo: 'texto', pagina: b.pagina, texto: '' }); marcarSujo(); renderSecao(i + 1);
    }));
    f.appendChild(botao('✕', 'Remover este bloco', () => {
      if (confirm('Remover este bloco?')) { blocos.splice(i, 1); marcarSujo(); renderSecao(Math.max(0, i - 1)); }
    }));
    return f;
  }

  const EDITAVEL = '[contenteditable]:not([contenteditable="false"])';

  // ------------------------------------------------- mudar tipo, tabela e atalhos

  /** Troca o tipo de um bloco de texto. `pos` (opcional) devolve o cursor à mesma posição depois de redesenhar. */
  function mudarTipo(i, tipo, pos = null) {
    const b = estado.secao.blocos[i];
    if (!b || b.tipo === 'tabela' || b.tipo === tipo) return;
    b.tipo = tipo;
    marcarSujo();
    renderSecao(i);
    if (pos != null) colocarCursor(i, pos);
  }

  function posicaoDoCursor(envolve) {
    const e = envolve.querySelector(EDITAVEL);
    const sel = window.getSelection();
    if (!e || !sel.rangeCount || !e.contains(sel.anchorNode)) return null;
    const r = document.createRange();
    r.setStart(e, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
  }

  function colocarCursor(i, pos) {
    const e = document.querySelector(`#leitura [data-i="${i}"] ${EDITAVEL}`);
    if (!e) return;
    e.focus();
    const r = document.createRange();
    const no = e.firstChild;
    if (no && no.nodeType === 3) r.setStart(no, Math.min(pos, no.length)); else r.setStart(e, 0);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** Bloco (parágrafo, título, tabela…) onde está o cursor, ou null se o cursor não está em nenhum. */
  function blocoDoCursor() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !estado.secao) return null;
    const no = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const envolve = no && no.closest('#leitura .envolve');
    if (!envolve) return null;
    const i = parseInt(envolve.dataset.i, 10);
    const b = estado.secao.blocos[i];
    return b ? { i, b, envolve } : null;
  }

  let tabelaPendente = null;      // { i, aoCancelar } enquanto o diálogo está aberto

  function abrirTabela(i, aoCancelar = null) {
    let padrao = { linhas: 3, colunas: 2, bordas: true, cabecalho: false };
    try { padrao = { ...padrao, ...JSON.parse(ler('loc.tabela.padrao') || '{}') }; } catch { /* usa padrão */ }
    $('#tab-linhas').value = padrao.linhas;
    $('#tab-colunas').value = padrao.colunas;
    $('#tab-bordas').checked = !!padrao.bordas;
    $('#tab-cabecalho').checked = !!padrao.cabecalho;
    tabelaPendente = { i, aoCancelar };
    $('#dlg-tabela').showModal();
    $('#tab-linhas').select();
  }

  function limitar(valor, [min, max]) {
    const n = parseInt(valor, 10);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  }

  function criarTabelaNova(ev) {
    ev.preventDefault();
    const p = tabelaPendente;
    if (!p) { $('#dlg-tabela').close(); return; }
    const linhas = limitar($('#tab-linhas').value, LIMITES_TABELA.linhas);
    const colunas = limitar($('#tab-colunas').value, LIMITES_TABELA.colunas);
    const bordas = $('#tab-bordas').checked;
    const cabecalho = $('#tab-cabecalho').checked;
    guardar('loc.tabela.padrao', JSON.stringify({ linhas, colunas, bordas, cabecalho }));
    tabelaPendente = null;                                  // confirmou: o “close” não deve contar como cancelamento
    $('#dlg-tabela').close();

    const blocos = estado.secao.blocos;
    const atual = blocos[p.i];
    if (!atual) return;
    const tabela = {
      tipo: 'tabela', pagina: atual.pagina, cabecalho, bordas,
      linhas: Array.from({ length: linhas }, () => new Array(colunas).fill('')),
    };
    const vazio = atual.tipo !== 'tabela' && !(atual.texto || '').trim();
    let alvo;
    if (vazio) { blocos.splice(p.i, 1, tabela); alvo = p.i; }     // bloco vazio: a tabela toma o lugar dele
    else { blocos.splice(p.i + 1, 0, tabela); alvo = p.i + 1; }   // bloco com texto: a tabela entra logo abaixo
    marcarSujo();
    renderSecao(alvo);
  }

  function atalhoDeTipo(ev) {
    if (!estado.editando || !ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
    const tipo = ATALHOS[ev.code];
    if (!tipo || document.querySelector('dialog[open]')) return;
    const alvo = blocoDoCursor();
    if (!alvo) return;
    ev.preventDefault();
    if (tipo === 'tabela') { abrirTabela(alvo.i); return; }
    if (alvo.b.tipo === 'tabela') { aviso('Dentro de uma tabela este atalho não muda o tipo. Clique num parágrafo fora dela.', true); return; }
    mudarTipo(alvo.i, tipo, posicaoDoCursor(alvo.envolve));
  }

  function renderSecao(focoIndice = null) {
    const s = estado.secao;
    const alvo = $('#leitura');
    const rolagem = window.scrollY;
    const h1 = el('h1', 'nome-secao', s.titulo);
    if (estado.editando && estado.novas.has(s.id)) {      // título de seção nova ainda pode mudar
      tornarEditavel(h1, true);
      h1.addEventListener('input', () => {
        s.titulo = lerTexto(h1) || 'Sem título';
        const it = estado.indice.find(i => i.id === s.id);
        if (it) it.titulo = s.titulo;
        marcarSujo(); salvarIndiceRascunho();
      });
      h1.addEventListener('blur', renderNav);
    }
    alvo.replaceChildren(h1);
    let pagina = null;
    s.blocos.forEach((b, i) => {
      if (b.pagina != null && b.pagina !== pagina) { pagina = b.pagina; alvo.appendChild(el('div', 'marca-pagina', 'p. ' + pagina)); }
      const e = criarElemento(b);
      if (estado.editando) {
        const w = el('div', 'envolve');
        w.dataset.i = i;
        w.append(ferramentasBloco(b, i), e);
        alvo.appendChild(w);
      } else {
        e.dataset.i = i;
        alvo.appendChild(e);
      }
    });
    if (focoIndice != null) {
      window.scrollTo({ top: rolagem });
      const foco = alvo.querySelector(`[data-i="${focoIndice}"] ${EDITAVEL}`);
      if (foco) foco.focus({ preventScroll: false });
    }
  }

  // ---------------------------------------------------------------- edição/rascunho

  function marcarSujo() {
    estado.sujo = true;
    atualizarBarra();
    clearTimeout(estado.timer);
    estado.timer = setTimeout(salvarRascunho, 600);
  }

  function salvarRascunho() {
    if (!estado.secao) return;
    guardar(chaveRascunho(estado.secao.id), JSON.stringify({ secao: estado.secao, shaBase: estado.sha, em: Date.now() }));
  }

  function atualizarBarra() {
    const barra = $('#barra-edicao');
    barra.hidden = !estado.editando;
    barra.classList.toggle('sujo', estado.sujo);
    $('#estado-edicao').textContent = estado.sujo
      ? '● Alterações não publicadas (rascunho guardado neste navegador)'
      : 'Modo de edição · sem alterações pendentes';
    $('#estado-edicao').title = DICA_ATALHOS;
  }

  function alternarEdicao() {
    if (!adminAtivo()) { abrirAdmin(); return; }
    estado.editando = !estado.editando;
    document.body.classList.toggle('editando', estado.editando);
    $('#btn-editar').textContent = estado.editando ? '✎ Editando' : '✎ Editar';
    if (estado.secao) renderSecao();
    renderNav();
    atualizarBarra();
  }

  function atualizarModoAdmin() {
    const ativo = adminAtivo();
    $('#btn-editar').hidden = !ativo;
    if (!ativo && estado.editando) alternarEdicao();
  }

  function baixarJSON() {
    const blob = new Blob([serializar(estado.secao)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = estado.secao.id + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function descartarRascunho() {
    if (!estado.secao) return;
    if (estado.novas.has(estado.secao.id)) {
      if (!confirm('Esta seção ainda não foi publicada. Descartar significa APAGÁ-LA. Continuar?')) return;
      const id = estado.secao.id;
      apagar(chaveRascunho(id));
      estado.novas.delete(id);
      estado.indice = estado.indice.filter(i => i.id !== id);
      salvarIndiceRascunho();
      estado.secao = null; estado.sujo = false;
      renderNav();
      location.hash = '#/' + (estado.indice[0] ? estado.indice[0].id : '');
      rotear();
      aviso('Seção nova descartada.');
      return;
    }
    if (!confirm('Descartar as alterações não publicadas desta seção?')) return;
    apagar(chaveRascunho(estado.secao.id));
    abrirSecao(estado.secao.id, { ignorarRascunho: true });
  }

  // ------------------------------------------------------------------ nova seção

  function gerarId(titulo) {
    const slug = normalizar(titulo).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'secao';
    const maior = estado.indice.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0);
    let id = String(maior + 1).padStart(2, '0') + '-' + slug;
    while (estado.indice.some(i => i.id === id)) id += '-x';
    return id;
  }

  function abrirNovaSecao() {
    $('#nova-titulo').value = '';
    const sel = $('#nova-posicao');
    sel.replaceChildren();
    const fim = el('option', null, 'No final do índice');
    fim.value = '__fim__';
    sel.appendChild(fim);
    const ini = el('option', null, 'No começo do índice');
    ini.value = '__ini__';
    sel.appendChild(ini);
    for (const it of estado.indice) {
      const o = el('option', null, 'Depois de: ' + it.titulo);
      o.value = it.id;
      sel.appendChild(o);
    }
    sel.value = estado.secao ? estado.secao.id : '__fim__';
    mensagem($('#nova-msg'), '');
    $('#dlg-nova').showModal();
    $('#nova-titulo').focus();
  }

  function criarNovaSecao(ev) {
    ev.preventDefault();
    const titulo = $('#nova-titulo').value.trim();
    if (!titulo) { mensagem($('#nova-msg'), 'Dê um título à seção.', 'erro'); return; }
    if (estado.indice.some(i => normalizar(i.titulo) === normalizar(titulo))) {
      mensagem($('#nova-msg'), 'Já existe uma seção com esse título.', 'erro'); return;
    }
    clearTimeout(estado.timer);
    if (estado.secao && estado.sujo) salvarRascunho();    // não perde o que estava sendo editado

    const id = gerarId(titulo);
    const secao = { id, titulo, modo: 'prosa', paginaInicial: null, paginaFinal: null,
                    blocos: [{ tipo: 'texto', pagina: null, texto: '' }] };
    const pos = $('#nova-posicao').value;
    const entrada = { id, titulo, nova: true };
    if (pos === '__ini__') estado.indice.unshift(entrada);
    else if (pos === '__fim__') estado.indice.push(entrada);
    else estado.indice.splice(estado.indice.findIndex(i => i.id === pos) + 1, 0, entrada);

    estado.novas.add(id);
    estado.secao = secao; estado.sha = null; estado.sujo = true;
    estado.navegacao++;
    guardar(chaveRascunho(id), JSON.stringify({ secao, shaBase: null, em: Date.now() }));
    salvarIndiceRascunho();
    $('#dlg-nova').close();
    document.title = titulo + ' — LOC IEAB 1987';
    renderNav();
    renderSecao(0);
    atualizarBarra();
    history.replaceState(null, '', '#/' + id);
    window.scrollTo({ top: 0 });
    aviso('Seção criada. Escreva o conteúdo e use “Publicar no GitHub” para colocá-la no ar.');
  }

  // -------------------------------------------------------------------- publicação

  function abrirPublicar() {
    if (!adminAtivo()) { abrirAdmin(); return; }
    if (!estado.sujo) { aviso('Não há alterações para publicar nesta seção.'); return; }
    const cfg = lerConfig();
    const nova = estado.novas.has(estado.secao.id);
    $('#pub-resumo').textContent = nova
      ? `Serão criados ${caminhoSecao(cfg, estado.secao.id)} e atualizado ${caminhoIndice(cfg)} em ${cfg.dono}/${cfg.repo} (ramo ${cfg.ramo}).`
      : `Será gravado ${caminhoSecao(cfg, estado.secao.id)} em ${cfg.dono}/${cfg.repo} (ramo ${cfg.ramo}).`;
    $('#pub-mensagem').value = (nova ? 'Cria seção: ' : 'Edita: ') + estado.secao.titulo;
    mensagem($('#pub-msg'), '');
    $('#dlg-publicar').showModal();
  }

  function mensagem(alvo, texto, tipo = '') {
    alvo.textContent = texto;
    alvo.className = 'msg ' + tipo;
  }

  /** Insere a seção nova no indice.json do GitHub, logo depois da entrada que a precede no rascunho. */
  async function publicarEntradaIndice(cfg, id, mensagemCommit) {
    const caminho = caminhoIndice(cfg);
    const atual = await ghLer(cfg, caminho);
    const remoto = JSON.parse(atual.texto);
    if (!remoto.some(i => i.id === id)) {
      const pos = estado.indice.findIndex(i => i.id === id);
      let apos = -1;                                      // procura a vizinha anterior já publicada
      for (let k = pos - 1; k >= 0 && apos < 0; k--) apos = remoto.findIndex(i => i.id === estado.indice[k].id);
      const { titulo } = estado.indice[pos];
      remoto.splice(apos + 1, 0, { id, titulo });
    }
    const res = await ghGravar(cfg, caminho, serializarIndice(remoto), atual.sha, mensagemCommit);
    estado.indiceSha = res.content.sha;
    estado.novas.delete(id);
    estado.indice.forEach(i => { if (i.id === id) delete i.nova; });   // mantém as outras seções novas pendentes
    estado.indiceBusca = null;
    salvarIndiceRascunho();
    renderNav();
  }

  async function confirmarPublicar(ev) {
    ev.preventDefault();
    const cfg = lerConfig();
    const btn = $('#pub-confirmar');
    const msg = $('#pub-msg');
    btn.disabled = true;
    mensagem(msg, 'Publicando…');
    try {
      const caminho = caminhoSecao(cfg, estado.secao.id);
      let atual = { sha: undefined };
      try { atual = await ghLer(cfg, caminho); } catch (e) { if (e.status !== 404) throw e; }
      if (atual.sha && estado.sha && atual.sha !== estado.sha) {
        throw new Error('O arquivo mudou no GitHub depois que você o abriu. Baixe o .json para guardar suas alterações, recarregue a seção e refaça a edição.');
      }
      const nova = estado.novas.has(estado.secao.id);
      if (nova && atual.sha) throw new Error('Já existe no GitHub um arquivo com o id ' + estado.secao.id + '. Mude o título da seção e tente de novo.');
      const texto = $('#pub-mensagem').value.trim();
      const res = await ghGravar(cfg, caminho, serializar(estado.secao), atual.sha, texto);
      if (nova) await publicarEntradaIndice(cfg, estado.secao.id, texto);
      estado.sha = res.content.sha;
      estado.sujo = false;
      apagar(chaveRascunho(estado.secao.id));
      atualizarBarra();
      mensagem(msg, 'Publicado.', 'ok');
      setTimeout(() => $('#dlg-publicar').close(), 700);
      aviso(`Commit ${res.commit.sha.slice(0, 7)} gravado. O GitHub Pages leva cerca de um minuto para atualizar o site.`);
    } catch (e) {
      mensagem(msg, e.message, 'erro');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------------ admin

  function abrirAdmin() {
    const c = lerConfig();
    $('#adm-dono').value = c.dono;
    $('#adm-repo').value = c.repo;
    $('#adm-ramo').value = c.ramo;
    $('#adm-pasta').value = c.pasta;
    $('#adm-token').value = c.token;
    $('#adm-lembrar').checked = !!c.lembrar;
    mensagem($('#adm-msg'), '');
    $('#dlg-admin').showModal();
  }

  function configDoFormulario() {
    return {
      dono: $('#adm-dono').value.trim(),
      repo: $('#adm-repo').value.trim(),
      ramo: $('#adm-ramo').value.trim() || 'main',
      pasta: $('#adm-pasta').value.trim() || 'data',
      token: $('#adm-token').value.trim(),
      lembrar: $('#adm-lembrar').checked,
    };
  }

  async function testarConexao() {
    const cfg = configDoFormulario();
    const msg = $('#adm-msg');
    if (!cfg.dono || !cfg.repo || !cfg.token) { mensagem(msg, 'Preencha usuário, repositório e token.', 'erro'); return; }
    mensagem(msg, 'Testando…');
    try {
      const r = await fetch(`${API}/repos/${encodeURIComponent(cfg.dono)}/${encodeURIComponent(cfg.repo)}`, { headers: cabecalhosGH(cfg), cache: 'no-store' });
      if (!r.ok) throw await erroHTTP(r);
      const repo = await r.json();
      const escreve = repo.permissions ? !!repo.permissions.push : null;
      await ghLer(cfg, pastaDados(cfg) + '/indice.json');
      mensagem(msg,
        `Conexão OK com ${repo.full_name} (${repo.private ? 'privado' : 'público'}). ` +
        (escreve === false ? 'ATENÇÃO: este token só lê — não conseguirá publicar.' : 'Permissão de escrita confirmada.'),
        escreve === false ? 'erro' : 'ok');
    } catch (e) {
      mensagem(msg, e.message, 'erro');
    }
  }

  function salvarAdmin(ev) {
    ev.preventDefault();
    gravarConfig(configDoFormulario());
    $('#dlg-admin').close();
    atualizarModoAdmin();
    aviso('Configuração salva. Use “✎ Editar” para começar.');
    if (estado.secao && !estado.sujo) abrirSecao(estado.secao.id);   // recarrega pela API, com sha
  }

  function sairAdmin() {
    apagar('loc.token');
    $('#adm-token').value = '';
    $('#dlg-admin').close();
    atualizarModoAdmin();
    aviso('Token apagado deste navegador.');
  }

  // ------------------------------------------------------------------------- busca

  async function prepararBusca() {
    if (estado.indiceBusca) return estado.indiceBusca;
    aviso('Preparando a busca (só na primeira vez)…');
    const porSecao = await Promise.all(estado.indice.map(async it => {
      try {
        const r = await fetch(`data/secoes/${it.id}.json`);
        const d = await r.json();
        return d.blocos.map((b, i) => {
          const texto = b.tipo === 'tabela' ? b.linhas.map(l => l.join(' ')).join(' · ') : b.texto;
          return { id: d.id, secao: d.titulo, i, pagina: b.pagina, texto, norm: normalizar(texto) };
        });
      } catch { return []; }
    }));
    estado.indiceBusca = porSecao.flat();
    return estado.indiceBusca;
  }

  function trecho(texto, pos, tam) {
    const ini = Math.max(0, pos - 60);
    const fim = Math.min(texto.length, pos + tam + 90);
    const p = el('span');
    p.append(
      document.createTextNode((ini > 0 ? '… ' : '') + texto.slice(ini, pos).replace(/\n/g, ' ')),
      el('mark', null, texto.slice(pos, pos + tam)),
      document.createTextNode(texto.slice(pos + tam, fim).replace(/\n/g, ' ') + (fim < texto.length ? ' …' : '')));
    return p;
  }

  async function buscar(ev) {
    ev.preventDefault();
    const q = $('#campo-busca').value.trim();
    if (q.length < 2) return;
    const termos = normalizar(q).split(/\s+/).filter(Boolean);
    const base = await prepararBusca();
    const achados = base.filter(b => termos.every(t => b.norm.includes(t)));
    const painel = $('#resultados');
    painel.replaceChildren();
    const h = el('h2', null, `${achados.length} resultado(s) para “${q}”` + (achados.length > 200 ? ' — mostrando 200' : ''));
    const fechar = el('a', null, ' · fechar busca');
    fechar.href = '#/' + (estado.secao ? estado.secao.id : '');
    h.appendChild(fechar);
    painel.appendChild(h);
    const lista = el('ol');
    for (const a of achados.slice(0, 200)) {
      const pos = a.norm.indexOf(termos[0]);
      const li = el('li');
      const link = el('a');
      link.href = `#/${a.id}/${a.i}`;
      link.append(el('div', 'onde', a.pagina != null ? `${a.secao} · p. ${a.pagina}` : a.secao), trecho(a.texto, Math.max(0, pos), termos[0].length));
      li.appendChild(link);
      lista.appendChild(li);
    }
    painel.appendChild(lista);
    $('#leitura').hidden = true;
    painel.hidden = false;
    window.scrollTo({ top: 0 });
  }

  // -------------------------------------------------------------- aparência (letra/tema)

  function aplicarTamanho(rem) {
    const v = Math.min(1.9, Math.max(0.9, rem));
    document.documentElement.style.setProperty('--tam', v + 'rem');
    guardar('loc.tam', String(v));
    return v;
  }

  function iniciarAparencia() {
    let tam = parseFloat(ler('loc.tam')) || 1.125;
    aplicarTamanho(tam);
    $('#btn-mais').addEventListener('click', () => { tam = aplicarTamanho(tam + 0.1); });
    $('#btn-menos').addEventListener('click', () => { tam = aplicarTamanho(tam - 0.1); });
    const ordem = ['auto', 'claro', 'escuro'];
    document.documentElement.dataset.tema = ordem.includes(ler('loc.tema')) ? ler('loc.tema') : 'auto';
    $('#btn-tema').addEventListener('click', () => {
      const prox = ordem[(ordem.indexOf(document.documentElement.dataset.tema) + 1) % ordem.length];
      document.documentElement.dataset.tema = prox;
      guardar('loc.tema', prox);
      aviso('Tema: ' + prox);
    });
  }

  // ------------------------------------------------------------------------ início

  async function iniciar() {
    iniciarAparencia();
    $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('indice-aberto'));
    $('#conteudo').addEventListener('click', () => document.body.classList.remove('indice-aberto'));
    $('#form-busca').addEventListener('submit', buscar);

    $('#btn-admin').addEventListener('click', abrirAdmin);
    $('#btn-editar').addEventListener('click', alternarEdicao);
    $('#btn-publicar').addEventListener('click', abrirPublicar);
    $('#btn-baixar').addEventListener('click', baixarJSON);
    $('#btn-descartar').addEventListener('click', descartarRascunho);

    $('#form-admin').addEventListener('submit', salvarAdmin);
    $('#adm-testar').addEventListener('click', testarConexao);
    $('#adm-sair').addEventListener('click', sairAdmin);
    $('#adm-cancelar').addEventListener('click', () => $('#dlg-admin').close());
    $('#form-publicar').addEventListener('submit', confirmarPublicar);
    $('#pub-cancelar').addEventListener('click', () => $('#dlg-publicar').close());
    $('#form-nova').addEventListener('submit', criarNovaSecao);
    $('#nova-cancelar').addEventListener('click', () => $('#dlg-nova').close());
    $('#form-tabela').addEventListener('submit', criarTabelaNova);
    $('#tab-cancelar').addEventListener('click', () => $('#dlg-tabela').close());
    $('#dlg-tabela').addEventListener('close', () => {      // Esc, Cancelar ou clique fora
      if (!tabelaPendente) return;
      const cancelar = tabelaPendente.aoCancelar;
      tabelaPendente = null;
      if (cancelar) cancelar();
    });

    document.addEventListener('keydown', atalhoDeTipo);
    document.addEventListener('keydown', ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && estado.editando) {
        ev.preventDefault();
        salvarRascunho();
        aviso('Rascunho guardado neste navegador. Use “Publicar no GitHub” para gravar no repositório.');
      }
    });
    window.addEventListener('beforeunload', ev => {
      if (estado.sujo) { salvarRascunho(); ev.preventDefault(); ev.returnValue = ''; }
    });
    window.addEventListener('hashchange', rotear);

    atualizarModoAdmin();
    try { await carregarIndice(); } catch { return; }
    rotear();
  }

  if (typeof document !== 'undefined') iniciar();
  if (typeof module !== 'undefined') module.exports = { serializar, serializarIndice, textoParaB64, b64ParaTexto, normalizar, ROTULO };
})();
