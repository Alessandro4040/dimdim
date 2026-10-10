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
const ui = { mes: mesAtualISO(), inicio: '', fim: '', busca: '', categoria: '', visao: 'todas' };

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

function periodoDoResumo() {
    const { inicio, fim } = limitesDoPeriodo();
    return { inicio, fim };
}

// Mês em que a conta começou a ser usada: antes dele o saldo da conta é zero.
// Usa o lançamento mais antigo da conta ou, se não houver, o mês em que ela foi criada ou editada.
function mesDeInicioDaConta(conta) {
    const meses = dados.transacoes
        .filter(t => t.conta_id === conta.id && dataValida(t.data))
        .map(t => t.data.slice(0, 7));
    const criacao = String(conta.updated_at || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(criacao)) meses.push(criacao);
    return meses.sort()[0] || mesAtualISO();
}

// Saldo acumulado da conta até uma data: saldo inicial + tudo o que entrou e saiu até lá.
// Antes do mês em que a conta começou, o saldo é zero. Em meses futuros (previsão)
// também entram os lançamentos pendentes e agendados.
function saldoDaContaAte(conta, ate, incluirPendentes) {
    if (mesDeInicioDaConta(conta) > ate.slice(0, 7)) return 0;
    let total = Number(conta.saldo_inicial) || 0;
    dados.transacoes.forEach(t => {
        if (t.conta_id !== conta.id || t.data > ate) return;
        if (!t.pago && !incluirPendentes) return;
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

function filtrosAtivos() {
    return Boolean(ui.inicio || ui.fim || ui.busca || ui.categoria);
}

// Balanço do período em forma de conta, só com as contas correntes:
// começou com + receitas - despesas +/- transferências = fica no fim.
// Tudo o que está agendado ou pendente já entra (é a previsão); o que já aconteceu vem separado.
function balancoDoPeriodo() {
    const periodo = periodoDoResumo();
    const mesInicial = periodo.inicio.slice(0, 7);
    const mesFinal = periodo.fim.slice(0, 7);
    const correntes = dados.contas.filter(conta => conta.tipo === 'corrente');
    const idsCorrentes = new Set(correntes.map(conta => conta.id));
    const idsCartoes = new Set(dados.contas.filter(conta => conta.tipo === 'cartao').map(conta => conta.id));
    const novoGrupo = () => ({ total: 0, feito: 0, aberto: 0 });
    const balanco = { inicio: 0, receitas: novoGrupo(), despesas: novoGrupo(), transferencias: 0, cartao: 0, fim: 0 };

    correntes.forEach(conta => {
        const comeco = mesDeInicioDaConta(conta);
        if (comeco > mesFinal) return;
        balanco.inicio += comeco >= mesInicial
            ? Number(conta.saldo_inicial) || 0
            : saldoDaContaAte(conta, somarDias(periodo.inicio, -1), true);
    });

    dados.transacoes.forEach(t => {
        if (t.data < periodo.inicio || t.data > periodo.fim) return;
        const valor = Number(t.valor) || 0;
        const transferencia = t.categoria_id === CAT_TRANSFERENCIA;
        if (idsCorrentes.has(t.conta_id)) {
            if (transferencia) {
                balanco.transferencias += t.tipo === 'receita' ? valor : -valor;
                return;
            }
            const grupo = t.tipo === 'receita' ? balanco.receitas : balanco.despesas;
            grupo.total += valor;
            grupo[t.pago ? 'feito' : 'aberto'] += valor;
        } else if (idsCartoes.has(t.conta_id) && !transferencia) {
            balanco.cartao += t.tipo === 'despesa' ? valor : -valor;
        }
    });

    [balanco.receitas, balanco.despesas].forEach(grupo => {
        grupo.total = arredondar(grupo.total);
        grupo.feito = arredondar(grupo.feito);
        grupo.aberto = arredondar(grupo.aberto);
    });
    balanco.inicio = arredondar(balanco.inicio);
    balanco.transferencias = arredondar(balanco.transferencias);
    balanco.cartao = arredondar(balanco.cartao);
    balanco.fim = arredondar(balanco.inicio + balanco.receitas.total - balanco.despesas.total + balanco.transferencias);
    return balanco;
}

// Dinheiro que realmente está nas contas hoje (só o que já foi pago ou recebido).
function totalNasContasHoje() {
    const saldos = saldosDasContas();
    return arredondar(dados.contas.filter(c => c.tipo === 'corrente').reduce((soma, c) => soma + saldos[c.id], 0));
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

function retirarDosExcluidos(store, ids) {
    const excluidos = lerExcluidos();
    excluidos[store] = (excluidos[store] || []).filter(id => !ids.includes(id));
    gravarExcluidos(excluidos);
}

async function restaurarLancamentos(itens) {
    try {
        retirarDosExcluidos('transacoes', itens.map(item => item.id));
        await confirmarMudancas({
            gravar: { transacoes: itens.map(item => ({ ...item, sinc: false, updated_at: agora() })) }
        });
        mostrarToast('Lançamento restaurado.');
    } catch (erro) {
        console.error(erro);
        mostrarToast('Não foi possível restaurar. Tente de novo.', 'erro');
    }
}

// Exclui na hora e oferece "Desfazer". Só pergunta quando há uma escolha a fazer (sequências).
async function excluirTransacao(id) {
    const transacao = achar('transacoes', id);
    if (!transacao) return;
    const grupo = grupoDoLancamento(transacao);
    let ids = [transacao.id];

    if (ehTransferencia(transacao)) {
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
    }

    const removidos = dados.transacoes.filter(t => ids.includes(t.id));
    try {
        await confirmarMudancas({ remover: { transacoes: ids } });
        fecharModal('modalLancamento');
        mostrarToast(ids.length > 1 ? 'Lançamentos excluídos.' : 'Lançamento excluído.', 'ok', {
            rotulo: 'Desfazer',
            fn: () => restaurarLancamentos(removidos)
        });
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

function renderizar() {
    renderCabecalho();
    renderBalanco();
    renderAvisos();
    renderContas();
    renderCategorias();
    renderMetas();
    renderTransacoes();
    renderFiltroCategorias();
    atualizarStatusSync();
}

function periodoPersonalizado() {
    return Boolean(ui.inicio || ui.fim);
}

function renderCabecalho() {
    const personalizado = periodoPersonalizado();
    byId('mesRotulo').textContent = personalizado ? 'Período escolhido' : rotuloMes(ui.mes);
    let estado = 'Período personalizado';
    if (!personalizado) {
        if (ui.mes < mesAtualISO()) estado = 'Mês encerrado';
        else if (ui.mes > mesAtualISO()) estado = 'Mês futuro · previsão';
        else estado = 'Mês atual';
    }
    byId('mesEstado').textContent = estado;
    byId('btnHoje').hidden = !personalizado && ui.mes === mesAtualISO();
}

function detalheDoGrupo(grupo, feito, aberto) {
    if (grupo.total === 0) return 'Nada neste período';
    const partes = [];
    if (grupo.feito > 0) partes.push(`${formatarMoeda(grupo.feito)} ${feito}`);
    if (grupo.aberto > 0) partes.push(`${formatarMoeda(grupo.aberto)} ${aberto}`);
    return partes.join(' · ');
}

function renderBalanco() {
    const balanco = balancoDoPeriodo();
    const emMes = !periodoPersonalizado();
    const nomeDoMes = emMes ? rotuloMes(ui.mes).toLowerCase() : '';

    let rotulo = 'Saldo no fim do período';
    if (emMes) rotulo = ui.mes < mesAtualISO() ? `Saldo no fim de ${nomeDoMes}` : `Previsão para o fim de ${nomeDoMes}`;
    byId('balancoRotulo').textContent = rotulo;

    const valor = byId('saldoTotal');
    valor.textContent = formatarMoeda(balanco.fim);
    valor.classList.toggle('negativo', balanco.fim < 0);

    const hoje = byId('balancoHoje');
    hoje.hidden = !(emMes && ui.mes === mesAtualISO());
    hoje.textContent = hoje.hidden ? '' : `Hoje você tem ${formatarMoeda(totalNasContasHoje())} nas contas`;

    byId('eqInicio').textContent = formatarMoeda(balanco.inicio);
    byId('eqRec').textContent = `+ ${formatarMoeda(balanco.receitas.total)}`;
    byId('eqRecDetalhe').textContent = detalheDoGrupo(balanco.receitas, 'recebido', 'a receber');
    byId('eqDes').textContent = `- ${formatarMoeda(balanco.despesas.total)}`;
    byId('eqDesDetalhe').textContent = detalheDoGrupo(balanco.despesas, 'pago', 'a pagar');

    const temTransferencias = Math.abs(balanco.transferencias) > 0.005;
    byId('eqTransLinha').hidden = !temTransferencias;
    byId('eqTrans').textContent = `${balanco.transferencias < 0 ? '-' : '+'} ${formatarMoeda(Math.abs(balanco.transferencias))}`;

    const cartao = byId('balancoCartao');
    cartao.hidden = Math.abs(balanco.cartao) <= 0.005;
    cartao.textContent = cartao.hidden
        ? ''
        : `No cartão: ${formatarMoeda(balanco.cartao)} em compras. Elas só saem das contas quando você paga a fatura.`;
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

function rotuloDoSaldoDaConta() {
    if (periodoPersonalizado()) return 'Saldo no fim do período';
    return ui.mes < mesAtualISO() ? 'Saldo no fim do mês' : 'Saldo previsto';
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
    const noMesAtual = !periodoPersonalizado() && ui.mes === mesAtualISO();
    lista.innerHTML = dados.contas.map(conta => {
        const cartao = conta.tipo === 'cartao';
        const valor = cartao ? gastosDoCartaoNoPeriodo(conta, periodo) : saldoDaContaAte(conta, periodo.fim, true);
        const vencimento = cartao && Number(conta.vencimento) ? ` · vence dia ${esc(conta.vencimento)}` : '';
        const limite = cartao && noMesAtual ? `<small class="sub">Limite livre hoje: ${formatarMoeda(saldosHoje[conta.id])}</small>` : '';
        return `
            <li class="conta-card">
                <button type="button" class="conta-card-corpo" data-action="editar-conta" data-id="${esc(conta.id)}">
                    <span class="conta-topo">
                        <span class="icone-circulo" aria-hidden="true">${cartao ? '💳' : '🏦'}</span>
                        <span class="texto-bloco">
                            <strong>${esc(conta.nome)}</strong>
                            <small>${cartao ? 'Cartão de crédito' : 'Conta ou carteira'}${vencimento}</small>
                        </span>
                    </span>
                    <small class="sub">${cartao ? 'Compras neste período' : rotuloDoSaldoDaConta()}</small>
                    <strong class="valor-grande ${!cartao && valor < 0 ? 'neg' : ''}">${formatarMoeda(valor)}</strong>
                    ${limite}
                </button>
                ${cartao ? `<button type="button" class="mini mini-link" data-action="pagar-fatura" data-id="${esc(conta.id)}">Pagar fatura</button>` : ''}
            </li>`;
    }).join('');
}

function renderCategorias() {
    const secao = byId('secaoCategorias');
    const porCategoria = new Map();
    let total = 0;
    lancamentosDoPeriodo().forEach(t => {
        if (t.tipo !== 'despesa' || t.categoria_id === CAT_TRANSFERENCIA) return;
        const valor = Number(t.valor) || 0;
        porCategoria.set(t.categoria_id, (porCategoria.get(t.categoria_id) || 0) + valor);
        total += valor;
    });
    secao.hidden = total <= 0;
    if (total <= 0) return;

    const linhas = [...porCategoria.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    byId('listaCategorias').innerHTML = linhas.map(([id, valor]) => {
        const categoria = categoriaPorId(id);
        const percentual = Math.round((valor / total) * 100);
        return `
            <li>
                <button type="button" class="cat-linha" data-action="filtrar-categoria" data-id="${esc(id)}" aria-pressed="${ui.categoria === id}">
                    <span class="icone-circulo" aria-hidden="true">${esc(iconeCategoria(categoria))}</span>
                    <span class="cat-corpo">
                        <span class="cat-topo">
                            <strong>${esc(nomeCategoria(categoria))} <small class="sub">${percentual}%</small></strong>
                            <span class="valor">${formatarMoeda(valor)}</span>
                        </span>
                        <span class="barra" aria-hidden="true"><span style="width: ${Math.max(percentual, 3)}%"></span></span>
                    </span>
                </button>
            </li>`;
    }).join('');
}

function renderTransacoes() {
    const somentePendentes = ui.visao === 'pendentes';
    let titulo = periodoPersonalizado() ? 'Lançamentos do período' : 'Lançamentos do mês';
    if (somentePendentes) titulo = 'Pendentes de todos os meses';
    byId('tituloLancamentos').textContent = titulo;
    document.querySelectorAll('[data-action="filtro-visao"]').forEach(chip => {
        chip.setAttribute('aria-pressed', String(chip.dataset.visao === ui.visao));
    });

    let base = somentePendentes
        ? dados.transacoes.filter(t => !t.pago && passaNosFiltros(t))
        : lancamentosDoPeriodo();
    if (ui.visao === 'receitas') base = base.filter(t => t.tipo === 'receita' && t.categoria_id !== CAT_TRANSFERENCIA);
    if (ui.visao === 'despesas') base = base.filter(t => t.tipo === 'despesa' && t.categoria_id !== CAT_TRANSFERENCIA);

    const ordenadas = [...base].sort((a, b) => {
        const porData = somentePendentes ? comparar(a.data, b.data) : comparar(b.data, a.data);
        return porData || comparar(String(b.updated_at || ''), String(a.updated_at || ''));
    });

    const container = byId('listaTransacoes');
    if (ordenadas.length === 0) {
        let mensagem = 'Nenhum lançamento neste mês. Toque em "Despesa" ou "Receita" para registrar o primeiro.';
        if (somentePendentes) mensagem = 'Nenhum lançamento pendente. Tudo em dia!';
        else if (filtrosAtivos() || ui.visao !== 'todas') mensagem = 'Nenhum lançamento encontrado com esses filtros.';
        else if (!periodoPersonalizado() && ui.mes > mesAtualISO()) mensagem = 'Nada agendado para este mês. Toque em "Despesa" ou "Receita" e escolha "Amanhã" ou "Outra data" para planejar.';
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

function mudarMes(delta) {
    const [ano, mes] = ui.mes.split('-').map(Number);
    const data = new Date(ano, mes - 1 + delta, 1);
    irParaMes(`${data.getFullYear()}-${pad(data.getMonth() + 1)}`);
}

function irParaMes(mes) {
    ui.mes = mes;
    ui.inicio = '';
    ui.fim = '';
    ui.visao = 'todas';
    sincronizarCamposDeFiltro();
    renderizar();
}

function aoMudarPeriodo() {
    let inicio = byId('filtroInicio').value;
    let fim = byId('filtroFim').value;
    if (inicio && fim && inicio > fim) [inicio, fim] = [fim, inicio];
    ui.inicio = inicio;
    ui.fim = fim;
    ui.visao = 'todas';
    sincronizarCamposDeFiltro();
    renderizar();
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

function limparFiltros() {
    ui.inicio = '';
    ui.fim = '';
    ui.busca = '';
    ui.categoria = '';
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
let acaoDoToast = null;

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

function fecharModalDoTopo() {
    const topo = pilhaModais[pilhaModais.length - 1];
    if (!topo) return;
    if (topo.id === 'modalLancamento' && lanc.salvando) return;
    fecharModal(topo.id);
}

// Tocar fora não fecha a tela de lançamento com dados digitados, para ninguém perder o que escreveu.
function aoClicarFora() {
    const topo = pilhaModais[pilhaModais.length - 1];
    if (!topo) return;
    if (topo.id === 'modalLancamento' && lancamentoTemDados()) return;
    fecharModalDoTopo();
}

function mostrarToast(texto, tipo = 'ok', acao = null) {
    const elemento = byId('toast');
    const botao = byId('toastAcao');
    byId('toastTexto').textContent = texto;
    acaoDoToast = acao;
    botao.hidden = !acao;
    botao.textContent = acao ? acao.rotulo : '';
    elemento.className = `toast visivel${tipo === 'erro' ? ' erro' : ''}`;
    clearTimeout(timerToast);
    const duracao = tipo === 'erro' ? 5000 : (acao ? 6500 : 3000);
    timerToast = setTimeout(() => elemento.classList.remove('visivel'), duracao);
}

function usarAcaoDoToast() {
    const acao = acaoDoToast;
    acaoDoToast = null;
    byId('toast').classList.remove('visivel');
    if (acao) acao.fn();
}

// Depois de criar uma conta "no meio" da tela de lançamento, ela já volta selecionada.
function aplicarContaCriada(contexto, conta) {
    if (contexto.origem !== 'lancamento') return;
    lanc[contexto.campo] = conta.id;
    if (lanc.tipo === 'transferencia' && lanc.contaId === lanc.destinoId) lanc.destinoId = '';
    renderLancamento();
}

function popularSelectDeContas(seletor, placeholder) {
    const opcoes = [`<option value="">${esc(placeholder)}</option>`];
    dados.contas.forEach(conta => {
        opcoes.push(`<option value="${esc(conta.id)}">${esc(rotuloConta(conta))}</option>`);
    });
    seletor.innerHTML = opcoes.join('');
}

function responderConfirmacao(indice) {
    const valor = respostasDaConfirmacao[indice];
    const resolver = confirmacaoPendente;
    confirmacaoPendente = null;
    fecharModal('modalConfirmar');
    if (resolver) resolver(valor === undefined ? null : valor);
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
        else if (primeiroCampo.scrollIntoView) primeiroCampo.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
// LANÇAMENTO (criar e editar na mesma tela)
// ============================================================
const lanc = {
    editando: false,
    id: '',
    tipo: 'despesa',
    categoriaId: '',
    contaId: '',
    destinoId: '',
    dataModo: 'hoje',
    data: '',
    repeticao: 'unica',
    quantidade: 3,
    pago: true,
    pagoManual: false,
    foto: null,
    categoriaOriginal: '',
    sugestoes: [],
    salvando: false
};

const OPCOES_DATA = [['hoje', 'Hoje'], ['ontem', 'Ontem'], ['amanha', 'Amanhã'], ['outra', 'Outra data']];
const OPCOES_REPETICAO = {
    despesa: [['unica', 'Só uma vez'], ['parcelado', 'Parcelado'], ['mensal', 'Todo mês']],
    receita: [['unica', 'Só uma vez'], ['mensal', 'Todo mês']],
    transferencia: []
};
const TITULOS_LANCAMENTO = { despesa: 'Nova despesa', receita: 'Nova receita', transferencia: 'Transferência ou fatura' };
const ROTULOS_CONTA = { despesa: 'Pago com', receita: 'Entrou em', transferencia: 'Sai de' };

function dataDoModo(modo) {
    if (modo === 'ontem') return somarDias(hojeISO(), -1);
    if (modo === 'amanha') return somarDias(hojeISO(), 1);
    return hojeISO();
}

function modoDaData(iso) {
    return ['hoje', 'ontem', 'amanha'].find(modo => dataDoModo(modo) === iso) || 'outra';
}

function primeiraContaCorrente(excluirId = '') {
    const conta = dados.contas.find(c => c.tipo === 'corrente' && c.id !== excluirId);
    return conta ? conta.id : '';
}

// Sugere a conta mais usada recentemente, para a pessoa não precisar escolher toda vez.
function contaPadrao() {
    if (dados.contas.length === 1) return dados.contas[0].id;
    const recente = [...dados.transacoes]
        .filter(t => contaPorId(t.conta_id) && t.categoria_id !== CAT_TRANSFERENCIA)
        .sort((a, b) => comparar(String(b.updated_at || ''), String(a.updated_at || '')))[0];
    return recente ? recente.conta_id : '';
}

function descricaoSemParcela(texto) {
    return String(texto).replace(/\s*\(\d+\/\d+\)$/, '').trim();
}

function lancamentosParecidos(tipo) {
    return [...dados.transacoes]
        .filter(t => t.tipo === tipo && t.categoria_id !== CAT_TRANSFERENCIA)
        .sort((a, b) => comparar(String(b.updated_at || ''), String(a.updated_at || '')));
}

function sugestoesDeDescricao(tipo) {
    const padrao = {
        despesa: ['Mercado', 'Combustível', 'Restaurante', 'Farmácia'],
        receita: ['Salário', 'Freelance', 'Reembolso'],
        transferencia: ['Pagamento da fatura', 'Transferência entre contas']
    }[tipo] || [];
    if (tipo === 'transferencia') return padrao;

    // Prefere o que a pessoa já registrou antes.
    const recentes = [];
    lancamentosParecidos(tipo).forEach(t => {
        const nome = descricaoSemParcela(t.descricao);
        if (nome && !recentes.includes(nome) && recentes.length < 4) recentes.push(nome);
    });
    return [...recentes, ...padrao.filter(item => !recentes.includes(item))].slice(0, 5);
}

function categoriasParaTipo(tipo) {
    const todas = dados.categorias.filter(c => c.id !== CAT_TRANSFERENCIA);
    const lista = todas.filter(c => c.tipo === tipo || c.tipo === 'outros' || !c.tipo);
    const base = lista.length > 0 ? lista : todas;
    // Na edição, mantém a categoria original mesmo que ela seja de outro tipo.
    const original = categoriaPorId(lanc.categoriaOriginal);
    if (lanc.editando && original && lanc.categoriaOriginal !== CAT_TRANSFERENCIA && !base.includes(original)) {
        return [...base, original];
    }
    return base;
}

function botaoOpcao(campo, valor, rotulo, ativo, tracejado = false) {
    return `<button type="button" class="opt${tracejado ? ' opt-acao' : ''}" data-action="lanc-escolher" data-campo="${campo}" data-valor="${esc(valor)}" aria-pressed="${ativo}">${esc(rotulo)}</button>`;
}

function chipsDeContas(campo, excluirId) {
    const selecionada = campo === 'conta' ? lanc.contaId : lanc.destinoId;
    const chips = dados.contas
        .filter(conta => conta.id !== excluirId)
        .map(conta => botaoOpcao(campo, conta.id, rotuloConta(conta), conta.id === selecionada));
    chips.push(botaoOpcao(campo, NOVA_CONTA, '➕ Nova conta', false, true));
    return chips.join('');
}

function abrirLancamento({ id = null, tipo = 'despesa', destinoId = '', valor = null, descricao = '' } = {}) {
    const transacao = id ? achar('transacoes', id) : null;
    if (id && !transacao) {
        mostrarToast('Lançamento não encontrado.', 'erro');
        return;
    }
    const transferencia = transacao ? ehTransferencia(transacao) : false;

    limparErros('l');
    Object.assign(lanc, {
        editando: Boolean(transacao),
        id: transacao ? transacao.id : '',
        tipo: transacao ? (transferencia ? 'transferencia' : transacao.tipo) : tipo,
        categoriaId: '',
        contaId: '',
        destinoId,
        dataModo: 'hoje',
        data: hojeISO(),
        repeticao: 'unica',
        quantidade: 3,
        pago: true,
        pagoManual: false,
        foto: null,
        categoriaOriginal: '',
        salvando: false
    });

    if (transacao) {
        lanc.categoriaOriginal = transacao.categoria_id;
        lanc.data = transacao.data;
        lanc.dataModo = modoDaData(transacao.data);
        lanc.pago = Boolean(transacao.pago);
        lanc.pagoManual = true;
        lanc.foto = transacao.foto || null;
        if (transferencia) {
            const grupo = grupoDoLancamento(transacao);
            lanc.contaId = grupo.find(t => t.tipo === 'despesa').conta_id;
            lanc.destinoId = grupo.find(t => t.tipo === 'receita').conta_id;
        } else {
            lanc.categoriaId = transacao.categoria_id;
            lanc.contaId = transacao.conta_id;
        }
        byId('lValor').value = numeroParaCampo(transacao.valor);
        byId('lDescricao').value = transacao.descricao;
    } else {
        lanc.contaId = tipo === 'transferencia' ? primeiraContaCorrente(destinoId) : contaPadrao();
        byId('lValor').value = valor ? numeroParaCampo(valor) : '';
        byId('lDescricao').value = descricao;
    }
    byId('lData').value = lanc.data;

    const info = byId('lInfo');
    const sequencia = transacao && !transferencia && (transacao.parcela_total || 1) > 1;
    info.hidden = !sequencia;
    info.textContent = sequencia
        ? `Este é o lançamento ${transacao.parcela_num} de ${transacao.parcela_total} de uma sequência. A alteração vale só para ele.`
        : '';

    renderLancamento();
    abrirModal('modalLancamento', transacao ? null : 'lValor');
}

function dicaDaSituacao() {
    if (!lanc.editando && lanc.tipo !== 'transferencia' && lanc.repeticao !== 'unica') {
        return 'Só o primeiro lançamento é marcado agora. Os próximos ficam agendados, um por mês.';
    }
    if (lanc.pago) return '';
    return lanc.data > hojeISO()
        ? 'Agendado: entra na previsão do mês. Quando acontecer, marque como pago na lista.'
        : 'Fica como pendente até você marcar como pago.';
}

function renderFotoDoLancamento() {
    const origem = fotoSegura(lanc.foto);
    byId('lFotoArea').innerHTML = origem
        ? `<img src="${esc(origem)}" alt="Comprovante anexado"><button type="button" class="btn-texto" data-action="lanc-foto-remover">Remover foto</button>`
        : '<button type="button" class="btn btn-sec" data-action="lanc-foto">📷 Anexar comprovante</button>';
}

function renderPrevia() {
    const destino = byId('lPrevia');
    const valor = lerDinheiro(byId('lValor').value);
    if (!valor || valor <= 0) {
        destino.innerHTML = '<span>Digite o valor para ver o resumo do lançamento.</span>';
        return;
    }
    const transferencia = lanc.tipo === 'transferencia';
    const modo = lanc.editando || transferencia ? 'unica' : lanc.repeticao;
    const nomeDoTipo = ROTULOS_TIPO[lanc.tipo];

    let titulo = `${nomeDoTipo} de ${formatarMoeda(valor)}`;
    if (modo === 'parcelado') {
        titulo += ` em ${lanc.quantidade}x de ${formatarMoeda(dividirEmParcelas(valor, lanc.quantidade)[0])}`;
    } else if (modo === 'mensal') {
        titulo += ` todo mês, por ${lanc.quantidade} meses`;
    }

    const partes = [];
    if (transferencia) {
        if (contaPorId(lanc.contaId) && contaPorId(lanc.destinoId)) partes.push(`${nomeConta(lanc.contaId)} → ${nomeConta(lanc.destinoId)}`);
    } else {
        const categoria = categoriaPorId(lanc.categoriaId);
        if (categoria) partes.push(nomeCategoria(categoria));
        if (contaPorId(lanc.contaId)) partes.push(nomeConta(lanc.contaId));
    }
    if (dataValida(lanc.data)) partes.push(rotuloDia(lanc.data).toLowerCase());
    if (modo !== 'unica' && dataValida(lanc.data)) partes.push(`último em ${formatarDataBR(somarMeses(lanc.data, lanc.quantidade - 1))}`);
    const situacoes = { despesa: ['paga', 'a pagar'], receita: ['recebida', 'a receber'], transferencia: ['feita', 'a fazer'] }[lanc.tipo];
    partes.push(lanc.pago ? situacoes[0] : (lanc.data > hojeISO() ? 'agendada' : situacoes[1]));

    destino.innerHTML = `<strong>${esc(titulo)}</strong><span>${esc(partes.join(' · '))}</span>`;
}

function renderLancamento() {
    const transferencia = lanc.tipo === 'transferencia';
    const semRepeticao = lanc.editando || transferencia || lanc.repeticao === 'unica';

    byId('modalLancamento').dataset.tom = lanc.tipo;
    byId('lTitulo').textContent = lanc.editando
        ? (transferencia ? 'Editar transferência' : `Editar ${lanc.tipo}`)
        : TITULOS_LANCAMENTO[lanc.tipo];
    definirRadio('lTipo', lanc.tipo);
    document.querySelectorAll('input[name="lTipo"]').forEach(radio => {
        // Na edição, transferência não vira despesa/receita (e vice-versa): quebraria o par de lançamentos.
        radio.disabled = lanc.editando && (transferencia || radio.value === 'transferencia');
    });

    byId('campo-l-categoria').hidden = transferencia;
    byId('campo-l-contaDestino').hidden = !transferencia;
    byId('campo-l-repeticao').hidden = lanc.editando || transferencia;
    byId('campo-l-quantidade').hidden = semRepeticao;
    byId('lContaRotulo').textContent = ROTULOS_CONTA[lanc.tipo];

    lanc.sugestoes = sugestoesDeDescricao(lanc.tipo);
    byId('lSugestoes').innerHTML = lanc.sugestoes
        .map((texto, i) => `<button type="button" class="sugestao" data-action="lanc-sugestao" data-indice="${i}">${esc(texto)}</button>`)
        .join('');

    byId('lCategorias').innerHTML = categoriasParaTipo(lanc.tipo)
        .map(c => botaoOpcao('categoria', c.id, `${iconeCategoria(c)} ${nomeCategoria(c)}`, c.id === lanc.categoriaId))
        .join('');
    byId('lContas').innerHTML = chipsDeContas('conta', '');
    byId('lContasDestino').innerHTML = chipsDeContas('destino', lanc.contaId);
    byId('lDatas').innerHTML = OPCOES_DATA.map(([modo, rotulo]) => botaoOpcao('data', modo, rotulo, lanc.dataModo === modo)).join('');
    byId('lData').hidden = lanc.dataModo !== 'outra';
    byId('lRepeticoes').innerHTML = (OPCOES_REPETICAO[lanc.tipo] || [])
        .map(([modo, rotulo]) => botaoOpcao('repeticao', modo, rotulo, lanc.repeticao === modo))
        .join('');
    byId('lQuantidade').value = String(lanc.quantidade);
    byId('lQuantidadeRotulo').textContent = lanc.repeticao === 'parcelado' ? 'Quantas parcelas' : 'Por quantos meses';

    byId('lPago').checked = lanc.pago;
    byId('lPagoRotulo').textContent = ROTULOS_SITUACAO[lanc.tipo].sim;
    byId('lPagoDica').textContent = dicaDaSituacao();
    renderFotoDoLancamento();

    byId('btnExcluirLanc').hidden = !lanc.editando;
    byId('btnSalvarNovo').hidden = lanc.editando;
    renderPrevia();
}

// Se a data é futura, o lançamento nasce como "agendado"; se é hoje ou passado, como "já realizado".
function ajustarPagoAutomatico() {
    if (!lanc.editando && !lanc.pagoManual) lanc.pago = lanc.data <= hojeISO();
}

function aoMudarTipoLancamento(tipo) {
    if (lanc.editando && (lanc.tipo === 'transferencia' || tipo === 'transferencia')) return;
    if (!TIPOS.includes(tipo)) return;
    lanc.tipo = tipo;
    if (!categoriasParaTipo(tipo).some(c => c.id === lanc.categoriaId)) lanc.categoriaId = '';
    if (tipo === 'receita' && lanc.repeticao === 'parcelado') lanc.repeticao = 'unica';
    if (tipo === 'transferencia') {
        if (!lanc.contaId || contaEhCartao(lanc.contaId)) lanc.contaId = primeiraContaCorrente(lanc.destinoId);
        if (lanc.destinoId === lanc.contaId) lanc.destinoId = '';
    }
    renderLancamento();
}

function escolherNoLancamento(campo, valor) {
    if ((campo === 'conta' || campo === 'destino') && valor === NOVA_CONTA) {
        abrirFormularioConta(null, { origem: 'lancamento', campo: campo === 'conta' ? 'contaId' : 'destinoId' });
        return;
    }
    if (campo === 'categoria') {
        lanc.categoriaId = valor;
    } else if (campo === 'conta') {
        lanc.contaId = valor;
        if (lanc.destinoId === valor) lanc.destinoId = '';
    } else if (campo === 'destino') {
        lanc.destinoId = valor;
    } else if (campo === 'data') {
        lanc.dataModo = valor;
        if (valor === 'outra') {
            const digitada = byId('lData').value;
            lanc.data = dataValida(digitada) ? digitada : hojeISO();
            byId('lData').value = lanc.data;
        } else {
            lanc.data = dataDoModo(valor);
        }
        ajustarPagoAutomatico();
    } else if (campo === 'repeticao') {
        if (lanc.repeticao !== valor) lanc.quantidade = valor === 'mensal' ? 12 : 3;
        lanc.repeticao = valor;
    }
    limparErroDoCampoPorId(`campo-l-${campo === 'destino' ? 'contaDestino' : campo}`);
    renderLancamento();
}

function limparErroDoCampoPorId(id) {
    const campo = byId(id);
    if (!campo) return;
    campo.classList.remove('erro');
    const mensagem = campo.querySelector('.campo-erro');
    if (mensagem) mensagem.hidden = true;
}

function mudarQuantidade(delta) {
    definirQuantidade(lanc.quantidade + delta);
    renderLancamento();
}

function definirQuantidade(valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return;
    lanc.quantidade = Math.min(MAX_PARCELAS, Math.max(2, Math.round(numero)));
}

// Se a descrição já foi usada antes, preenche categoria, conta e valor (quando estiverem vazios).
function aprenderComDescricao() {
    const texto = byId('lDescricao').value.trim().toLowerCase();
    if (lanc.editando || lanc.tipo === 'transferencia' || texto.length < 2) return;
    const anterior = lancamentosParecidos(lanc.tipo).find(t => descricaoSemParcela(t.descricao).toLowerCase() === texto);
    if (!anterior) return;

    let mudou = false;
    if (!lanc.categoriaId && categoriaPorId(anterior.categoria_id) && categoriasParaTipo(lanc.tipo).some(c => c.id === anterior.categoria_id)) {
        lanc.categoriaId = anterior.categoria_id;
        mudou = true;
    }
    if (!lanc.contaId && contaPorId(anterior.conta_id)) {
        lanc.contaId = anterior.conta_id;
        mudou = true;
    }
    const campoValor = byId('lValor');
    if (!campoValor.value.trim() && (anterior.parcela_total || 1) === 1) {
        campoValor.value = numeroParaCampo(anterior.valor);
        mudou = true;
    }
    if (mudou) renderLancamento();
}

function usarSugestao(indice) {
    const texto = lanc.sugestoes[indice];
    if (!texto) return;
    byId('lDescricao').value = texto;
    limparErroDoCampoPorId('campo-l-descricao');
    aprenderComDescricao();
    renderPrevia();
    const valor = byId('lValor');
    if (!valor.value.trim()) valor.focus();
}

function lancamentoTemDados() {
    return !lanc.editando && Boolean(byId('lValor').value.trim() || byId('lDescricao').value.trim());
}

function entradaDoLancamento() {
    const transferencia = lanc.tipo === 'transferencia';
    const modo = lanc.editando || transferencia ? 'unica' : lanc.repeticao;
    return {
        tipo: lanc.tipo,
        descricao: byId('lDescricao').value,
        valor: lerDinheiro(byId('lValor').value),
        data: lanc.data,
        contaId: lanc.contaId,
        contaDestinoId: lanc.destinoId,
        categoriaId: transferencia ? CAT_TRANSFERENCIA : lanc.categoriaId,
        modo,
        quantidade: modo === 'unica' ? 1 : lanc.quantidade,
        pago: lanc.pago,
        foto: lanc.foto
    };
}

function prepararProximoLancamento() {
    Object.assign(lanc, { categoriaId: '', repeticao: 'unica', quantidade: 3, foto: null, pagoManual: false });
    ajustarPagoAutomatico();
    byId('lValor').value = '';
    byId('lDescricao').value = '';
    limparErros('l');
    renderLancamento();
    byId('lValor').focus();
}

async function salvarLancamento(emSequencia = false) {
    if (lanc.salvando) return;
    if (lanc.dataModo === 'outra') lanc.data = byId('lData').value;
    const entrada = entradaDoLancamento();
    const erros = validarLancamento(entrada, { edicao: lanc.editando });
    mostrarErros('l', erros);
    if (Object.keys(erros).length > 0) return;

    lanc.salvando = true;
    marcarOcupado('btnSalvarLanc', true, 'Salvando…');
    byId('btnSalvarNovo').disabled = true;
    try {
        if (lanc.editando) await atualizarLancamento(lanc.id, entrada);
        else await criarLancamentos(entrada);

        const agendado = entrada.data > hojeISO();
        const mesDoLancamento = entrada.data.slice(0, 7);
        const foraDaTela = !periodoPersonalizado() && mesDoLancamento !== ui.mes;
        let texto = lanc.editando ? 'Alterações salvas.' : (agendado ? 'Lançamento agendado.' : `${ROTULOS_TIPO[entrada.tipo]} salva.`);
        if (emSequencia && !lanc.editando) texto += ' Pode lançar o próximo.';
        const acao = foraDaTela ? { rotulo: `Ver ${rotuloMes(mesDoLancamento).split(' ')[0].toLowerCase()}`, fn: () => irParaMes(mesDoLancamento) } : null;

        if (emSequencia && !lanc.editando) prepararProximoLancamento();
        else fecharModal('modalLancamento');
        mostrarToast(texto, 'ok', acao);
    } catch (erro) {
        console.error(erro);
        if (erro.erros) mostrarErros('l', erro.erros);
        else mostrarToast('Não foi possível salvar. Seus dados continuam na tela, tente de novo.', 'erro');
    } finally {
        lanc.salvando = false;
        marcarOcupado('btnSalvarLanc', false);
        byId('btnSalvarNovo').disabled = false;
    }
}

async function aoEscolherFotoDoLancamento() {
    const entrada = byId('lFoto');
    const arquivo = entrada.files && entrada.files[0];
    if (!arquivo) return;
    try {
        lanc.foto = await reduzirImagem(arquivo);
        renderFotoDoLancamento();
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
    popularSelectDeContas(byId('mConta'), 'Nenhuma');
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
// AÇÕES DA INTERFACE (um único ouvinte de clique para o app inteiro)
// ============================================================
const ACOES = {
    'mes-anterior': () => mudarMes(-1),
    'mes-seguinte': () => mudarMes(1),
    'ir-hoje': () => irParaMes(mesAtualISO()),
    'abrir-menu': () => abrirModal('modalMenu'),
    'novo-despesa': () => abrirLancamento({ tipo: 'despesa' }),
    'novo-receita': () => abrirLancamento({ tipo: 'receita' }),
    'novo-transferencia': () => abrirLancamento({ tipo: 'transferencia' }),
    'pagar-fatura': elemento => {
        const cartao = achar('contas', elemento.dataset.id);
        if (!cartao) return;
        // Sugere o valor das compras do período no cartão; a pessoa ajusta se precisar.
        abrirLancamento({
            tipo: 'transferencia',
            destinoId: cartao.id,
            valor: gastosDoCartaoNoPeriodo(cartao, periodoDoResumo()) || null,
            descricao: 'Pagamento da fatura'
        });
    },
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
    'filtro-visao': elemento => {
        ui.visao = elemento.dataset.visao;
        renderizar();
    },
    'filtrar-categoria': elemento => {
        ui.categoria = ui.categoria === elemento.dataset.id ? '' : elemento.dataset.id;
        sincronizarCamposDeFiltro();
        renderizar();
    },
    'ver-pendentes': () => {
        ui.visao = 'pendentes';
        renderizar();
        byId('tituloLancamentos').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    'nova-conta': () => abrirFormularioConta(null),
    'editar-conta': elemento => abrirFormularioConta(elemento.dataset.id),
    'excluir-conta': () => excluirConta(byId('cId').value),
    'nova-meta': () => abrirFormularioMeta(null),
    'editar-meta': elemento => abrirFormularioMeta(elemento.dataset.id),
    'excluir-meta': () => excluirMeta(byId('mId').value),
    'editar-transacao': elemento => abrirLancamento({ id: elemento.dataset.id }),
    'excluir-transacao': () => excluirTransacao(lanc.id),
    'marcar-pago': elemento => marcarComoPago(elemento.dataset.id),
    'ver-comprovante': elemento => {
        const transacao = achar('transacoes', elemento.dataset.id);
        if (transacao) abrirZoom(transacao.foto);
    },
    'fechar-zoom': () => fecharZoom(),
    'lanc-escolher': elemento => escolherNoLancamento(elemento.dataset.campo, elemento.dataset.valor),
    'lanc-sugestao': elemento => usarSugestao(Number(elemento.dataset.indice)),
    'lanc-qtd': elemento => mudarQuantidade(Number(elemento.dataset.delta)),
    'lanc-salvar-novo': () => salvarLancamento(true),
    'lanc-foto': () => byId('lFoto').click(),
    'lanc-foto-remover': () => {
        lanc.foto = null;
        renderFotoDoLancamento();
    },
    'abrir-exportar': () => abrirExportar(),
    'exportar-csv': () => baixarCSV(),
    'exportar-pdf': () => baixarPDF(),
    'resposta-confirmacao': elemento => responderConfirmacao(Number(elemento.dataset.indice)),
    'toast-acao': () => usarAcaoDoToast()
};

// Deslizar para os lados troca de mês (fora de carrosséis, campos e filtros).
function registrarGestoDeMes() {
    let toque = null;
    document.addEventListener('touchstart', evento => {
        if (pilhaModais.length > 0 || evento.touches.length !== 1) {
            toque = null;
            return;
        }
        const ponto = evento.touches[0];
        toque = { x: ponto.clientX, y: ponto.clientY, alvo: evento.target };
    }, { passive: true });
    document.addEventListener('touchend', evento => {
        if (!toque) return;
        const ponto = evento.changedTouches[0];
        const dx = ponto.clientX - toque.x;
        const dy = ponto.clientY - toque.y;
        const alvo = toque.alvo;
        toque = null;
        if (Math.abs(dx) < 90 || Math.abs(dy) > 45 || byId('app').hidden) return;
        if (alvo && alvo.closest && alvo.closest('.carrossel, .chips, input, select, textarea')) return;
        mudarMes(dx < 0 ? 1 : -1);
    }, { passive: true });
}

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
    byId('formLancamento').addEventListener('submit', evento => {
        evento.preventDefault();
        salvarLancamento(false);
    });
    byId('formConta').addEventListener('submit', salvarFormularioConta);
    byId('formMeta').addEventListener('submit', salvarFormularioMeta);

    document.querySelectorAll('input[name="lTipo"]').forEach(radio => {
        radio.addEventListener('change', () => aoMudarTipoLancamento(radio.value));
    });
    document.querySelectorAll('input[name="cTipo"]').forEach(radio => radio.addEventListener('change', ajustarFormularioConta));

    byId('lValor').addEventListener('input', renderPrevia);
    byId('lValor').addEventListener('blur', evento => {
        const valor = lerDinheiro(evento.target.value);
        if (valor !== null && valor > 0) evento.target.value = numeroParaCampo(valor);
    });
    byId('lDescricao').addEventListener('input', renderPrevia);
    byId('lDescricao').addEventListener('change', aprenderComDescricao);
    byId('lData').addEventListener('change', evento => {
        if (!dataValida(evento.target.value)) return;
        lanc.data = evento.target.value;
        ajustarPagoAutomatico();
        renderLancamento();
    });
    byId('lQuantidade').addEventListener('change', evento => {
        definirQuantidade(evento.target.value);
        renderLancamento();
    });
    byId('lPago').addEventListener('change', evento => {
        lanc.pago = evento.target.checked;
        lanc.pagoManual = true;
        byId('lPagoDica').textContent = dicaDaSituacao();
        renderPrevia();
    });
    byId('lFoto').addEventListener('change', aoEscolherFotoDoLancamento);

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
    registrarGestoDeMes();
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
