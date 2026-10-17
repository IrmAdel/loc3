/* Leitor e editor do Livro de Oração Comum (IEAB 1987).
 * Sem dependências: HTML + CSS + JavaScript puro, pensado para rodar no GitHub Pages.
 * Os textos ficam em data/secoes/*.json (gerados pelo conversor Java).
 * Quem tem token configurado (painel ⚙) pode editar e gravar direto no repositório. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ utilidades

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const API = 'https://api.github.com';
  const TIPOS = { titulo: 'Título', subtitulo: 'Subtítulo', rubrica: 'Rubrica', texto: 'Texto', verso: 'Verso' };
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
      if (b.tipo === 'tabela') o += ',"cabecalho":' + j(!!b.cabecalho) + ',"linhas":' + j(b.linhas);
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

  async function carregarIndice() {
    const nav = $('#indice');
    try {
      const r = await fetch('data/indice.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      estado.indice = await r.json();
    } catch (e) {
      nav.replaceChildren(el('p', 'carregando', 'Sem dados.'));
      $('#leitura').replaceChildren(
        el('h1', 'nome-secao', 'Dados ainda não gerados'),
        el('p', null, 'Não encontrei data/indice.json. Rode o conversor Java sobre o PDF (veja o README) e abra o site por um servidor — por exemplo “python3 -m http.server” dentro da pasta docs — ou pelo GitHub Pages. Abrir o arquivo direto (file://) não funciona.'));
      throw e;
    }
    nav.replaceChildren();
    for (const it of estado.indice) {
      const a = el('a', null, it.titulo);
      a.href = '#/' + it.id;
      a.dataset.id = it.id;
      a.appendChild(el('small', null, it.paginaInicial === it.paginaFinal ? `p. ${it.paginaInicial}` : `pp. ${it.paginaInicial}–${it.paginaFinal}`));
      nav.appendChild(a);
    }
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
      sel.title = 'Tipo do bloco';
      for (const [v, nome] of Object.entries(TIPOS)) {
        const o = el('option', null, nome);
        o.value = v; o.selected = v === b.tipo;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { b.tipo = sel.value; marcarSujo(); renderSecao(i); });
      f.appendChild(sel);
    } else {
      f.appendChild(botao('＋ linha', 'Acrescentar linha à tabela', () => {
        b.linhas.push(new Array(b.linhas[0] ? b.linhas[0].length : 1).fill(''));
        marcarSujo(); renderSecao(i);
      }));
      f.appendChild(botao('− linha', 'Remover a última linha', () => {
        if (b.linhas.length > 1 && confirm('Remover a última linha da tabela?')) { b.linhas.pop(); marcarSujo(); renderSecao(i); }
      }));
      f.appendChild(botao(b.cabecalho ? '☑ cabeçalho' : '☐ cabeçalho', 'Primeira linha como cabeçalho', () => {
        b.cabecalho = !b.cabecalho; marcarSujo(); renderSecao(i);
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

  function renderSecao(focoIndice = null) {
    const s = estado.secao;
    const alvo = $('#leitura');
    const rolagem = window.scrollY;
    alvo.replaceChildren(el('h1', 'nome-secao', s.titulo));
    let pagina = null;
    s.blocos.forEach((b, i) => {
      if (b.pagina !== pagina) { pagina = b.pagina; alvo.appendChild(el('div', 'marca-pagina', 'p. ' + pagina)); }
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
      const foco = alvo.querySelector(`[data-i="${focoIndice}"] [contenteditable]`);
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
  }

  function alternarEdicao() {
    if (!adminAtivo()) { abrirAdmin(); return; }
    estado.editando = !estado.editando;
    document.body.classList.toggle('editando', estado.editando);
    $('#btn-editar').textContent = estado.editando ? '✎ Editando' : '✎ Editar';
    if (estado.secao) renderSecao();
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
    if (!estado.secao || !confirm('Descartar as alterações não publicadas desta seção?')) return;
    apagar(chaveRascunho(estado.secao.id));
    abrirSecao(estado.secao.id, { ignorarRascunho: true });
  }

  // -------------------------------------------------------------------- publicação

  function abrirPublicar() {
    if (!adminAtivo()) { abrirAdmin(); return; }
    if (!estado.sujo) { aviso('Não há alterações para publicar nesta seção.'); return; }
    const cfg = lerConfig();
    $('#pub-resumo').textContent = `Será gravado ${caminhoSecao(cfg, estado.secao.id)} em ${cfg.dono}/${cfg.repo} (ramo ${cfg.ramo}).`;
    $('#pub-mensagem').value = 'Edita: ' + estado.secao.titulo;
    mensagem($('#pub-msg'), '');
    $('#dlg-publicar').showModal();
  }

  function mensagem(alvo, texto, tipo = '') {
    alvo.textContent = texto;
    alvo.className = 'msg ' + tipo;
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
      const res = await ghGravar(cfg, caminho, serializar(estado.secao), atual.sha, $('#pub-mensagem').value.trim());
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
      link.append(el('div', 'onde', `${a.secao} · p. ${a.pagina}`), trecho(a.texto, Math.max(0, pos), termos[0].length));
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
  if (typeof module !== 'undefined') module.exports = { serializar, textoParaB64, b64ParaTexto, normalizar, ROTULO };
})();
