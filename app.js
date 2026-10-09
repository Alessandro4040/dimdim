'use strict';

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbznPvhHLdMUEfl2Vbb3BPDqwKmlQaQZxHISujSjeLgPzbwLPSkLqIlnayyvZh-M_p1e/exec';
const DB_NAME = 'financas_v5';
const DB_VERSION = 1;
const STORES = ['transacoes', 'contas', 'metas', 'categorias'];
const TIPOS = ['despesa', 'receita', 'transferencia'];
const CAT_TRANSFERENCIA = 'cat_transferencia';
const NOVA_CONTA = '__nova_conta__';
const MAX_PARCELAS = 60;
const VALOR_MAXIMO = 999999999.99;
const MAX_SYNC_RETRIES = 3;
const SYNC_DEBOUNCE_MS = 2000;
const SYNC_PERIODICO_MS = 5 * 60 * 1000;
const SYNC_VALIDADE_MS = 2 * 60 * 1000;

const ROTULOS_TIPO = { despesa: 'Despesa', receita: 'Receita', transferencia: 'Transferência' };
const ROTULOS_SITUACAO = {
    despesa: { sim: 'Já foi pago', nao: 'Ainda não foi pago' },
    receita: { sim: 'Já foi recebido', nao: 'Ainda não foi recebido' },
    transferencia: { sim: 'Já foi feita', nao: 'Ainda não foi feita' }
};

// ============================================================
// ESTADO
// ============================================================
const dados = { transacoes: [], contas: [], metas: [], categorias: [] };
const ui = { mes: mesAtualISO(), inicio: '', fim: '', busca: '', categoria: '', status: 'todas' };

let db = null;
let appIniciado = false;
let authToken = lerLocal('authToken');
let temaAtual = lerLocal('tema') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');

let sincEmAndamento = false;
let sincDebounce = null;
let sincRetryTimer = null;
let sincTentativas = 0;
let ultimaSincOk = 0;
let estadoSync = null;

// ============================================================
// UTILITÁRIOS
// ============================================================
function byId(id) {
    return document.getElementById(id);
}

function esc(texto) {
    const mapa = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(texto ?? '').replace(/[&<>"']/g, caractere => mapa[caractere]);
}

function lerLocal(chave) {
    try {
        return localStorage.getItem(chave);
    } catch (erro) {
        return null;
    }
}

function gravarLocal(chave, valor) {
    try {
        if (valor === null) localStorage.removeItem(chave);
        else localStorage.setItem(chave, valor);
    } catch (erro) {
        console.warn('Armazenamento local indisponível:', erro);
    }
}

function uuidv4() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
}

function agora() {
    return new Date().toISOString();
}

function comparar(a, b) {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

// ---------- Dinheiro ----------
const formatadorMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function arredondar(numero) {
    return Math.round((numero + Number.EPSILON) * 100) / 100;
}

function formatarMoeda(valor) {
    let numero = Number(valor) || 0;
    if (Math.abs(numero) < 0.005) numero = 0;
    return formatadorMoeda.format(numero).replace(/\u00a0/g, ' ');
}

// Converte "45,90", "1.234,56", "1234.5" ou números vindos da planilha.
function parseMoedaBR(valor) {
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
    let texto = String(valor ?? '').replace(/[^\d.,-]/g, '');
    if (!texto) return 0;

    const negativo = texto.startsWith('-');
    texto = texto.replace(/-/g, '');
    const ultimaVirgula = texto.lastIndexOf(',');
    const ultimoPonto = texto.lastIndexOf('.');

    if (ultimaVirgula > -1 && ultimoPonto > -1) {
        // O separador que aparece por último é o decimal.
        texto = ultimaVirgula > ultimoPonto
            ? texto.replace(/\./g, '').replace(',', '.')
            : texto.replace(/,/g, '');
    } else if (ultimaVirgula > -1) {
        texto = texto.split(',').length > 2 ? texto.replace(/,/g, '') : texto.replace(',', '.');
    } else if (ultimoPonto > -1) {
        const partes = texto.split('.');
        const separadorDeMilhar = partes.length > 2 || partes[1].length === 3;
        if (separadorDeMilhar) texto = partes.join('');
    }

    const numero = parseFloat(texto);
    if (!Number.isFinite(numero)) return 0;
    return negativo ? -numero : numero;
}

// Lê o que a pessoa digitou. Retorna null quando não dá para entender.
function lerDinheiro(texto, permitirNegativo = false) {
    const limpo = String(texto ?? '').replace(/R\$/gi, '').replace(/\s/g, '');
    const padrao = permitirNegativo ? /^-?\d[\d.,]*$/ : /^\d[\d.,]*$/;
    if (!padrao.test(limpo)) return null;
    return arredondar(parseMoedaBR(limpo));
}

function numeroParaCampo(valor) {
    return (Number(valor) || 0).toFixed(2).replace('.', ',');
}

// Divide em parcelas sem perder centavos: as primeiras recebem o resto.
function dividirEmParcelas(total, quantidade) {
    const centavos = Math.round(total * 100);
    const base = Math.floor(centavos / quantidade);
    const resto = centavos - base * quantidade;
    return Array.from({ length: quantidade }, (_, i) => (base + (i < resto ? 1 : 0)) / 100);
}

// ---------- Datas (sempre no fuso local, nunca via toISOString) ----------
function pad(numero) {
    return String(numero).padStart(2, '0');
}

function dataLocalISO(data) {
    return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())}`;
}

function hojeISO() {
    return dataLocalISO(new Date());
}

function mesAtualISO() {
    return hojeISO().slice(0, 7);
}

function dataValida(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
    const [ano, mes, dia] = iso.split('-').map(Number);
    if (ano < 2000 || ano > 2100) return false;
    const data = new Date(ano, mes - 1, dia);
    return data.getFullYear() === ano && data.getMonth() === mes - 1 && data.getDate() === dia;
}

function somarDias(iso, dias) {
    const [ano, mes, dia] = iso.split('-').map(Number);
    return dataLocalISO(new Date(ano, mes - 1, dia + dias));
}

// Soma meses sem estourar o fim do mês (31/01 + 1 mês = 28/02).
function somarMeses(iso, meses) {
    const [ano, mes, dia] = iso.split('-').map(Number);
    const alvo = new Date(ano, mes - 1 + meses, 1);
    const ultimoDia = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate();
    alvo.setDate(Math.min(dia, ultimoDia));
    return dataLocalISO(alvo);
}

function formatarDataBR(iso) {
    if (!iso) return '';
    const partes = String(iso).split('-');
    return partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : String(iso);
}

function parseDataBR(valor) {
    if (!valor) return '';
    const texto = String(valor);
    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) return texto.slice(0, 10);
    if (texto.includes('/')) {
        const [dia, mes, ano] = texto.split(' ')[0].split('/');
        if (dia && mes && ano) return `${ano}-${pad(mes)}-${pad(dia)}`;
    }
    return valor;
}

function rotuloMes(mes) {
    const [ano, numero] = mes.split('-').map(Number);
    const texto = new Date(ano, numero - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function rotuloDia(iso) {
    const hoje = hojeISO();
    if (iso === hoje) return 'Hoje';
    if (iso === somarDias(hoje, -1)) return 'Ontem';
    if (iso === somarDias(hoje, 1)) return 'Amanhã';
    const [ano, mes, dia] = iso.split('-').map(Number);
    const opcoes = { weekday: 'short', day: 'numeric', month: 'short' };
    if (ano !== new Date().getFullYear()) opcoes.year = 'numeric';
    const texto = new Date(ano, mes - 1, dia).toLocaleDateString('pt-BR', opcoes);
    return texto.charAt(0).toUpperCase() + texto.slice(1);
}

// ---------- Imagens ----------
function fotoSegura(origem) {
    const texto = String(origem || '');
    return /^data:image\//.test(texto) || /^https:\/\//.test(texto) ? texto : '';
}

function reduzirImagem(arquivo, ladoMaximo = 800, qualidade = 0.7) {
    return new Promise((resolve, rejeitar) => {
        if (!arquivo || !String(arquivo.type).startsWith('image/')) {
            rejeitar(new Error('O arquivo escolhido não é uma imagem.'));
            return;
        }
        const leitor = new FileReader();
        leitor.onerror = () => rejeitar(leitor.error || new Error('Não foi possível ler o arquivo.'));
        leitor.onload = () => {
            const imagem = new Image();
            imagem.onerror = () => rejeitar(new Error('Imagem inválida.'));
            imagem.onload = () => {
                const escala = Math.min(1, ladoMaximo / Math.max(imagem.width, imagem.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(imagem.width * escala));
                canvas.height = Math.max(1, Math.round(imagem.height * escala));
                canvas.getContext('2d').drawImage(imagem, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', qualidade));
            };
            imagem.src = leitor.result;
        };
        leitor.readAsDataURL(arquivo);
    });
}

// ============================================================
// TEMA
// ============================================================
function aplicarTema(tema) {
    temaAtual = tema === 'escuro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', temaAtual === 'escuro' ? '#0e1513' : '#0b5566');
    const rotulo = byId('temaRotulo');
    if (rotulo) rotulo.textContent = temaAtual === 'escuro' ? 'Escuro' : 'Claro';
}

function alternarTema() {
    aplicarTema(temaAtual === 'claro' ? 'escuro' : 'claro');
    gravarLocal('tema', temaAtual);
}

// ============================================================
// ARMAZENAMENTO LOCAL (IndexedDB)
// ============================================================
function abrirBanco() {
    return new Promise((resolve, rejeitar) => {
        if (!window.indexedDB) {
            rejeitar(new Error('Este navegador não permite salvar dados no aparelho.'));
            return;
        }
        const pedido = indexedDB.open(DB_NAME, DB_VERSION);
        pedido.onupgradeneeded = () => {
            const banco = pedido.result;
            STORES.forEach(nome => {
                if (!banco.objectStoreNames.contains(nome)) banco.createObjectStore(nome, { keyPath: 'id' });
            });
        };
        pedido.onsuccess = () => resolve(pedido.result);
        pedido.onerror = () => rejeitar(pedido.error);
    });
}

function lerStores(nomes) {
    return new Promise((resolve, rejeitar) => {
        if (!db) {
            rejeitar(new Error('Armazenamento do aparelho indisponível.'));
            return;
        }
        const resultado = {};
        const tx = db.transaction(nomes, 'readonly');
        nomes.forEach(nome => {
            tx.objectStore(nome).getAll().onsuccess = evento => { resultado[nome] = evento.target.result; };
        });
        tx.oncomplete = () => resolve(resultado);
        tx.onerror = () => rejeitar(tx.error);
        tx.onabort = () => rejeitar(tx.error || new Error('Leitura cancelada.'));
    });
}

// Grava e remove em uma única transação: ou tudo é salvo, ou nada.
function aplicarMudancas({ gravar = {}, remover = {} }) {
    return new Promise((resolve, rejeitar) => {
        if (!db) {
            rejeitar(new Error('Armazenamento do aparelho indisponível.'));
            return;
        }
        const nomes = [...new Set([...Object.keys(gravar), ...Object.keys(remover)])];
        if (nomes.length === 0) {
            resolve();
            return;
        }
        let tx;
        try {
            tx = db.transaction(nomes, 'readwrite');
        } catch (erro) {
            rejeitar(erro);
            return;
        }
        nomes.forEach(nome => {
            const store = tx.objectStore(nome);
            (gravar[nome] || []).forEach(item => store.put(item));
            (remover[nome] || []).forEach(id => store.delete(id));
        });
        tx.oncomplete = () => {
            Object.entries(remover).forEach(([nome, ids]) => {
                if (ids.length) registrarExcluidos(nome, ids);
            });
            resolve();
        };
        tx.onerror = () => rejeitar(tx.error);
        tx.onabort = () => rejeitar(tx.error || new Error('Operação cancelada.'));
    });
}

function categoriasPadrao() {
    const criar = (id, nome, tipo, icone) => ({ id, nome, tipo, icone, fixa: true, sinc: true, updated_at: agora() });
    return [
        criar('1', 'Alimentação', 'despesa', '🍔'),
        criar('2', 'Transporte', 'despesa', '🚗'),
        criar('3', 'Lazer', 'despesa', '🎮'),
        criar('4', 'Salário', 'receita', '💰'),
        criar('5', 'Outros', 'outros', '📦'),
        criar(CAT_TRANSFERENCIA, '🔄 Transf. / Fatura', 'outros', '🔄')
    ];
}

async function recarregarDados() {
    const lidos = await lerStores(STORES);
    if (lidos.categorias.length === 0) {
        lidos.categorias = categoriasPadrao();
        await aplicarMudancas({ gravar: { categorias: lidos.categorias } });
    }
    STORES.forEach(nome => { dados[nome] = lidos[nome]; });
    try {
        renderizar();
    } catch (erro) {
        console.error('Falha ao desenhar a tela:', erro);
    }
}

// Caminho único para qualquer alteração: salva, atualiza a tela e agenda o envio.
async function confirmarMudancas(mudancas) {
    await aplicarMudancas(mudancas);
    await recarregarDados();
    agendarSync();
}

// ---------- Itens excluídos (precisam ser avisados ao servidor) ----------
function excluidosVazio() {
    return { transacoes: [], contas: [], metas: [], categorias: [] };
}

function lerExcluidos() {
    try {
        return { ...excluidosVazio(), ...JSON.parse(lerLocal('deletados')) };
    } catch (erro) {
        return excluidosVazio();
    }
}

function gravarExcluidos(excluidos) {
    gravarLocal('deletados', JSON.stringify(excluidos));
}

function registrarExcluidos(store, ids) {
    const excluidos = lerExcluidos();
    excluidos[store] = [...new Set([...(excluidos[store] || []), ...ids])];
    gravarExcluidos(excluidos);
}

function removerExcluidosEnviados(enviados) {
    const atuais = lerExcluidos();
    STORES.forEach(nome => {
        atuais[nome] = (atuais[nome] || []).filter(id => !(enviados[nome] || []).includes(id));
    });
    gravarExcluidos(atuais);
}

// ============================================================
// SESSÃO
// ============================================================
function mostrarApp() {
    byId('telaLogin').hidden = true;
    byId('app').hidden = false;
    iniciarApp();
}

function mostrarLogin() {
    byId('telaLogin').hidden = false;
    byId('app').hidden = true;
}

function mostrarErroLogin(mensagem) {
    const caixa = byId('erroSenha');
    caixa.textContent = mensagem;
    caixa.hidden = !mensagem;
}

async function entrar(evento) {
    evento.preventDefault();
    const senha = byId('senhaEntrada').value;
    mostrarErroLogin('');
    if (!senha) {
        mostrarErroLogin('Digite a senha para entrar.');
        return;
    }
    if (!navigator.onLine) {
        mostrarErroLogin('Sem internet. No primeiro acesso é preciso estar conectado.');
        return;
    }

    const botao = byId('btnEntrar');
    botao.disabled = true;
    botao.textContent = 'Entrando…';
    try {
        const resposta = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(senha)}`);
        const resultado = await resposta.json();
        if (resultado.success) {
            authToken = senha;
            gravarLocal('authToken', authToken);
            byId('senhaEntrada').value = '';
            mostrarApp();
        } else {
            mostrarErroLogin('Senha incorreta. Confira e tente de novo.');
        }
    } catch (erro) {
        mostrarErroLogin('Não foi possível conectar. Verifique a internet e tente de novo.');
    } finally {
        botao.disabled = false;
        botao.textContent = 'Entrar';
    }
}

// O app abre na hora com os dados do aparelho; a senha salva é conferida em segundo plano.
async function validarSessaoEmSegundoPlano() {
    try {
        const resposta = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(authToken)}`);
        const resultado = await resposta.json();
        if (!resultado.success) encerrarSessao();
    } catch (erro) {
        // Sem internet: mantém a sessão e segue usando os dados locais.
    }
}

function encerrarSessao() {
    gravarLocal('authToken', null);
    authToken = null;
    window.location.reload();
}

async function iniciarApp() {
    if (appIniciado) return;
    appIniciado = true;
    renderizar();
    try {
        db = await abrirBanco();
        await recarregarDados();
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível abrir os dados salvos neste aparelho.', 'erro');
        return;
    }
    if (navigator.onLine) agendarSync(true);
    setInterval(() => {
        if (navigator.onLine && contarPendentes() > 0) agendarSync(true);
    }, SYNC_PERIODICO_MS);
}

// ============================================================
// SINCRONIZAÇÃO
// ============================================================
function contarPendentes() {
    return STORES.reduce((total, nome) => total + dados[nome].filter(item => !item.sinc).length, 0);
}

function agendarSync(imediato = false) {
    clearTimeout(sincDebounce);
    sincDebounce = null;
    if (imediato) {
        sincronizar();
        return;
    }
    sincDebounce = setTimeout(() => {
        sincDebounce = null;
        sincronizar();
    }, SYNC_DEBOUNCE_MS);
}

function limparNovaTentativa() {
    clearTimeout(sincRetryTimer);
    sincRetryTimer = null;
}

function agendarNovaTentativa() {
    if (sincTentativas >= MAX_SYNC_RETRIES) return;
    sincTentativas += 1;
    const espera = 10000 * Math.pow(2, sincTentativas - 1);
    limparNovaTentativa();
    sincRetryTimer = setTimeout(() => {
        sincRetryTimer = null;
        sincronizar();
    }, espera);
}

async function lerPendentes() {
    const todos = await lerStores(STORES);
    const pendentes = {};
    STORES.forEach(nome => { pendentes[nome] = todos[nome].filter(item => !item.sinc); });
    return pendentes;
}

function verificarErroDoServidor(resposta) {
    if (!resposta || typeof resposta !== 'object') throw new Error('Resposta inválida do servidor.');
    if (!resposta.error) return;
    if (/Acesso negado|Senha incorreta/i.test(resposta.error)) {
        encerrarSessao();
        throw Object.assign(new Error(resposta.error), { sessaoInvalida: true });
    }
    throw new Error(resposta.error);
}

// Só marca como sincronizado o que não foi editado enquanto o envio acontecia.
function marcarComoSincronizados(enviados) {
    return new Promise((resolve, rejeitar) => {
        const nomes = STORES.filter(nome => enviados[nome].length > 0);
        if (nomes.length === 0) {
            resolve();
            return;
        }
        const tx = db.transaction(nomes, 'readwrite');
        nomes.forEach(nome => {
            const store = tx.objectStore(nome);
            enviados[nome].forEach(item => {
                store.get(item.id).onsuccess = evento => {
                    const atual = evento.target.result;
                    if (atual && atual.updated_at === item.updated_at) store.put({ ...atual, sinc: true });
                };
            });
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => rejeitar(tx.error);
        tx.onabort = () => rejeitar(tx.error || new Error('Operação cancelada.'));
    });
}

async function enviarAoServidor(enviados, excluidos) {
    const resposta = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify({ ...enviados, deletados: excluidos, token: authToken })
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    verificarErroDoServidor(await resposta.json());
    await marcarComoSincronizados(enviados);
    removerExcluidosEnviados(excluidos);
}

function normalizarRemoto(bruto) {
    const item = { ...bruto };
    ['id', 'id_original', 'conta_id', 'categoria_id'].forEach(campo => {
        if (item[campo] !== undefined && item[campo] !== null && item[campo] !== '') item[campo] = String(item[campo]);
    });
    ['valor', 'saldo_inicial', 'limite', 'valor_objetivo', 'valor_atual'].forEach(campo => {
        if (item[campo] !== undefined) item[campo] = parseMoedaBR(item[campo]);
    });
    ['parcela_num', 'parcela_total'].forEach(campo => {
        if (item[campo] !== undefined) item[campo] = Number(item[campo]) || 1;
    });
    if (item.pago !== undefined) {
        item.pago = ['TRUE', 'VERDADEIRO', 'SIM', '1'].includes(String(item.pago).toUpperCase().trim());
    }
    ['data', 'vencimento', 'data_limite'].forEach(campo => {
        if (item[campo] !== undefined) item[campo] = parseDataBR(item[campo]);
    });
    return item;
}

async function puxarDoServidor() {
    const resposta = await fetch(`${API_URL}?action=getAll&token=${encodeURIComponent(authToken)}`);
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    const remoto = await resposta.json();
    verificarErroDoServidor(remoto);

    const locais = await lerStores(STORES);
    const excluidos = lerExcluidos();
    const gravar = {};
    STORES.forEach(nome => {
        const comAlteracaoLocal = new Set(locais[nome].filter(item => !item.sinc).map(item => item.id));
        const removidos = new Set(excluidos[nome] || []);
        const itens = [];
        (remoto[nome] || []).forEach(bruto => {
            const item = normalizarRemoto(bruto);
            // Nunca sobrescreve algo que ainda não foi enviado nem algo que a pessoa excluiu.
            if (!item.id || removidos.has(item.id) || comAlteracaoLocal.has(item.id)) return;
            item.sinc = true;
            itens.push(item);
        });
        if (itens.length) gravar[nome] = itens;
    });
    await aplicarMudancas({ gravar });
}

async function sincronizar() {
    if (sincEmAndamento || !authToken || !db) return;
    if (!navigator.onLine) {
        atualizarStatusSync(null);
        return;
    }

    sincEmAndamento = true;
    atualizarStatusSync('sincronizando');
    let sucesso = false;
    try {
        const enviados = await lerPendentes();
        const excluidos = lerExcluidos();
        const temAlgoParaEnviar = STORES.some(nome => enviados[nome].length > 0 || excluidos[nome].length > 0);
        if (temAlgoParaEnviar) await enviarAoServidor(enviados, excluidos);
        await puxarDoServidor();
        await recarregarDados();
        sincTentativas = 0;
        limparNovaTentativa();
        ultimaSincOk = Date.now();
        sucesso = true;
    } catch (erro) {
        if (!erro.sessaoInvalida) {
            console.error('Falha na sincronização:', erro);
            atualizarStatusSync('erro');
            // TypeError é como o navegador sinaliza falta de rede no fetch.
            if (erro instanceof TypeError) agendarNovaTentativa();
        }
    } finally {
        sincEmAndamento = false;
    }

    if (sucesso) {
        atualizarStatusSync(null);
        // Algo foi salvo enquanto sincronizava: envia na sequência.
        if (contarPendentes() > 0) agendarSync();
    }
}

function atualizarStatusSync(forcado) {
    if (forcado !== undefined) estadoSync = forcado;
    const pendentes = contarPendentes();
    let estado = estadoSync;
    if (!estado) estado = !navigator.onLine ? 'offline' : (pendentes > 0 ? 'pendente' : 'sincronizado');

    const textos = {
        sincronizando: ['🔄 Sincronizando…', 'estado-pend'],
        sincronizado: ['✅ Tudo sincronizado', 'estado-ok'],
        pendente: [`⏳ ${pendentes} item(ns) aguardando envio`, 'estado-pend'],
        offline: ['📴 Sem internet. Os dados estão salvos no aparelho.', 'estado-pend'],
        erro: ['⚠️ Não foi possível sincronizar. Toque para tentar de novo.', 'estado-pend']
    };
    const [texto, classe] = textos[estado];
    const elemento = byId('syncStatus');
    if (elemento) {
        elemento.textContent = texto;
        elemento.className = `menu-item ${classe}`;
    }
    const ponto = byId('pontoSync');
    if (ponto) ponto.hidden = !(pendentes > 0 || estado === 'erro');
}

function sincronizarAgora() {
    if (!navigator.onLine) {
        mostrarToast('Sem internet no momento. Os dados continuam salvos no aparelho.', 'erro');
        return;
    }
    limparNovaTentativa();
    sincTentativas = 0;
    agendarSync(true);
}

// ============================================================
// REGRAS DE NEGÓCIO
// ============================================================
function achar(store, id) {
    return dados[store].find(item => item.id === id);
}

function contaPorId(id) {
    return dados.contas.find(conta => conta.id === id);
}

function categoriaPorId(id) {
    return dados.categorias.find(categoria => categoria.id === id);
}

function contaEhCartao(id) {
    const conta = contaPorId(id);
    return Boolean(conta) && conta.tipo === 'cartao';
}

function nomeConta(id) {
    const conta = contaPorId(id);
    return conta ? conta.nome : 'Conta removida';
}

function nomeCategoria(categoria) {
    if (!categoria) return 'Sem categoria';
    const limpo = String(categoria.nome).replace(/^[^\p{L}\p{N}]+/u, '').trim();
    return limpo || String(categoria.nome);
}

function iconeCategoria(categoria) {
    return (categoria && categoria.icone) || '📦';
}

function rotuloConta(conta) {
    if (!conta) return 'Conta removida';
    return `${conta.tipo === 'cartao' ? '💳' : '🏦'} ${conta.nome}`;
}

function grupoDoLancamento(transacao) {
    if (!transacao.id_original) return [transacao];
    return dados.transacoes.filter(item => item.id_original === transacao.id_original);
}

function ehTransferencia(transacao) {
    if (transacao.categoria_id !== CAT_TRANSFERENCIA) return false;
    const grupo = grupoDoLancamento(transacao);
    return grupo.length === 2 && grupo.some(t => t.tipo === 'despesa') && grupo.some(t => t.tipo === 'receita');
}

function periodoEhPrevisto() {
    if (ui.inicio || ui.fim) return Boolean(ui.inicio) && ui.inicio > hojeISO();
    return ui.mes > mesAtualISO();
}

function periodoDoResumo() {
    const { inicio, fim } = limitesDoPeriodo();
    return { inicio, fim, previsto: periodoEhPrevisto() };
}

// Mês em que a conta começou a ser usada: é nele que o saldo inicial entra.
// Usa o lançamento mais antigo da conta ou, se não houver, o mês em que ela foi criada ou editada.
function mesDeInicioDaConta(conta) {
    const meses = dados.transacoes
        .filter(t => t.conta_id === conta.id && dataValida(t.data))
        .map(t => t.data.slice(0, 7));
    const criacao = String(conta.updated_at || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(criacao)) meses.push(criacao);
    return meses.sort()[0] || mesAtualISO();
}

// Saldo de uma conta corrente só com o que pertence ao período na tela:
// saldo inicial (se a conta começou nele) + entradas - saídas do período.
function saldoDaContaNoPeriodo(conta, periodo) {
    let total = 0;
    const mesInicio = mesDeInicioDaConta(conta);
    if (mesInicio >= periodo.inicio.slice(0, 7) && mesInicio <= periodo.fim.slice(0, 7)) {
        total += Number(conta.saldo_inicial) || 0;
    }
    dados.transacoes.forEach(t => {
        if (t.conta_id !== conta.id || t.data < periodo.inicio || t.data > periodo.fim) return;
        if (!t.pago && !periodo.previsto) return;
        const valor = Number(t.valor) || 0;
        if (t.tipo === 'receita') total += valor;
        else if (t.tipo === 'despesa') total -= valor;
    });
    return arredondar(total);
}

// Quanto foi gasto no cartão dentro do período (compras e parcelas que caem nele).
function gastosDoCartaoNoPeriodo(conta, periodo) {
    let total = 0;
    dados.transacoes.forEach(t => {
        if (t.conta_id !== conta.id || t.tipo !== 'despesa' || t.data < periodo.inicio || t.data > periodo.fim) return;
        total += Number(t.valor) || 0;
    });
    return arredondar(total);
}

// Saldo acumulado de hoje (tudo o que já foi pago). Serve para o limite disponível do cartão.
function saldosDasContas() {
    const saldos = {};
    dados.contas.forEach(conta => {
        saldos[conta.id] = Number(conta.tipo === 'corrente' ? conta.saldo_inicial : conta.limite) || 0;
    });
    dados.transacoes.forEach(t => {
        if (!t.pago || !(t.conta_id in saldos)) return;
        const valor = Number(t.valor) || 0;
        if (t.tipo === 'receita') saldos[t.conta_id] += valor;
        else if (t.tipo === 'despesa') saldos[t.conta_id] -= valor;
    });
    Object.keys(saldos).forEach(id => { saldos[id] = arredondar(saldos[id]); });
    return saldos;
}

function limitesDoPeriodo() {
    if (ui.inicio || ui.fim) {
        return { inicio: ui.inicio || '0000-01-01', fim: ui.fim || '9999-12-31' };
    }
    const [ano, mes] = ui.mes.split('-').map(Number);
    const ultimoDia = new Date(ano, mes, 0).getDate();
    return { inicio: `${ui.mes}-01`, fim: `${ui.mes}-${pad(ultimoDia)}` };
}

function passaNosFiltros(transacao) {
    if (ui.busca && !String(transacao.descricao).toLowerCase().includes(ui.busca)) return false;
    if (ui.categoria && transacao.categoria_id !== ui.categoria) return false;
    return true;
}

function lancamentosDoPeriodo() {
    const { inicio, fim } = limitesDoPeriodo();
    return dados.transacoes.filter(t => t.data >= inicio && t.data <= fim && passaNosFiltros(t));
}

function totaisDoPeriodo() {
    const previsto = periodoEhPrevisto();
    let entradas = 0;
    let saidas = 0;
    lancamentosDoPeriodo().forEach(t => {
        if ((!t.pago && !previsto) || t.categoria_id === CAT_TRANSFERENCIA) return;
        const valor = Number(t.valor) || 0;
        if (t.tipo === 'receita') entradas += valor;
        else if (t.tipo === 'despesa') saidas += valor;
    });
    return { entradas: arredondar(entradas), saidas: arredondar(saidas), previsto };
}

function resumoDoMes(mes) {
    let entradas = 0;
    let saidas = 0;
    dados.transacoes.forEach(t => {
        if (!t.pago || t.categoria_id === CAT_TRANSFERENCIA || t.data < `${mes}-01` || t.data > `${mes}-31`) return;
        const valor = Number(t.valor) || 0;
        if (t.tipo === 'receita') entradas += valor;
        else if (t.tipo === 'despesa') saidas += valor;
    });
    return { entradas: arredondar(entradas), saidas: arredondar(saidas), saldo: arredondar(entradas - saidas) };
}

function filtrosAtivos() {
    return Boolean(ui.inicio || ui.fim || ui.busca || ui.categoria);
}

// ---------- Validação e criação de lançamentos ----------
function validarLancamento(entrada, { edicao = false } = {}) {
    const erros = {};
    if (!TIPOS.includes(entrada.tipo)) erros.tipo = 'Escolha o tipo do lançamento.';

    const descricao = String(entrada.descricao ?? '').trim();
    if (descricao.length < 2) erros.descricao = 'Descreva em poucas palavras (mínimo de 2 letras).';
    else if (descricao.length > 60) erros.descricao = 'Use no máximo 60 caracteres.';

    if (typeof entrada.valor !== 'number' || !(entrada.valor > 0)) {
        erros.valor = 'Informe um valor maior que zero. Exemplo: 45,90';
    } else if (entrada.valor > VALOR_MAXIMO) {
        erros.valor = 'Esse valor é grande demais. Confira se digitou certo.';
    }

    if (!dataValida(entrada.data)) erros.data = 'Escolha uma data válida.';

    if (!contaPorId(entrada.contaId)) {
        erros.conta = entrada.tipo === 'receita'
            ? 'Escolha a conta que recebeu o dinheiro.'
            : (entrada.tipo === 'transferencia' ? 'Escolha a conta de origem.' : 'Escolha a conta ou o cartão usado.');
    }

    if (entrada.tipo === 'transferencia') {
        if (!contaPorId(entrada.contaDestinoId)) erros.contaDestino = 'Escolha a conta de destino.';
        else if (entrada.contaDestinoId === entrada.contaId) erros.contaDestino = 'Origem e destino precisam ser diferentes.';
    } else if (!categoriaPorId(entrada.categoriaId)) {
        erros.categoria = 'Escolha uma categoria.';
    }

    if (!edicao && entrada.tipo !== 'transferencia' && entrada.modo !== 'unica') {
        const quantidade = entrada.quantidade;
        if (!['parcelado', 'mensal'].includes(entrada.modo) || (entrada.modo === 'parcelado' && entrada.tipo !== 'despesa')) {
            erros.repeticao = 'Escolha como o lançamento se repete.';
        } else if (!Number.isInteger(quantidade) || quantidade < 2 || quantidade > MAX_PARCELAS) {
            erros.quantidade = `Informe um número de 2 a ${MAX_PARCELAS}.`;
        }
    }
    return erros;
}

function montarLancamentos(entrada) {
    const descricao = entrada.descricao.trim();
    const momento = agora();
    const idOriginal = uuidv4();
    const base = { id_original: idOriginal, sinc: false, updated_at: momento };

    if (entrada.tipo === 'transferencia') {
        const comum = {
            ...base,
            valor: entrada.valor,
            data: entrada.data,
            descricao,
            categoria_id: CAT_TRANSFERENCIA,
            pago: entrada.pago,
            parcela_num: 1,
            parcela_total: 1,
            foto: entrada.foto || null
        };
        return [
            { ...comum, id: uuidv4(), tipo: 'despesa', conta_id: entrada.contaId },
            { ...comum, id: uuidv4(), tipo: 'receita', conta_id: entrada.contaDestinoId }
        ];
    }

    const quantidade = entrada.modo === 'unica' ? 1 : entrada.quantidade;
    // Parcelado divide o valor total; mensal repete o mesmo valor todo mês.
    const valores = entrada.modo === 'parcelado'
        ? dividirEmParcelas(entrada.valor, quantidade)
        : Array.from({ length: quantidade }, () => entrada.valor);
    return valores.map((valor, i) => ({
        ...base,
        id: uuidv4(),
        tipo: entrada.tipo,
        descricao: quantidade > 1 ? `${descricao} (${i + 1}/${quantidade})` : descricao,
        valor,
        data: somarMeses(entrada.data, i),
        conta_id: entrada.contaId,
        categoria_id: entrada.categoriaId,
        // Só o primeiro lançamento pode nascer pago; os próximos aguardam o mês deles.
        pago: i === 0 ? entrada.pago : false,
        parcela_num: i + 1,
        parcela_total: quantidade,
        foto: i === 0 ? (entrada.foto || null) : null
    }));
}

async function criarLancamentos(entrada) {
    const erros = validarLancamento(entrada);
    if (Object.keys(erros).length > 0) throw Object.assign(new Error('Dados inválidos.'), { erros });
    const itens = montarLancamentos(entrada);
    await confirmarMudancas({ gravar: { transacoes: itens } });
    return itens;
}

async function atualizarLancamento(id, entrada) {
    const erros = validarLancamento(entrada, { edicao: true });
    if (Object.keys(erros).length > 0) throw Object.assign(new Error('Dados inválidos.'), { erros });

    const original = achar('transacoes', id);
    if (!original) throw new Error('Lançamento não encontrado.');

    const comum = {
        descricao: entrada.descricao.trim(),
        valor: entrada.valor,
        data: entrada.data,
        pago: entrada.pago,
        foto: entrada.foto || null,
        sinc: false,
        updated_at: agora()
    };

    let itens;
    if (ehTransferencia(original)) {
        const grupo = grupoDoLancamento(original);
        const saida = grupo.find(t => t.tipo === 'despesa');
        const entradaDoDinheiro = grupo.find(t => t.tipo === 'receita');
        itens = [
            { ...saida, ...comum, conta_id: entrada.contaId },
            { ...entradaDoDinheiro, ...comum, conta_id: entrada.contaDestinoId }
        ];
    } else {
        itens = [{ ...original, ...comum, tipo: entrada.tipo, conta_id: entrada.contaId, categoria_id: entrada.categoriaId }];
    }
    await confirmarMudancas({ gravar: { transacoes: itens } });
}

async function marcarComoPago(id) {
    const transacao = achar('transacoes', id);
    if (!transacao) return;
    const grupo = ehTransferencia(transacao) ? grupoDoLancamento(transacao) : [transacao];
    const momento = agora();
    try {
        await confirmarMudancas({
            gravar: { transacoes: grupo.map(t => ({ ...t, pago: true, sinc: false, updated_at: momento })) }
        });
        mostrarToast(transacao.tipo === 'receita' ? 'Marcado como recebido.' : 'Marcado como pago.');
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível atualizar. Tente de novo.', 'erro');
    }
}

async function excluirTransacao(id) {
    const transacao = achar('transacoes', id);
    if (!transacao) return;
    const grupo = grupoDoLancamento(transacao);
    let ids = [transacao.id];

    if (ehTransferencia(transacao)) {
        const resposta = await perguntar({
            titulo: 'Excluir transferência?',
            mensagem: 'A saída e a entrada serão removidas juntas, para os saldos continuarem certos.',
            botoes: [
                { rotulo: 'Excluir', valor: 'sim', estilo: 'perigo' },
                { rotulo: 'Cancelar', valor: null, estilo: 'sec' }
            ]
        });
        if (resposta !== 'sim') return;
        ids = grupo.map(t => t.id);
    } else if (grupo.length > 1 && (transacao.parcela_total || 1) > 1) {
        const resposta = await perguntar({
            titulo: 'Excluir lançamento repetido?',
            mensagem: `Este lançamento se repete ${grupo.length} vezes (parcelas ou meses). O que você quer excluir?`,
            botoes: [
                { rotulo: 'Só este', valor: 'uma', estilo: 'perigo' },
                { rotulo: 'Todos da sequência', valor: 'todas', estilo: 'perigo' },
                { rotulo: 'Cancelar', valor: null, estilo: 'sec' }
            ]
        });
        if (!resposta) return;
        if (resposta === 'todas') ids = grupo.map(t => t.id);
    } else {
        const resposta = await perguntar({
            titulo: 'Excluir lançamento?',
            mensagem: `"${transacao.descricao}" será removido e os saldos serão recalculados.`,
            botoes: [
                { rotulo: 'Excluir', valor: 'sim', estilo: 'perigo' },
                { rotulo: 'Cancelar', valor: null, estilo: 'sec' }
            ]
        });
        if (resposta !== 'sim') return;
    }

    try {
        await confirmarMudancas({ remover: { transacoes: ids } });
        fecharModal('modalTransacao');
        mostrarToast(ids.length > 1 ? 'Lançamentos excluídos.' : 'Lançamento excluído.');
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível excluir. Tente de novo.', 'erro');
    }
}

async function excluirConta(id) {
    const conta = achar('contas', id);
    if (!conta) return;

    const usos = dados.transacoes.filter(t => t.conta_id === id).length;
    if (usos > 0) {
        await perguntar({
            titulo: 'Não dá para excluir',
            mensagem: `"${conta.nome}" tem ${usos} lançamento(s). Exclua ou edite esses lançamentos antes de remover a conta.`,
            botoes: [{ rotulo: 'Entendi', valor: 'ok', estilo: 'sec' }]
        });
        return;
    }

    const resposta = await perguntar({
        titulo: 'Excluir conta?',
        mensagem: `"${conta.nome}" será removida.`,
        botoes: [
            { rotulo: 'Excluir', valor: 'sim', estilo: 'perigo' },
            { rotulo: 'Cancelar', valor: null, estilo: 'sec' }
        ]
    });
    if (resposta !== 'sim') return;

    const metasVinculadas = dados.metas
        .filter(meta => meta.conta_id === id)
        .map(meta => ({ ...meta, conta_id: '', sinc: false, updated_at: agora() }));
    try {
        await confirmarMudancas({ remover: { contas: [id] }, gravar: { metas: metasVinculadas } });
        fecharModal('modalConta');
        mostrarToast('Conta excluída.');
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível excluir. Tente de novo.', 'erro');
    }
}

async function excluirMeta(id) {
    const meta = achar('metas', id);
    if (!meta) return;
    const resposta = await perguntar({
        titulo: 'Excluir cofrinho?',
        mensagem: `"${meta.nome}" será removido.`,
        botoes: [
            { rotulo: 'Excluir', valor: 'sim', estilo: 'perigo' },
            { rotulo: 'Cancelar', valor: null, estilo: 'sec' }
        ]
    });
    if (resposta !== 'sim') return;
    try {
        await confirmarMudancas({ remover: { metas: [id] } });
        fecharModal('modalMeta');
        mostrarToast('Cofrinho excluído.');
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível excluir. Tente de novo.', 'erro');
    }
}

// ============================================================
// TELA PRINCIPAL
// ============================================================
function renderizar() {
    byId('mesRotulo').textContent = (ui.inicio || ui.fim) ? 'Período escolhido' : rotuloMes(ui.mes);
    renderResumo();
    renderAvisos();
    renderContas();
    renderMetas();
    renderTransacoes();
    renderFiltroCategorias();
    atualizarStatusSync();
}

function estamosNoMesAtual() {
    return !(ui.inicio || ui.fim) && ui.mes === mesAtualISO();
}

function renderResumo() {
    const periodo = periodoDoResumo();
    const montante = arredondar(
        dados.contas.filter(c => c.tipo === 'corrente').reduce((soma, c) => soma + saldoDaContaNoPeriodo(c, periodo), 0)
    );
    const { entradas, saidas, previsto } = totaisDoPeriodo();

    let rotulo = 'Saldo do período';
    if (!(ui.inicio || ui.fim)) {
        const nomeDoMes = rotuloMes(ui.mes).toLowerCase();
        rotulo = previsto ? `Saldo previsto de ${nomeDoMes}` : `Saldo de ${nomeDoMes}`;
    }
    byId('resumoRotulo').textContent = rotulo;
    byId('rotuloEntradas').textContent = previsto ? 'Entradas previstas' : 'Entradas';
    byId('rotuloSaidas').textContent = previsto ? 'Saídas previstas' : 'Saídas';
    byId('resumoNota').textContent = previsto
        ? 'Previsão: inclui também o que está agendado ou pendente neste período.'
        : 'Conta só o que já foi pago ou recebido neste período. Transferências e faturas mudam o saldo, mas não entram em entradas e saídas.';

    // No mês atual, mostra também o dinheiro total de hoje quando ele difere do saldo do mês.
    const saldosHoje = saldosDasContas();
    const totalHoje = arredondar(
        dados.contas.filter(c => c.tipo === 'corrente').reduce((soma, c) => soma + saldosHoje[c.id], 0)
    );
    const linhaHoje = byId('resumoHoje');
    const mostrarHoje = estamosNoMesAtual() && Math.abs(totalHoje - montante) > 0.005;
    linhaHoje.hidden = !mostrarHoje;
    linhaHoje.textContent = mostrarHoje ? `Total nas contas hoje: ${formatarMoeda(totalHoje)}` : '';

    const elementoSaldo = byId('saldoTotal');
    elementoSaldo.textContent = formatarMoeda(montante);
    elementoSaldo.classList.toggle('negativo', montante < 0);
    byId('totalRec').textContent = formatarMoeda(entradas);
    byId('totalDes').textContent = formatarMoeda(saidas);
}

function renderAvisos() {
    const hoje = hojeISO();
    const vencidos = dados.transacoes.filter(t => !t.pago && t.data <= hoje).length;
    const aviso = byId('avisoPendentes');
    aviso.hidden = vencidos === 0;
    if (vencidos > 0) {
        aviso.textContent = `${vencidos} ${vencidos > 1 ? 'lançamentos pendentes ou vencidos' : 'lançamento pendente ou vencido'}. Toque para ver.`;
    }
    byId('faixaFiltros').hidden = !filtrosAtivos();
}

function renderContas() {
    const lista = byId('listaContas');
    if (dados.contas.length === 0) {
        lista.innerHTML = `
            <li class="vazio">
                Você ainda não tem contas. Cadastre sua conta ou cartão para começar a registrar.
                <div><button type="button" class="btn" data-action="nova-conta">Adicionar conta</button></div>
            </li>`;
        return;
    }
    const periodo = periodoDoResumo();
    const saldosHoje = saldosDasContas();
    lista.innerHTML = dados.contas.map(conta => {
        const cartao = conta.tipo === 'cartao';
        const valorDoPeriodo = cartao ? gastosDoCartaoNoPeriodo(conta, periodo) : saldoDaContaNoPeriodo(conta, periodo);
        const venc = cartao && Number(conta.vencimento) ? ` · vence dia ${esc(conta.vencimento)}` : '';
        const limite = cartao && estamosNoMesAtual() ? ` · limite disponível ${formatarMoeda(saldosHoje[conta.id])}` : '';
        return `
            <li>
                <button type="button" class="conta-corpo" data-action="editar-conta" data-id="${esc(conta.id)}">
                    <span class="icone-circulo" aria-hidden="true">${cartao ? '💳' : '🏦'}</span>
                    <span class="texto-bloco">
                        <strong>${esc(conta.nome)}</strong>
                        <small>${cartao ? 'Cartão de crédito' : 'Conta ou carteira'}${venc}${limite}</small>
                    </span>
                    <span class="conta-saldo">
                        <small class="sub">${cartao ? 'Gastos no mês' : 'Saldo do mês'}</small>
                        <strong class="valor ${!cartao && valorDoPeriodo < 0 ? 'neg' : ''}">${formatarMoeda(valorDoPeriodo)}</strong>
                    </span>
                </button>
            </li>`;
    }).join('');
}

function renderMetas() {
    const lista = byId('listaMetas');
    if (dados.metas.length === 0) {
        lista.innerHTML = `
            <li class="vazio">
                Crie um cofrinho para juntar dinheiro para um objetivo, como uma viagem ou uma reserva.
            </li>`;
        return;
    }
    lista.innerHTML = dados.metas.map(meta => {
        const atual = Number(meta.valor_atual) || 0;
        const objetivo = Number(meta.valor_objetivo) || 0;
        const percentual = objetivo > 0 ? Math.min(100, Math.round((atual / objetivo) * 100)) : 0;
        const prazo = meta.data_limite ? `até ${formatarDataBR(meta.data_limite)}` : '';
        return `
            <li>
                <button type="button" class="meta-corpo" data-action="editar-meta" data-id="${esc(meta.id)}">
                    <span class="meta-linha">
                        <strong>${esc(meta.nome)}</strong>
                        <span class="valor">${percentual}%</span>
                    </span>
                    <span class="barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentual}">
                        <span style="width: ${percentual}%"></span>
                    </span>
                    <span class="meta-linha sub">
                        <span>${formatarMoeda(atual)} de ${formatarMoeda(objetivo)}</span>
                        <span>${esc(prazo)}</span>
                    </span>
                </button>
            </li>`;
    }).join('');
}

function htmlLancamento(t) {
    const transferencia = t.categoria_id === CAT_TRANSFERENCIA;
    const categoria = categoriaPorId(t.categoria_id);
    const icone = transferencia ? '🔄' : iconeCategoria(categoria);
    const sinal = t.tipo === 'receita' ? '+' : '-';
    const classe = transferencia ? '' : (t.tipo === 'receita' ? 'pos' : 'neg');
    const detalhe = transferencia
        ? `${t.tipo === 'despesa' ? 'Saiu de' : 'Entrou em'} ${esc(nomeConta(t.conta_id))}`
        : `${esc(nomeCategoria(categoria))} · ${esc(nomeConta(t.conta_id))}`;

    const extras = [];
    if (!t.pago) {
        const situacao = t.data > hojeISO() ? 'Agendado' : 'Pendente';
        extras.push(`<button type="button" class="mini mini-aviso" data-action="marcar-pago" data-id="${esc(t.id)}">${situacao} · marcar como ${t.tipo === 'receita' ? 'recebido' : 'pago'}</button>`);
    }
    if (fotoSegura(t.foto)) {
        extras.push(`<button type="button" class="mini mini-link" data-action="ver-comprovante" data-id="${esc(t.id)}">📎 Ver comprovante</button>`);
    }

    return `
        <li class="lanc">
            <button type="button" class="lanc-corpo" data-action="editar-transacao" data-id="${esc(t.id)}">
                <span class="icone-circulo" aria-hidden="true">${esc(icone)}</span>
                <span class="texto-bloco">
                    <strong>${esc(t.descricao)}</strong>
                    <small>${detalhe}</small>
                </span>
                <span class="valor ${classe}">${sinal} ${formatarMoeda(t.valor)}</span>
            </button>
            ${extras.length ? `<div class="lanc-extras">${extras.join('')}</div>` : ''}
        </li>`;
}

function renderTransacoes() {
    const somentePendentes = ui.status === 'pendentes';
    byId('tituloLancamentos').textContent = somentePendentes ? 'Pendentes' : 'Lançamentos';
    document.querySelectorAll('[data-action="filtro-status"]').forEach(chip => {
        chip.setAttribute('aria-pressed', String(chip.dataset.status === ui.status));
    });

    const base = somentePendentes
        ? dados.transacoes.filter(t => !t.pago && passaNosFiltros(t))
        : lancamentosDoPeriodo();
    const ordenadas = [...base].sort((a, b) => {
        const porData = somentePendentes ? comparar(a.data, b.data) : comparar(b.data, a.data);
        return porData || comparar(String(b.updated_at || ''), String(a.updated_at || ''));
    });

    const container = byId('listaTransacoes');
    if (ordenadas.length === 0) {
        const mensagem = somentePendentes
            ? 'Nenhum lançamento pendente. Tudo em dia!'
            : (filtrosAtivos()
                ? 'Nenhum lançamento encontrado com esses filtros.'
                : (ui.mes > mesAtualISO()
                    ? 'Nada agendado para este mês. Toque em "Novo lançamento" e escolha "Agendar" para planejar receitas e despesas futuras.'
                    : 'Nenhum lançamento neste mês. Toque em "Novo lançamento" para registrar o primeiro.'));
        container.innerHTML = `<div class="vazio">${mensagem}</div>`;
        return;
    }

    const porDia = new Map();
    ordenadas.forEach(t => {
        if (!porDia.has(t.data)) porDia.set(t.data, []);
        porDia.get(t.data).push(t);
    });
    container.innerHTML = [...porDia.entries()].map(([data, itens]) => `
        <div class="dia">
            <h3 class="dia-titulo">${esc(dataValida(data) ? rotuloDia(data) : data)}</h3>
            <ul class="lanc-lista">${itens.map(htmlLancamento).join('')}</ul>
        </div>`).join('');
}

function renderFiltroCategorias() {
    const seletor = byId('filtroCategoria');
    const opcoes = ['<option value="">Todas as categorias</option>'];
    dados.categorias
        .filter(c => c.id !== CAT_TRANSFERENCIA)
        .forEach(c => opcoes.push(`<option value="${esc(c.id)}">${esc(iconeCategoria(c))} ${esc(nomeCategoria(c))}</option>`));
    seletor.innerHTML = opcoes.join('');
    seletor.value = ui.categoria;
}

function sincronizarCamposDeFiltro() {
    byId('filtroInicio').value = ui.inicio;
    byId('filtroFim').value = ui.fim;
    byId('filtroBusca').value = ui.busca;
    byId('filtroCategoria').value = ui.categoria;
}

function mudarMes(delta) {
    const [ano, mes] = ui.mes.split('-').map(Number);
    const data = new Date(ano, mes - 1 + delta, 1);
    ui.mes = `${data.getFullYear()}-${pad(data.getMonth() + 1)}`;
    ui.inicio = '';
    ui.fim = '';
    ui.status = 'todas';
    sincronizarCamposDeFiltro();
    renderizar();
}

function irParaMes(mes) {
    ui.mes = mes;
    ui.inicio = '';
    ui.fim = '';
    ui.status = 'todas';
    sincronizarCamposDeFiltro();
    renderizar();
}

function limparFiltros() {
    ui.inicio = '';
    ui.fim = '';
    ui.busca = '';
    ui.categoria = '';
    sincronizarCamposDeFiltro();
    renderizar();
}

function aoMudarPeriodo() {
    let inicio = byId('filtroInicio').value;
    let fim = byId('filtroFim').value;
    if (inicio && fim && inicio > fim) [inicio, fim] = [fim, inicio];
    ui.inicio = inicio;
    ui.fim = fim;
    ui.status = 'todas';
    sincronizarCamposDeFiltro();
    renderizar();
}

// ============================================================
// JANELAS, AVISOS E CONFIRMAÇÕES
// ============================================================
const pilhaModais = [];
let confirmacaoPendente = null;
let respostasDaConfirmacao = [];
let contextoConta = null;
let timerToast = null;

function abrirModal(id, focoId) {
    if (pilhaModais.some(item => item.id === id)) return;
    pilhaModais.push({ id, foco: document.activeElement });
    const nivel = pilhaModais.length;
    const modal = byId(id);
    modal.style.zIndex = String(1000 + nivel * 10);
    byId('overlay').style.zIndex = String(1000 + nivel * 10 - 5);
    modal.classList.add('aberto');
    byId('overlay').classList.add('aberto');
    document.body.classList.add('travado');
    if (focoId) setTimeout(() => { const alvo = byId(focoId); if (alvo) alvo.focus(); }, 60);
}

function fecharModal(id) {
    const posicao = pilhaModais.findIndex(item => item.id === id);
    if (posicao === -1) return;
    const [{ foco }] = pilhaModais.splice(posicao, 1);
    byId(id).classList.remove('aberto');

    if (id === 'modalConfirmar' && confirmacaoPendente) {
        const resolver = confirmacaoPendente;
        confirmacaoPendente = null;
        resolver(null);
    }
    if (id === 'modalConta') contextoConta = null;

    if (pilhaModais.length === 0) {
        byId('overlay').classList.remove('aberto');
        document.body.classList.remove('travado');
    } else {
        byId('overlay').style.zIndex = String(1000 + pilhaModais.length * 10 - 5);
    }
    if (foco && typeof foco.focus === 'function') foco.focus();
}

function fecharModalDoTopo() {
    const topo = pilhaModais[pilhaModais.length - 1];
    if (!topo) return;
    if (topo.id === 'modalChat' && chat.salvando) return;
    fecharModal(topo.id);
}

// Tocar fora não fecha o assistente no meio do preenchimento, para ninguém perder o que digitou.
function aoClicarFora() {
    const topo = pilhaModais[pilhaModais.length - 1];
    if (!topo) return;
    if (topo.id === 'modalChat' && chat.passo && chat.passo !== 'tipo' && chat.passo !== 'concluido') return;
    fecharModalDoTopo();
}

function perguntar({ titulo, mensagem, botoes }) {
    return new Promise(resolver => {
        if (confirmacaoPendente) confirmacaoPendente(null);
        confirmacaoPendente = resolver;
        respostasDaConfirmacao = botoes.map(botao => botao.valor);
        byId('confTitulo').textContent = titulo;
        byId('confMensagem').textContent = mensagem;
        byId('confBotoes').innerHTML = botoes.map((botao, i) => {
            const classe = botao.estilo === 'perigo' ? 'btn-perigo' : (botao.estilo === 'sec' ? 'btn-sec' : '');
            return `<button type="button" class="btn ${classe}" data-action="resposta-confirmacao" data-indice="${i}">${esc(botao.rotulo)}</button>`;
        }).join('');
        abrirModal('modalConfirmar');
    });
}

function responderConfirmacao(indice) {
    const valor = respostasDaConfirmacao[indice];
    const resolver = confirmacaoPendente;
    confirmacaoPendente = null;
    fecharModal('modalConfirmar');
    if (resolver) resolver(valor === undefined ? null : valor);
}

function mostrarToast(texto, tipo = 'ok') {
    const elemento = byId('toast');
    elemento.textContent = texto;
    elemento.className = `toast visivel${tipo === 'erro' ? ' erro' : ''}`;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => elemento.classList.remove('visivel'), tipo === 'erro' ? 5000 : 3000);
}

function abrirZoom(origem) {
    const segura = fotoSegura(origem);
    if (!segura) return;
    byId('zoomImg').src = segura;
    byId('visualizador').hidden = false;
}

function fecharZoom() {
    byId('visualizador').hidden = true;
    byId('zoomImg').src = '';
}

// ---------- Erros nos campos ----------
function mostrarErros(prefixo, erros) {
    let primeiroCampo = null;
    document.querySelectorAll(`[id^="erro-${prefixo}-"]`).forEach(mensagem => {
        const chave = mensagem.id.slice(`erro-${prefixo}-`.length);
        const campo = byId(`campo-${prefixo}-${chave}`);
        const texto = erros[chave] || '';
        mensagem.textContent = texto;
        mensagem.hidden = !texto;
        if (campo) campo.classList.toggle('erro', Boolean(texto));
        if (texto && campo && !primeiroCampo) primeiroCampo = campo;
    });
    if (primeiroCampo) {
        const controle = primeiroCampo.querySelector('input:not([type="hidden"]), select');
        if (controle) controle.focus();
    }
    const semCampo = Object.keys(erros).filter(chave => !byId(`erro-${prefixo}-${chave}`));
    if (semCampo.length) mostrarToast(erros[semCampo[0]], 'erro');
}

function limparErros(prefixo) {
    mostrarErros(prefixo, {});
}

function marcarOcupado(botaoId, ocupado, textoOcupado) {
    const botao = byId(botaoId);
    if (!botao) return;
    if (ocupado) botao.dataset.textoOriginal = botao.textContent;
    botao.disabled = ocupado;
    botao.textContent = ocupado ? textoOcupado : (botao.dataset.textoOriginal || botao.textContent);
}

function valorDoRadio(nome) {
    const marcado = document.querySelector(`input[name="${nome}"]:checked`);
    return marcado ? marcado.value : '';
}

function definirRadio(nome, valor) {
    const radio = document.querySelector(`input[name="${nome}"][value="${valor}"]`);
    if (radio) radio.checked = true;
}

// ============================================================
// FORMULÁRIO DE LANÇAMENTO (usado para editar e como alternativa ao assistente)
// ============================================================
const formTransacao = { editando: false, foto: null, categoriaOriginal: '' };

const OPCOES_REPETICAO = {
    despesa: [['unica', 'Só uma vez'], ['parcelado', 'Parcelado (divide o valor)'], ['mensal', 'Todo mês (mesmo valor)']],
    receita: [['unica', 'Só uma vez'], ['mensal', 'Todo mês (mesmo valor)']],
    transferencia: []
};

function popularRepeticao(tipo) {
    const seletor = byId('tRepeticao');
    const atual = seletor.value;
    const opcoes = OPCOES_REPETICAO[tipo] || [];
    seletor.innerHTML = opcoes.map(([valor, rotulo]) => `<option value="${valor}">${rotulo}</option>`).join('');
    if (opcoes.some(([valor]) => valor === atual)) seletor.value = atual;
}

function ajustarQuantidade() {
    const tipo = valorDoRadio('tTipo') || 'despesa';
    const modo = byId('tRepeticao').value || 'unica';
    const visivel = !formTransacao.editando && tipo !== 'transferencia' && modo !== 'unica';
    byId('campo-t-quantidade').hidden = !visivel;
    byId('tQuantidadeRotulo').textContent = modo === 'parcelado' ? 'Número de parcelas' : 'Por quantos meses';
}

// Data futura = lançamento agendado: nasce como pendente. Hoje ou passado nasce como já realizado.
function ajustarSituacaoPelaData() {
    if (formTransacao.editando) return;
    byId('tStatus').value = byId('tData').value > hojeISO() ? 'false' : 'true';
}

function popularSelectDeContas(seletor, placeholder, { permitirNova = true } = {}) {
    const opcoes = [`<option value="">${esc(placeholder)}</option>`];
    dados.contas.forEach(conta => {
        opcoes.push(`<option value="${esc(conta.id)}">${esc(rotuloConta(conta))}</option>`);
    });
    if (permitirNova) opcoes.push(`<option value="${NOVA_CONTA}">➕ Nova conta ou cartão…</option>`);
    seletor.innerHTML = opcoes.join('');
}

function popularContasDoFormulario() {
    const origem = byId('tConta');
    const destino = byId('tContaDestino');
    const valorOrigem = origem.value;
    const valorDestino = destino.value;
    popularSelectDeContas(origem, 'Escolha uma conta');
    popularSelectDeContas(destino, 'Escolha uma conta');
    origem.value = valorOrigem;
    destino.value = valorDestino;
}

function popularCategoriasDoFormulario(tipo, selecionada) {
    const compativeis = dados.categorias.filter(c =>
        c.id !== CAT_TRANSFERENCIA && (c.tipo === tipo || c.tipo === 'outros' || !c.tipo)
    );
    if (selecionada && selecionada === formTransacao.categoriaOriginal && !compativeis.some(c => c.id === selecionada)) {
        const original = categoriaPorId(selecionada);
        if (original) compativeis.push(original);
    }
    const seletor = byId('tCategoria');
    seletor.innerHTML = compativeis
        .map(c => `<option value="${esc(c.id)}">${esc(iconeCategoria(c))} ${esc(nomeCategoria(c))}</option>`)
        .join('');
    if (selecionada && compativeis.some(c => c.id === selecionada)) seletor.value = selecionada;
}

function ajustarFormularioPorTipo() {
    const tipo = valorDoRadio('tTipo') || 'despesa';
    byId('campo-t-contaDestino').hidden = tipo !== 'transferencia';
    byId('campo-t-categoria').hidden = tipo === 'transferencia';
    const podeRepetir = !formTransacao.editando && tipo !== 'transferencia';
    byId('campo-t-repeticao').hidden = !podeRepetir;
    if (podeRepetir) popularRepeticao(tipo);
    ajustarQuantidade();
    byId('tContaRotulo').textContent = {
        despesa: 'Paga com (conta ou cartão)',
        receita: 'Entra em qual conta',
        transferencia: 'Sai de qual conta'
    }[tipo];

    const situacao = byId('tStatus');
    situacao.options[0].text = ROTULOS_SITUACAO[tipo].sim;
    situacao.options[1].text = ROTULOS_SITUACAO[tipo].nao;
    popularCategoriasDoFormulario(tipo, byId('tCategoria').value);
}

function renderFotoDoFormulario() {
    const previa = byId('tFotoPrevia');
    const origem = fotoSegura(formTransacao.foto);
    previa.innerHTML = origem
        ? `<img src="${esc(origem)}" alt="Comprovante anexado"><button type="button" class="btn-texto" data-action="form-foto-remover">Remover</button>`
        : '';
}

function abrirFormularioTransacao(id) {
    const transacao = id ? achar('transacoes', id) : null;
    if (id && !transacao) {
        mostrarToast('Lançamento não encontrado.', 'erro');
        return;
    }
    const transferencia = transacao ? ehTransferencia(transacao) : false;

    limparErros('t');
    byId('formTransacao').reset();
    formTransacao.editando = Boolean(transacao);
    formTransacao.foto = transacao ? (transacao.foto || null) : null;
    formTransacao.categoriaOriginal = transacao ? transacao.categoria_id : '';
    byId('tId').value = transacao ? transacao.id : '';

    popularContasDoFormulario();
    const tipo = transacao ? (transferencia ? 'transferencia' : transacao.tipo) : 'despesa';
    definirRadio('tTipo', tipo);
    // Na edição o tipo "transferência" não pode ser trocado, para não quebrar o par de lançamentos.
    document.querySelectorAll('input[name="tTipo"]').forEach(radio => {
        radio.disabled = Boolean(transacao) && (transferencia || radio.value === 'transferencia');
    });
    ajustarFormularioPorTipo();

    if (transacao) {
        byId('tDescricao').value = transacao.descricao;
        byId('tValor').value = numeroParaCampo(transacao.valor);
        byId('tData').value = transacao.data;
        byId('tStatus').value = String(Boolean(transacao.pago));
        if (transferencia) {
            const grupo = grupoDoLancamento(transacao);
            byId('tConta').value = grupo.find(t => t.tipo === 'despesa').conta_id;
            byId('tContaDestino').value = grupo.find(t => t.tipo === 'receita').conta_id;
        } else {
            byId('tConta').value = transacao.conta_id;
            popularCategoriasDoFormulario(tipo, transacao.categoria_id);
        }
    } else {
        byId('tData').value = hojeISO();
        ajustarSituacaoPelaData();
    }

    const info = byId('tInfo');
    const parcelado = transacao && (transacao.parcela_total || 1) > 1;
    info.hidden = !parcelado;
    if (parcelado) info.textContent = `Este é o lançamento ${transacao.parcela_num} de ${transacao.parcela_total} de uma sequência. A alteração vale só para ele.`;

    byId('tTitulo').textContent = transacao ? (transferencia ? 'Editar transferência' : 'Editar lançamento') : 'Novo lançamento';
    byId('btnExcluirTransacao').hidden = !transacao;
    renderFotoDoFormulario();
    abrirModal('modalTransacao', transacao ? null : 'tDescricao');
}

function lerFormularioTransacao() {
    const tipo = valorDoRadio('tTipo') || 'despesa';
    const modo = formTransacao.editando || tipo === 'transferencia' ? 'unica' : (byId('tRepeticao').value || 'unica');
    return {
        tipo,
        descricao: byId('tDescricao').value,
        valor: lerDinheiro(byId('tValor').value),
        data: byId('tData').value,
        contaId: byId('tConta').value,
        contaDestinoId: byId('tContaDestino').value,
        categoriaId: tipo === 'transferencia' ? CAT_TRANSFERENCIA : byId('tCategoria').value,
        modo,
        quantidade: modo === 'unica' ? 1 : Number(byId('tQuantidade').value),
        pago: byId('tStatus').value === 'true',
        foto: formTransacao.foto
    };
}

async function salvarFormularioTransacao(evento) {
    evento.preventDefault();
    if (byId('btnSalvarTransacao').disabled) return;

    const entrada = lerFormularioTransacao();
    const erros = validarLancamento(entrada, { edicao: formTransacao.editando });
    mostrarErros('t', erros);
    if (Object.keys(erros).length > 0) return;

    marcarOcupado('btnSalvarTransacao', true, 'Salvando…');
    try {
        if (formTransacao.editando) await atualizarLancamento(byId('tId').value, entrada);
        else await criarLancamentos(entrada);
        fecharModal('modalTransacao');
        mostrarToast(formTransacao.editando ? 'Alterações salvas.' : 'Lançamento salvo.');
    } catch (erro) {
        console.error(erro);
        if (erro.erros) mostrarErros('t', erro.erros);
        else mostrarToast('Não foi possível salvar. Seus dados continuam na tela, tente de novo.', 'erro');
    } finally {
        marcarOcupado('btnSalvarTransacao', false);
    }
}

async function aoEscolherFotoDoFormulario() {
    const entrada = byId('tFoto');
    const arquivo = entrada.files && entrada.files[0];
    if (!arquivo) return;
    try {
        formTransacao.foto = await reduzirImagem(arquivo);
        renderFotoDoFormulario();
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível usar essa foto. Tente outra imagem.', 'erro');
    } finally {
        entrada.value = '';
    }
}

// ============================================================
// CONTAS E CARTÕES
// ============================================================
function ajustarFormularioConta() {
    const cartao = valorDoRadio('cTipo') === 'cartao';
    byId('cSaldoRotulo').textContent = cartao ? 'Limite disponível' : 'Saldo inicial';
    byId('cSaldoDica').textContent = cartao
        ? 'Quanto você ainda pode gastar no cartão agora.'
        : 'Quanto havia na conta quando você começou a usar o app.';
    byId('campo-c-vencimento').hidden = !cartao;
}

function abrirFormularioConta(id, contexto = null) {
    const conta = id ? achar('contas', id) : null;
    if (id && !conta) {
        mostrarToast('Conta não encontrada.', 'erro');
        return;
    }
    limparErros('c');
    contextoConta = contexto;
    byId('cId').value = conta ? conta.id : '';
    definirRadio('cTipo', conta ? conta.tipo : 'corrente');
    byId('cNome').value = conta ? conta.nome : '';
    byId('cSaldo').value = conta ? numeroParaCampo(conta.tipo === 'cartao' ? conta.limite : conta.saldo_inicial) : '';
    const vencimento = conta ? Number(conta.vencimento) : 0;
    byId('cVencimento').value = Number.isInteger(vencimento) && vencimento > 0 ? String(vencimento) : '';
    byId('cTitulo').textContent = conta ? 'Editar conta ou cartão' : 'Nova conta ou cartão';
    byId('btnExcluirConta').hidden = !conta;
    ajustarFormularioConta();
    abrirModal('modalConta', conta ? null : 'cNome');
}

async function salvarFormularioConta(evento) {
    evento.preventDefault();
    const id = byId('cId').value;
    const tipo = valorDoRadio('cTipo') || 'corrente';
    const nome = byId('cNome').value.trim().replace(/\s+/g, ' ');
    const textoSaldo = byId('cSaldo').value.trim();
    const saldo = textoSaldo === '' ? 0 : lerDinheiro(textoSaldo, tipo === 'corrente');
    const textoVencimento = byId('cVencimento').value.trim();

    const erros = {};
    if (nome.length < 2) erros.nome = 'Dê um nome com pelo menos 2 letras.';
    else if (nome.length > 30) erros.nome = 'Use no máximo 30 caracteres.';
    else if (dados.contas.some(c => c.id !== id && c.nome.trim().toLowerCase() === nome.toLowerCase())) {
        erros.nome = 'Já existe uma conta com esse nome.';
    }
    if (saldo === null) erros.saldo = 'Digite um valor válido. Exemplo: 1500,00';

    let vencimento = null;
    if (tipo === 'cartao' && textoVencimento !== '') {
        const dia = Number(textoVencimento);
        if (!Number.isInteger(dia) || dia < 1 || dia > 31) erros.vencimento = 'Use um dia entre 1 e 31.';
        else vencimento = String(dia);
    }
    mostrarErros('c', erros);
    if (Object.keys(erros).length > 0) return;

    const existente = id ? achar('contas', id) : null;
    const conta = {
        ...(existente || {}),
        id: id || uuidv4(),
        nome,
        tipo,
        saldo_inicial: saldo,
        limite: saldo,
        vencimento,
        sinc: false,
        updated_at: agora()
    };
    try {
        await confirmarMudancas({ gravar: { contas: [conta] } });
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível salvar a conta. Tente de novo.', 'erro');
        return;
    }

    const contexto = contextoConta;
    fecharModal('modalConta');
    mostrarToast(id ? 'Conta atualizada.' : 'Conta criada.');
    if (contexto && !id) aplicarContaCriada(contexto, conta);
}

// Depois de criar uma conta "no meio" de outro fluxo, a pessoa volta e já a encontra selecionada.
function aplicarContaCriada(contexto, conta) {
    if (contexto.origem === 'assistente') {
        if (chat.passo === 'conta' || chat.passo === 'contaDestino') responder(conta.id, rotuloConta(conta));
    } else if (contexto.origem === 'formulario') {
        popularContasDoFormulario();
        byId(contexto.campo).value = conta.id;
    }
}

// ============================================================
// COFRINHOS E METAS
// ============================================================
function abrirFormularioMeta(id) {
    const meta = id ? achar('metas', id) : null;
    if (id && !meta) {
        mostrarToast('Cofrinho não encontrado.', 'erro');
        return;
    }
    limparErros('m');
    popularSelectDeContas(byId('mConta'), 'Nenhuma', { permitirNova: false });
    byId('mId').value = meta ? meta.id : '';
    byId('mNome').value = meta ? meta.nome : '';
    byId('mObjetivo').value = meta ? numeroParaCampo(meta.valor_objetivo) : '';
    byId('mAtual').value = meta ? numeroParaCampo(meta.valor_atual) : '';
    byId('mData').value = meta && dataValida(meta.data_limite) ? meta.data_limite : '';
    byId('mConta').value = meta && contaPorId(meta.conta_id) ? meta.conta_id : '';
    byId('mTitulo').textContent = meta ? 'Editar cofrinho' : 'Novo cofrinho';
    byId('btnExcluirMeta').hidden = !meta;
    abrirModal('modalMeta', meta ? null : 'mNome');
}

async function salvarFormularioMeta(evento) {
    evento.preventDefault();
    const id = byId('mId').value;
    const nome = byId('mNome').value.trim().replace(/\s+/g, ' ');
    const objetivo = lerDinheiro(byId('mObjetivo').value);
    const textoAtual = byId('mAtual').value.trim();
    const atual = textoAtual === '' ? 0 : lerDinheiro(textoAtual);
    const prazo = byId('mData').value;

    const erros = {};
    if (nome.length < 2) erros.nome = 'Dê um nome com pelo menos 2 letras.';
    else if (nome.length > 40) erros.nome = 'Use no máximo 40 caracteres.';
    if (objetivo === null || objetivo <= 0) erros.objetivo = 'Informe quanto precisa juntar. Exemplo: 5000,00';
    else if (objetivo > VALOR_MAXIMO) erros.objetivo = 'Esse valor é grande demais.';
    if (atual === null) erros.atual = 'Digite um valor válido. Exemplo: 250,00';
    if (prazo && !dataValida(prazo)) erros.data = 'Escolha uma data válida.';
    mostrarErros('m', erros);
    if (Object.keys(erros).length > 0) return;

    const existente = id ? achar('metas', id) : null;
    const meta = {
        ...(existente || {}),
        id: id || uuidv4(),
        nome,
        valor_objetivo: objetivo,
        valor_atual: atual,
        data_limite: prazo,
        conta_id: byId('mConta').value,
        sinc: false,
        updated_at: agora()
    };
    try {
        await confirmarMudancas({ gravar: { metas: [meta] } });
        fecharModal('modalMeta');
        mostrarToast(id ? 'Cofrinho atualizado.' : 'Cofrinho criado.');
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível salvar o cofrinho. Tente de novo.', 'erro');
    }
}

// ============================================================
// EXPORTAÇÃO
// ============================================================
function abrirExportar() {
    const { inicio, fim } = limitesDoPeriodo();
    const primeiroDoMes = `${ui.mes}-01`;
    byId('eDataIni').value = dataValida(inicio) ? inicio : primeiroDoMes;
    byId('eDataFim').value = dataValida(fim) ? fim : `${ui.mes}-${pad(new Date(Number(ui.mes.slice(0, 4)), Number(ui.mes.slice(5)), 0).getDate())}`;
    mostrarErroExportacao('');
    abrirModal('modalExportar');
}

function mostrarErroExportacao(mensagem) {
    const caixa = byId('erro-e');
    caixa.textContent = mensagem;
    caixa.hidden = !mensagem;
}

function lancamentosParaRelatorio() {
    const inicio = byId('eDataIni').value;
    const fim = byId('eDataFim').value;
    if (!dataValida(inicio) || !dataValida(fim)) {
        mostrarErroExportacao('Escolha as duas datas do período.');
        return null;
    }
    if (inicio > fim) {
        mostrarErroExportacao('A data inicial precisa ser anterior à final.');
        return null;
    }
    mostrarErroExportacao('');
    const itens = dados.transacoes
        .filter(t => t.data >= inicio && t.data <= fim)
        .sort((a, b) => comparar(a.data, b.data));
    if (itens.length === 0) {
        mostrarErroExportacao('Não há lançamentos nesse período.');
        return null;
    }
    return { inicio, fim, itens };
}

function linhaDoRelatorio(t) {
    const transferencia = t.categoria_id === CAT_TRANSFERENCIA;
    return [
        formatarDataBR(t.data),
        transferencia ? 'Transferência' : ROTULOS_TIPO[t.tipo] || t.tipo,
        t.descricao,
        Number(t.valor) || 0,
        t.pago ? 'Pago' : 'Pendente',
        transferencia ? 'Transferência' : nomeCategoria(categoriaPorId(t.categoria_id)),
        nomeConta(t.conta_id)
    ];
}

const CABECALHO_RELATORIO = ['Data', 'Tipo', 'Descrição', 'Valor', 'Situação', 'Categoria', 'Conta'];

function celulaCSV(valor) {
    let texto = typeof valor === 'number' ? numeroParaCampo(valor) : String(valor ?? '');
    // Evita que o Excel trate texto como fórmula.
    if (/^[=+\-@]/.test(texto)) texto = `'${texto}`;
    return /[";\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function baixarArquivo(blob, nome) {
    const endereco = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = endereco;
    link.download = nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(endereco), 1000);
}

function baixarCSV() {
    const relatorio = lancamentosParaRelatorio();
    if (!relatorio) return;
    const linhas = [CABECALHO_RELATORIO, ...relatorio.itens.map(linhaDoRelatorio)];
    // BOM + ponto e vírgula: abre com acentos e colunas corretas no Excel em português.
    const csv = '\ufeff' + linhas.map(linha => linha.map(celulaCSV).join(';')).join('\r\n');
    baixarArquivo(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `lancamentos_${relatorio.inicio}_a_${relatorio.fim}.csv`);
    mostrarToast('Planilha gerada.');
}

function baixarPDF() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
        mostrarErroExportacao('O gerador de PDF não carregou. Conecte à internet e tente de novo.');
        return;
    }
    const relatorio = lancamentosParaRelatorio();
    if (!relatorio) return;
    const documento = new window.jspdf.jsPDF();
    if (typeof documento.autoTable !== 'function') {
        mostrarErroExportacao('O gerador de PDF não carregou. Conecte à internet e tente de novo.');
        return;
    }
    documento.setFontSize(14);
    documento.text(`Lançamentos de ${formatarDataBR(relatorio.inicio)} a ${formatarDataBR(relatorio.fim)}`, 14, 16);
    documento.autoTable({
        head: [CABECALHO_RELATORIO],
        body: relatorio.itens.map(t => {
            const linha = linhaDoRelatorio(t);
            linha[3] = formatarMoeda(linha[3]);
            return linha;
        }),
        startY: 22,
        styles: { fontSize: 9 },
        headStyles: { fillColor: [11, 85, 102] }
    });
    documento.save(`lancamentos_${relatorio.inicio}_a_${relatorio.fim}.pdf`);
    mostrarToast('Relatório gerado.');
}

// ============================================================
// ASSISTENTE DE NOVO LANÇAMENTO
// ============================================================
const chat = {
    passo: null,
    dados: {},
    extras: { pago: true, foto: null },
    mensagens: [],
    pilha: [],
    marca: 0,
    opcoesAtuais: [],
    salvando: false,
    resultado: null,
    mostrarResumo: false
};

const OPCAO_NOVA_CONTA = { rotulo: '➕ Nova conta ou cartão', valor: NOVA_CONTA, acao: true };

function ok(valor) {
    return { ok: true, valor };
}

function recusar(erro) {
    return { ok: false, erro };
}

function sugestoesDeDescricao(tipo) {
    const padrao = {
        despesa: ['Mercado', 'Combustível', 'Restaurante', 'Farmácia'],
        receita: ['Salário', 'Freelance', 'Reembolso'],
        transferencia: ['Pagamento da fatura', 'Transferência entre contas']
    }[tipo] || [];
    if (tipo === 'transferencia') return padrao;

    // Usa o que a pessoa já registrou antes, para digitar menos.
    const recentes = [];
    [...dados.transacoes]
        .filter(t => t.tipo === tipo && t.categoria_id !== CAT_TRANSFERENCIA)
        .sort((a, b) => comparar(String(b.updated_at || ''), String(a.updated_at || '')))
        .forEach(t => {
            const nome = String(t.descricao).replace(/\s*\(\d+\/\d+\)$/, '').trim();
            if (nome && !recentes.includes(nome) && recentes.length < 4) recentes.push(nome);
        });
    return [...recentes, ...padrao.filter(item => !recentes.includes(item))].slice(0, 5);
}

function categoriasDoAssistente(tipo) {
    const todas = dados.categorias.filter(c => c.id !== CAT_TRANSFERENCIA);
    const compativeis = todas.filter(c => c.tipo === tipo || c.tipo === 'outros' || !c.tipo);
    return compativeis.length > 0 ? compativeis : todas;
}

const PASSOS = {
    tipo: {
        pergunta: () => 'O que você quer registrar?',
        opcoes: () => [
            { rotulo: '💸 Despesa', valor: 'despesa' },
            { rotulo: '💰 Receita', valor: 'receita' },
            { rotulo: '🔄 Transferência ou fatura', valor: 'transferencia' }
        ],
        aceitar: valor => TIPOS.includes(valor) ? ok(valor) : recusar('Escolha uma das opções abaixo.'),
        guardar: (d, valor) => { d.tipo = valor; },
        exibir: valor => ROTULOS_TIPO[valor]
    },
    valor: {
        pergunta: d => ({
            despesa: 'Quanto foi a despesa?',
            receita: 'Quanto você recebeu?',
            transferencia: 'Qual o valor da transferência ou do pagamento da fatura?'
        }[d.tipo]),
        campo: 'texto',
        teclado: 'decimal',
        placeholder: 'Ex.: 45,90',
        foco: true,
        aceitar: texto => {
            const valor = lerDinheiro(texto);
            if (valor === null) return recusar('Não entendi esse valor. Digite só números, por exemplo 45,90.');
            if (valor <= 0) return recusar('O valor precisa ser maior que zero.');
            if (valor > VALOR_MAXIMO) return recusar('Esse valor é grande demais. Confira se digitou certo.');
            return ok(valor);
        },
        guardar: (d, valor) => { d.valor = valor; },
        exibir: valor => formatarMoeda(valor)
    },
    descricao: {
        pergunta: d => d.tipo === 'transferencia'
            ? 'Como quer chamar? Escreva ou toque em uma sugestão.'
            : 'Do que se trata? Escreva ou toque em uma sugestão.',
        campo: 'texto',
        teclado: 'text',
        placeholder: 'Ex.: Mercado',
        foco: true,
        opcoes: d => sugestoesDeDescricao(d.tipo).map(texto => ({ rotulo: texto, valor: texto })),
        aceitar: texto => {
            const limpo = String(texto).trim().replace(/\s+/g, ' ');
            if (limpo.length < 2) return recusar('Escreva pelo menos 2 letras.');
            if (limpo.length > 60) return recusar('Use no máximo 60 caracteres.');
            return ok(limpo);
        },
        guardar: (d, valor) => { d.descricao = valor; },
        exibir: valor => valor
    },
    conta: {
        pergunta: d => {
            if (dados.contas.length === 0) return 'Você ainda não tem conta ou cartão cadastrado. Cadastre o primeiro para continuar.';
            return {
                despesa: 'De qual conta ou cartão saiu o dinheiro?',
                receita: 'Em qual conta o dinheiro entrou?',
                transferencia: 'De qual conta o dinheiro vai sair?'
            }[d.tipo];
        },
        opcoes: () => [...dados.contas.map(c => ({ rotulo: rotuloConta(c), valor: c.id })), OPCAO_NOVA_CONTA],
        aceitar: id => contaPorId(id) ? ok(id) : recusar('Escolha uma das contas abaixo.'),
        guardar: (d, id) => { d.contaId = id; },
        exibir: id => rotuloConta(contaPorId(id))
    },
    contaDestino: {
        pergunta: d => dados.contas.some(c => c.id !== d.contaId)
            ? 'Para qual conta o dinheiro vai? Para pagar a fatura, escolha o cartão.'
            : 'Para transferir, é preciso ter outra conta ou cartão. Cadastre a conta de destino.',
        opcoes: d => [
            ...dados.contas.filter(c => c.id !== d.contaId).map(c => ({ rotulo: rotuloConta(c), valor: c.id })),
            OPCAO_NOVA_CONTA
        ],
        aceitar: (id, d) => {
            if (!contaPorId(id)) return recusar('Escolha uma das contas abaixo.');
            if (id === d.contaId) return recusar('A origem e o destino precisam ser diferentes.');
            return ok(id);
        },
        guardar: (d, id) => { d.contaDestinoId = id; },
        exibir: id => rotuloConta(contaPorId(id))
    },
    parcelas: {
        pergunta: () => 'Foi parcelado? Escolha ou digite o número de parcelas.',
        campo: 'texto',
        teclado: 'numeric',
        placeholder: 'Ex.: 3',
        opcoes: () => [1, 2, 3, 4, 5, 6, 10, 12].map(n => ({ rotulo: n === 1 ? 'À vista' : `${n}x`, valor: n })),
        aceitar: texto => {
            const encontrado = String(texto).trim().match(/^(\d{1,3})\s*x?$/i);
            const parcelas = encontrado ? Number(encontrado[1]) : NaN;
            if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > MAX_PARCELAS) {
                return recusar(`Digite um número de 1 a ${MAX_PARCELAS}. Para pagar de uma vez, escolha "À vista".`);
            }
            return ok(parcelas);
        },
        guardar: (d, valor) => { d.parcelas = valor; },
        exibir: valor => valor === 1 ? 'À vista' : `${valor}x`
    },
    categoria: {
        pergunta: () => 'Qual é a categoria?',
        opcoes: d => categoriasDoAssistente(d.tipo).map(c => ({ rotulo: `${iconeCategoria(c)} ${nomeCategoria(c)}`, valor: c.id })),
        aceitar: id => categoriaPorId(id) ? ok(id) : recusar('Escolha uma das categorias abaixo.'),
        guardar: (d, id) => { d.categoriaId = id; },
        exibir: id => `${iconeCategoria(categoriaPorId(id))} ${nomeCategoria(categoriaPorId(id))}`
    },
    data: {
        pergunta: () => 'Quando aconteceu?',
        opcoes: () => [
            { rotulo: '📅 Hoje', valor: 'hoje' },
            { rotulo: '📅 Ontem', valor: 'ontem' },
            { rotulo: '🗓️ Outra data', valor: 'outra' },
            { rotulo: '📆 Agendar para o futuro', valor: 'futura' }
        ],
        aceitar: valor => ['hoje', 'ontem', 'outra', 'futura'].includes(valor) ? ok(valor) : recusar('Escolha uma das opções abaixo.'),
        guardar: (d, valor) => {
            d.dataModo = valor;
            d.data = valor === 'hoje' ? hojeISO() : (valor === 'ontem' ? somarDias(hojeISO(), -1) : null);
        },
        exibir: valor => ({ hoje: 'Hoje', ontem: 'Ontem', outra: 'Outra data', futura: 'Agendar para o futuro' }[valor])
    },
    dataCustom: {
        pergunta: d => d.dataModo === 'futura'
            ? 'Para qual dia no futuro? Escolha no calendário.'
            : 'Escolha a data no calendário.',
        campo: 'data',
        aceitar: (iso, d) => {
            if (!dataValida(iso)) return recusar('Escolha uma data válida no calendário.');
            if (d.dataModo === 'futura' && iso <= hojeISO()) return recusar('Para agendar, escolha uma data a partir de amanhã.');
            return ok(iso);
        },
        guardar: (d, iso) => { d.data = iso; },
        exibir: iso => formatarDataBR(iso)
    },
    repeticao: {
        pergunta: () => 'Esse lançamento se repete todo mês, como aluguel ou salário? Escolha ou digite por quantos meses.',
        campo: 'texto',
        teclado: 'numeric',
        placeholder: 'Ex.: 8',
        opcoes: () => [
            { rotulo: 'Só uma vez', valor: 1 },
            { rotulo: '3 meses', valor: 3 },
            { rotulo: '6 meses', valor: 6 },
            { rotulo: '12 meses', valor: 12 }
        ],
        aceitar: texto => {
            const encontrado = String(texto).trim().match(/^(\d{1,3})\s*(meses|mês|mes|x)?$/i);
            const meses = encontrado ? Number(encontrado[1]) : NaN;
            if (!Number.isInteger(meses) || meses < 1 || meses > MAX_PARCELAS) {
                return recusar(`Digite um número de 1 a ${MAX_PARCELAS}. Se não se repete, escolha "Só uma vez".`);
            }
            return ok(meses);
        },
        guardar: (d, valor) => { d.repeticao = valor; },
        exibir: valor => valor === 1 ? 'Só uma vez' : `Todo mês, por ${valor} meses`
    },
    confirmar: {
        pergunta: () => 'Confira os dados abaixo. Se estiver tudo certo, é só salvar.'
    }
};

// Os passos mudam conforme as respostas: transferência não tem categoria, cartão pergunta parcelas.
function sequenciaDePassos(d) {
    const sequencia = ['tipo', 'valor', 'descricao', 'conta'];
    if (d.tipo === 'transferencia') {
        sequencia.push('contaDestino');
    } else {
        if (d.tipo === 'despesa' && contaEhCartao(d.contaId)) sequencia.push('parcelas');
        sequencia.push('categoria');
    }
    sequencia.push('data');
    if (podeRepetir(d)) sequencia.push('repeticao');
    sequencia.push('confirmar');
    return sequencia;
}

// Despesa parcelada no cartão já é uma sequência; os demais podem se repetir todo mês.
function podeRepetir(d) {
    if (d.tipo === 'transferencia') return false;
    return !(d.tipo === 'despesa' && contaEhCartao(d.contaId) && (d.parcelas || 1) > 1);
}

function reiniciarAssistente() {
    Object.assign(chat, {
        passo: null,
        dados: {},
        extras: { pago: true, foto: null },
        mensagens: [{ de: 'bot', texto: 'Oi! Vou te ajudar a registrar um lançamento, um passo de cada vez.' }],
        pilha: [],
        marca: 0,
        opcoesAtuais: [],
        salvando: false,
        resultado: null,
        mostrarResumo: false
    });
    irPara('tipo');
}

function abrirAssistente() {
    reiniciarAssistente();
    abrirModal('modalChat');
}

function irPara(id) {
    chat.passo = id;
    // Data futura = agendado: o interruptor "já foi pago" começa desligado.
    if (id === 'confirmar') chat.extras.pago = !(chat.dados.data > hojeISO());
    chat.mensagens.push({ de: 'bot', texto: PASSOS[id].pergunta(chat.dados) });
    chat.marca = chat.mensagens.length;
    renderChat(true);
}

function avancar() {
    if (chat.passo === 'data' && ['outra', 'futura'].includes(chat.dados.dataModo)) {
        irPara('dataCustom');
        return;
    }
    const sequencia = sequenciaDePassos(chat.dados);
    const base = chat.passo === 'dataCustom' ? 'data' : chat.passo;
    irPara(sequencia[sequencia.indexOf(base) + 1] || 'confirmar');
}

function responder(bruto, rotuloDigitado) {
    if (chat.salvando || !PASSOS[chat.passo] || !PASSOS[chat.passo].aceitar) return;

    if (bruto === NOVA_CONTA) {
        abrirFormularioConta(null, { origem: 'assistente' });
        return;
    }

    const passo = PASSOS[chat.passo];
    const resultado = passo.aceitar(bruto, chat.dados);
    const textoDoUsuario = String(rotuloDigitado ?? bruto).trim();

    if (!resultado.ok) {
        if (textoDoUsuario) chat.mensagens.push({ de: 'user', texto: textoDoUsuario });
        chat.mensagens.push({ de: 'erro', texto: resultado.erro });
        renderChat(true);
        return;
    }

    chat.pilha.push({ passo: chat.passo, dados: { ...chat.dados }, marca: chat.marca });
    chat.mensagens.push({ de: 'user', texto: passo.exibir(resultado.valor) });
    passo.guardar(chat.dados, resultado.valor);
    avancar();
}

function voltarPasso() {
    if (chat.salvando || chat.passo === 'concluido' || chat.pilha.length === 0) return;
    const anterior = chat.pilha.pop();
    chat.passo = anterior.passo;
    chat.dados = anterior.dados;
    chat.mensagens.length = anterior.marca;
    chat.marca = anterior.marca;
    renderChat(false);
}

function entradaDoAssistente() {
    const d = chat.dados;
    const parcelado = d.tipo === 'despesa' && contaEhCartao(d.contaId) && (d.parcelas || 1) > 1;
    const meses = podeRepetir(d) ? (d.repeticao || 1) : 1;
    const modo = parcelado ? 'parcelado' : (meses > 1 ? 'mensal' : 'unica');
    return {
        tipo: d.tipo,
        descricao: d.descricao,
        valor: d.valor,
        data: d.data,
        contaId: d.contaId,
        contaDestinoId: d.contaDestinoId,
        categoriaId: d.tipo === 'transferencia' ? CAT_TRANSFERENCIA : d.categoriaId,
        modo,
        quantidade: parcelado ? d.parcelas : (modo === 'mensal' ? meses : 1),
        pago: chat.extras.pago,
        foto: chat.extras.foto
    };
}

async function salvarDoAssistente() {
    if (chat.salvando) return;
    const entrada = entradaDoAssistente();
    const erros = validarLancamento(entrada);
    const mensagens = Object.values(erros);
    if (mensagens.length > 0) {
        mostrarToast(mensagens[0], 'erro');
        return;
    }

    chat.salvando = true;
    renderChat(false);
    try {
        const itens = await criarLancamentos(entrada);
        chat.resultado = { entrada, quantidade: itens.length };
        chat.passo = 'concluido';
    } catch (erro) {
        console.error(erro);
        chat.mensagens.push({ de: 'erro', texto: 'Não foi possível salvar. Seus dados continuam aqui, é só tentar de novo.' });
    } finally {
        chat.salvando = false;
        renderChat(true);
    }
}

async function aoEscolherFotoDoAssistente() {
    const entrada = byId('chatFoto');
    const arquivo = entrada.files && entrada.files[0];
    if (!arquivo) return;
    try {
        chat.extras.foto = await reduzirImagem(arquivo);
        renderChat(false);
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível usar essa foto. Tente outra imagem.', 'erro');
    } finally {
        entrada.value = '';
    }
}

function htmlConfirmacao() {
    const e = entradaDoAssistente();
    const transferencia = e.tipo === 'transferencia';
    const sinal = e.tipo === 'receita' ? '+ ' : (e.tipo === 'despesa' ? '- ' : '');
    const classe = e.tipo === 'receita' ? 'pos' : (e.tipo === 'despesa' ? 'neg' : '');

    const linhas = [['Descrição', e.descricao]];
    if (transferencia) {
        linhas.push(['Sai de', rotuloConta(contaPorId(e.contaId))]);
        linhas.push(['Entra em', rotuloConta(contaPorId(e.contaDestinoId))]);
    } else {
        linhas.push([e.tipo === 'receita' ? 'Entra em' : 'Conta', rotuloConta(contaPorId(e.contaId))]);
        const categoria = categoriaPorId(e.categoriaId);
        linhas.push(['Categoria', `${iconeCategoria(categoria)} ${nomeCategoria(categoria)}`]);
    }
    linhas.push(['Data', formatarDataBR(e.data)]);
    if (e.modo === 'parcelado') {
        linhas.push(['Parcelas', `${e.quantidade}x de ${formatarMoeda(dividirEmParcelas(e.valor, e.quantidade)[0])}`]);
    }
    if (e.modo === 'mensal') linhas.push(['Repete', `Todo mês, por ${e.quantidade} meses`]);

    const foto = fotoSegura(e.foto);
    let notaParcelas = '';
    if (e.modo !== 'unica') {
        notaParcelas = '<p class="cartao-nota">Só o 1º lançamento entra como pago. Os próximos ficam agendados, um por mês.</p>';
    } else if (e.data > hojeISO()) {
        notaParcelas = '<p class="cartao-nota">Data futura: o lançamento fica agendado e aparece na previsão do mês. Quando acontecer, é só marcar como pago.</p>';
    }
    return `
        <div class="cartao-resumo">
            <p class="cartao-tipo">${esc(ROTULOS_TIPO[e.tipo])}</p>
            <p class="cartao-valor ${classe}">${sinal}${formatarMoeda(e.valor)}</p>
            <dl class="cartao-linhas">
                ${linhas.map(([nome, valor]) => `<div class="cartao-linha"><dt>${esc(nome)}</dt><dd>${esc(valor)}</dd></div>`).join('')}
            </dl>
            <label class="interruptor">
                <span>${esc(ROTULOS_SITUACAO[e.tipo].sim)}</span>
                <input type="checkbox" id="chatPago" ${chat.extras.pago ? 'checked' : ''}>
            </label>
            ${notaParcelas}
            <div class="foto-linha">
                ${foto
        ? `<img src="${esc(foto)}" alt="Comprovante anexado"><button type="button" class="btn-texto" data-action="chat-foto-remover">Remover foto</button>`
        : '<button type="button" class="btn btn-sec" data-action="chat-foto">📷 Anexar comprovante (opcional)</button>'}
            </div>
        </div>`;
}

function htmlSucesso() {
    const { entrada, quantidade } = chat.resultado;
    const titulos = { despesa: 'Despesa salva!', receita: 'Receita salva!', transferencia: 'Transferência salva!' };
    const titulo = entrada.data > hojeISO() ? 'Lançamento agendado!' : titulos[entrada.tipo];
    const nome = entrada.descricao.trim();
    let detalhe = `${nome} · ${formatarMoeda(entrada.valor)}`;
    if (entrada.modo === 'parcelado') {
        detalhe = `${nome}: ${entrada.quantidade}x de ${formatarMoeda(dividirEmParcelas(entrada.valor, entrada.quantidade)[0])}`;
    } else if (entrada.modo === 'mensal') {
        detalhe = `${nome}: ${formatarMoeda(entrada.valor)} por mês`;
    }
    const mesDoLancamento = entrada.data.slice(0, 7);
    const foraDoMes = !(ui.inicio || ui.fim) && mesDoLancamento !== ui.mes;
    const envio = navigator.onLine
        ? 'Salvo e sendo enviado para a nuvem.'
        : 'Salvo no aparelho. Será enviado quando a internet voltar.';

    let html = `
        <div class="sucesso">
            <svg class="sucesso-check" viewBox="0 0 72 72" aria-hidden="true">
                <circle cx="36" cy="36" r="34"></circle>
                <path d="M21 37 L32 48 L52 26"></path>
            </svg>
            <h3>${esc(titulo)}</h3>
            <p>${esc(detalhe)}</p>
            <p>${esc(envio)}</p>
            ${quantidade > 1 && entrada.tipo !== 'transferencia' ? `<p>${quantidade} lançamentos criados, um por mês.</p>` : ''}
            ${foraDoMes ? `<p>Este lançamento é de ${esc(rotuloMes(mesDoLancamento))}, por isso não aparece no mês que está na tela.</p>` : ''}
        </div>`;

    if (chat.mostrarResumo) {
        const resumo = resumoDoMes(mesDoLancamento);
        html += `
            <div class="cartao-resumo">
                <p class="cartao-tipo">Resumo de ${esc(rotuloMes(mesDoLancamento))}</p>
                <dl class="cartao-linhas">
                    <div class="cartao-linha"><dt>Entradas</dt><dd class="pos">${formatarMoeda(resumo.entradas)}</dd></div>
                    <div class="cartao-linha"><dt>Saídas</dt><dd class="neg">${formatarMoeda(resumo.saidas)}</dd></div>
                    <div class="cartao-linha"><dt>Resultado do mês</dt><dd class="${resumo.saldo < 0 ? 'neg' : 'pos'}">${formatarMoeda(resumo.saldo)}</dd></div>
                </dl>
            </div>`;
    }
    return html;
}

function htmlAcoesDoRodape() {
    if (chat.passo === 'concluido') {
        const mesDoLancamento = chat.resultado.entrada.data.slice(0, 7);
        const foraDoMes = !(ui.inicio || ui.fim) && mesDoLancamento !== ui.mes;
        return [
            '<button type="button" class="btn btn-bloco" data-action="chat-novo">Registrar outro</button>',
            foraDoMes ? `<button type="button" class="btn btn-sec btn-bloco" data-action="chat-ir-mes">Ver ${esc(rotuloMes(mesDoLancamento))}</button>` : '',
            chat.mostrarResumo ? '' : '<button type="button" class="btn btn-sec btn-bloco" data-action="chat-resumo">Ver resumo do mês</button>',
            '<button type="button" class="btn-texto" data-action="chat-concluir">Concluir</button>'
        ].join('');
    }
    return `
        <button type="button" class="btn btn-bloco" data-action="chat-salvar" ${chat.salvando ? 'disabled' : ''}>${chat.salvando ? 'Salvando…' : 'Salvar lançamento'}</button>
        <button type="button" class="btn-texto" data-action="chat-concluir" ${chat.salvando ? 'disabled' : ''}>Cancelar</button>`;
}

function renderChat(animarUltima) {
    const concluido = chat.passo === 'concluido';
    const confirmando = chat.passo === 'confirmar' || concluido;
    const passo = PASSOS[chat.passo];

    // Cabeçalho e progresso
    const sequencia = sequenciaDePassos(chat.dados);
    const indice = concluido ? sequencia.length : sequencia.indexOf(chat.passo === 'dataCustom' ? 'data' : chat.passo) + 1;
    byId('chatProgressoBarra').style.width = `${Math.round((indice / sequencia.length) * 100)}%`;
    byId('chatPassoTexto').textContent = concluido ? 'Tudo certo!' : `Passo ${indice} de ${sequencia.length}`;
    byId('chatVoltar').hidden = concluido || chat.salvando || chat.pilha.length === 0;

    // Conversa
    const ultima = chat.mensagens.length - 1;
    let html = chat.mensagens
        .map((m, i) => `<div class="bolha bolha-${m.de}${animarUltima && i === ultima ? ' nova' : ''}">${esc(m.texto)}</div>`)
        .join('');
    if (chat.passo === 'confirmar') html += htmlConfirmacao();
    if (concluido) html += htmlSucesso();
    const area = byId('chatMensagens');
    area.innerHTML = html;
    area.scrollTop = area.scrollHeight;

    const interruptor = byId('chatPago');
    if (interruptor) {
        interruptor.onchange = () => {
            chat.extras.pago = interruptor.checked;
        };
    }

    // Rodapé: opções, ações ou campo de digitação
    const rodape = byId('chatOpcoes');
    if (confirmando) {
        chat.opcoesAtuais = [];
        rodape.className = 'acoes-chat';
        rodape.innerHTML = htmlAcoesDoRodape();
    } else {
        chat.opcoesAtuais = passo.opcoes ? passo.opcoes(chat.dados) : [];
        rodape.className = 'opcoes';
        rodape.innerHTML = chat.opcoesAtuais
            .map((opcao, i) => `<button type="button" class="opcao${opcao.acao ? ' opcao-acao' : ''}" data-action="chat-opcao" data-indice="${i}">${esc(opcao.rotulo)}</button>`)
            .join('');
    }

    const formulario = byId('chatForm');
    const campo = byId('chatCampo');
    const mostrarCampo = !confirmando && Boolean(passo.campo);
    formulario.hidden = !mostrarCampo;
    if (mostrarCampo) {
        const ehData = passo.campo === 'data';
        campo.type = ehData ? 'date' : 'text';
        campo.setAttribute('inputmode', passo.teclado || 'text');
        campo.placeholder = passo.placeholder || '';
        const primeiroDiaFuturo = somarDias(hojeISO(), 1);
        const agendando = ehData && chat.dados.dataModo === 'futura';
        campo.min = agendando ? primeiroDiaFuturo : '';
        campo.value = ehData ? (agendando ? primeiroDiaFuturo : hojeISO()) : '';
        byId('chatEnviar').textContent = ehData ? 'Confirmar' : 'Enviar';
        if (passo.foco) setTimeout(() => campo.focus(), 80);
    }
}

function enviarDoCampoDoAssistente(evento) {
    evento.preventDefault();
    const passo = PASSOS[chat.passo];
    if (!passo || !passo.campo) return;
    const campo = byId('chatCampo');
    const texto = campo.value.trim();
    campo.value = '';
    responder(texto, passo.campo === 'data' ? formatarDataBR(texto) : texto);
}

function escolherOpcaoDoAssistente(indice) {
    const opcao = chat.opcoesAtuais[indice];
    if (opcao) responder(opcao.valor, opcao.rotulo);
}

// ============================================================
// AÇÕES DA INTERFACE (um único ouvinte de clique para o app inteiro)
// ============================================================
const ACOES = {
    'mes-anterior': () => mudarMes(-1),
    'mes-seguinte': () => mudarMes(1),
    'abrir-menu': () => abrirModal('modalMenu'),
    'novo-lancamento': () => abrirAssistente(),
    'fechar-modal': elemento => fecharModal(elemento.closest('.modal').id),
    'clicar-fora': () => aoClicarFora(),
    'alternar-senha': elemento => {
        const campo = byId('senhaEntrada');
        const mostrar = campo.type === 'password';
        campo.type = mostrar ? 'text' : 'password';
        elemento.textContent = mostrar ? 'Ocultar' : 'Mostrar';
        elemento.setAttribute('aria-pressed', String(mostrar));
    },
    'alternar-tema': () => alternarTema(),
    'sincronizar-agora': () => sincronizarAgora(),
    'sair': () => encerrarSessao(),
    'limpar-filtros': () => limparFiltros(),
    'filtro-status': elemento => {
        ui.status = elemento.dataset.status;
        renderizar();
    },
    'ver-pendentes': () => {
        ui.status = 'pendentes';
        renderizar();
        byId('tituloLancamentos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    'nova-conta': () => abrirFormularioConta(null),
    'editar-conta': elemento => abrirFormularioConta(elemento.dataset.id),
    'excluir-conta': () => excluirConta(byId('cId').value),
    'nova-meta': () => abrirFormularioMeta(null),
    'editar-meta': elemento => abrirFormularioMeta(elemento.dataset.id),
    'excluir-meta': () => excluirMeta(byId('mId').value),
    'editar-transacao': elemento => abrirFormularioTransacao(elemento.dataset.id),
    'excluir-transacao': () => excluirTransacao(byId('tId').value),
    'marcar-pago': elemento => marcarComoPago(elemento.dataset.id),
    'ver-comprovante': elemento => {
        const transacao = achar('transacoes', elemento.dataset.id);
        if (transacao) abrirZoom(transacao.foto);
    },
    'fechar-zoom': () => fecharZoom(),
    'form-foto-escolher': () => byId('tFoto').click(),
    'form-foto-remover': () => {
        formTransacao.foto = null;
        renderFotoDoFormulario();
    },
    'abrir-exportar': () => abrirExportar(),
    'exportar-csv': () => baixarCSV(),
    'exportar-pdf': () => baixarPDF(),
    'resposta-confirmacao': elemento => responderConfirmacao(Number(elemento.dataset.indice)),
    'chat-opcao': elemento => escolherOpcaoDoAssistente(Number(elemento.dataset.indice)),
    'chat-voltar': () => voltarPasso(),
    'chat-salvar': () => salvarDoAssistente(),
    'chat-concluir': () => fecharModal('modalChat'),
    'chat-novo': () => {
        reiniciarAssistente();
    },
    'chat-resumo': () => {
        chat.mostrarResumo = true;
        renderChat(false);
    },
    'chat-ir-mes': () => {
        irParaMes(chat.resultado.entrada.data.slice(0, 7));
        fecharModal('modalChat');
    },
    'chat-foto': () => byId('chatFoto').click(),
    'chat-foto-remover': () => {
        chat.extras.foto = null;
        renderChat(false);
    },
    'chat-formulario': () => {
        fecharModal('modalChat');
        abrirFormularioTransacao(null);
    }
};

function registrarEventos() {
    document.addEventListener('click', evento => {
        const alvo = evento.target.closest('[data-action]');
        if (!alvo) return;
        const acao = ACOES[alvo.dataset.action];
        if (acao) acao(alvo, evento);
    });

    // Ao corrigir um campo com erro, a mensagem some.
    const limparErroDoCampo = evento => {
        const campo = evento.target.closest('.campo.erro');
        if (!campo) return;
        campo.classList.remove('erro');
        const mensagem = campo.querySelector('.campo-erro');
        if (mensagem) mensagem.hidden = true;
    };
    document.addEventListener('input', limparErroDoCampo);
    document.addEventListener('change', limparErroDoCampo);

    document.addEventListener('keydown', evento => {
        if (evento.key !== 'Escape') return;
        if (!byId('visualizador').hidden) fecharZoom();
        else fecharModalDoTopo();
    });

    byId('formLogin').addEventListener('submit', entrar);
    byId('formTransacao').addEventListener('submit', salvarFormularioTransacao);
    byId('formConta').addEventListener('submit', salvarFormularioConta);
    byId('formMeta').addEventListener('submit', salvarFormularioMeta);
    byId('chatForm').addEventListener('submit', enviarDoCampoDoAssistente);

    document.querySelectorAll('input[name="tTipo"]').forEach(radio => radio.addEventListener('change', ajustarFormularioPorTipo));
    document.querySelectorAll('input[name="cTipo"]').forEach(radio => radio.addEventListener('change', ajustarFormularioConta));
    ['tConta', 'tContaDestino'].forEach(id => {
        byId(id).addEventListener('change', evento => {
            if (evento.target.value !== NOVA_CONTA) return;
            evento.target.value = '';
            abrirFormularioConta(null, { origem: 'formulario', campo: id });
        });
    });

    byId('tRepeticao').addEventListener('change', ajustarQuantidade);
    byId('tData').addEventListener('change', ajustarSituacaoPelaData);
    byId('tFoto').addEventListener('change', aoEscolherFotoDoFormulario);
    byId('chatFoto').addEventListener('change', aoEscolherFotoDoAssistente);

    byId('filtroInicio').addEventListener('change', aoMudarPeriodo);
    byId('filtroFim').addEventListener('change', aoMudarPeriodo);
    byId('filtroBusca').addEventListener('input', evento => {
        ui.busca = evento.target.value.trim().toLowerCase();
        renderizar();
    });
    byId('filtroCategoria').addEventListener('change', evento => {
        ui.categoria = evento.target.value;
        renderizar();
    });

    window.addEventListener('online', () => {
        atualizarStatusSync(null);
        if (authToken) agendarSync(true);
    });
    window.addEventListener('offline', () => atualizarStatusSync(null));
    document.addEventListener('visibilitychange', () => {
        if (document.hidden || !authToken || !navigator.onLine || !appIniciado) return;
        const desatualizado = Date.now() - ultimaSincOk > SYNC_VALIDADE_MS;
        if (contarPendentes() > 0 || desatualizado) agendarSync(true);
    });
}

// ============================================================
// INÍCIO
// ============================================================
function iniciar() {
    aplicarTema(temaAtual);
    registrarEventos();

    if (authToken) {
        mostrarApp();
        validarSessaoEmSegundoPlano();
    } else {
        mostrarLogin();
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .catch(erro => console.warn('Não foi possível ativar o modo offline:', erro));
        });
    }
}

iniciar();
