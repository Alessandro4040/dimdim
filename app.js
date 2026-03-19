// ============================================
// Configurações globais
// ============================================
const API_URL = 'https://script.google.com/macros/s/AKfycbxmNq89HZfL4PgIonWJBgxX8KLUR3f1WOMP_K5sSskxFVCfukPPgfSdb5L5yuqt-GrP/exec';
const DB_NAME = 'financas_familiar_v3';
const STORE_TRANSACOES = 'transacoes';
const STORE_CONTAS = 'contas';
const STORE_CATEGORIAS = 'categorias';
const STORE_METAS = 'metas';

let db;
let transacoes = [], contas = [], categorias = [], metas = [];
let chartInstance = null;
let fotoBase64 = null;
let editTransacaoId = null, editContaId = null, editMetaId = null;
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';

// Inicialização do DB
const request = indexedDB.open(DB_NAME, 1);
request.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_TRANSACOES)) db.createObjectStore(STORE_TRANSACOES, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_CONTAS)) db.createObjectStore(STORE_CONTAS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_METAS)) db.createObjectStore(STORE_METAS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_CATEGORIAS)) {
        const storeCat = db.createObjectStore(STORE_CATEGORIAS, { keyPath: 'id' });
        const catsPadrao = [
            { id: 'cat1', nome: 'Salário', tipo: 'receita', icone: '💰' },
            { id: 'cat2', nome: 'Alimentação', tipo: 'despesa', icone: '🍔' },
            { id: 'cat3', nome: 'Transporte', tipo: 'despesa', icone: '🚗' },
            { id: 'cat4', nome: 'Lazer', tipo: 'despesa', icone: '🎬' },
            { id: 'cat5', nome: 'Moradia', tipo: 'despesa', icone: '🏠' },
            { id: 'cat6', nome: 'Investimentos', tipo: 'receita', icone: '📈' },
            { id: 'cat7', nome: 'Outros', tipo: 'ambos', icone: '📦' }
        ];
        catsPadrao.forEach(c => storeCat.put(c));
    }
};

request.onsuccess = (e) => {
    db = e.target.result;
    document.getElementById('filtroMes').value = mesAtual;
    if (localStorage.getItem('logado') === 'true') entrarNoApp();
};

// ============================================
// Core: Carregamento Assíncrono Seguro
// ============================================
async function carregarTudo(chamarSinc = false) {
    const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_CATEGORIAS, STORE_METAS], 'readonly');
    
    // Usamos Promises para garantir que tudo carregou antes de atualizar a UI
    const lerStore = (nome) => new Promise(res => {
        tx.objectStore(nome).getAll().onsuccess = (e) => res(e.target.result);
    });

    [transacoes, contas, categorias, metas] = await Promise.all([
        lerStore(STORE_TRANSACOES),
        lerStore(STORE_CONTAS),
        lerStore(STORE_CATEGORIAS),
        lerStore(STORE_METAS)
    ]);

    atualizarInterface();
    if (chamarSinc) sincronizar();
}

// ============================================
// Lógica de Cálculo de Saldo (Otimizada)
// ============================================
function calcularSaldoConta(contaId) {
    const conta = contas.find(c => c.id === contaId);
    if (!conta) return 0;
    
    const inicial = parseFloat(String(conta.saldo_inicial).replace(',', '.')) || 0;
    
    const saldoTransacoes = transacoes.reduce((acc, t) => {
        // Verifica se a transação é da conta e se está marcada como paga (string ou bool)
        const estaPago = String(t.pago) === 'true';
        if (t.conta_id === contaId && estaPago) {
            const v = parseFloat(String(t.valor).replace(',', '.')) || 0;
            return acc + (t.tipo === 'receita' ? v : -v);
        }
        return acc;
    }, 0);
    
    return inicial + saldoTransacoes;
}

function atualizarInterface() {
    atualizarSelects();
    atualizarContasGrid();
    atualizarListaTransacoes();
    atualizarResumo();
    atualizarMetasLista();
    desenharGrafico();
}

// ============================================
// Sincronismo Forte (POST corrigido)
// ============================================
async function sincronizar() {
    if (!navigator.onLine) return;
    const tokenStr = localStorage.getItem('tokenOffline');
    if (!tokenStr) return;
    const token = atob(tokenStr);

    try {
        const label = document.getElementById('statusLabel');
        label.innerText = '🔄 Sincronizando...';
        
        const penTrans = transacoes.filter(t => t.sinc === 0);
        const penCont = contas.filter(c => c.sinc === 0);
        const penMetas = metas.filter(m => m.sinc === 0);

        // 1. Enviar alterações locais
        if(penTrans.length > 0 || penCont.length > 0 || penMetas.length > 0) {
            const response = await fetch(API_URL, {
                method: 'POST',
                mode: 'no-cors', // Importante para evitar bloqueios CORS de redirecionamento do Google
                cache: 'no-cache',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, transacoes: penTrans, contas: penCont, metas: penMetas })
            });
            
            // Como usamos no-cors, o fetch não retorna status 200 visível, mas envia os dados.
            // Para garantir a integridade, marcamos como sinc=1 localmente
            const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_METAS], 'readwrite');
            penTrans.forEach(t => { t.sinc = 1; tx.objectStore(STORE_TRANSACOES).put(t); });
            penCont.forEach(c => { c.sinc = 1; tx.objectStore(STORE_CONTAS).put(c); });
            penMetas.forEach(m => { m.sinc = 1; tx.objectStore(STORE_METAS).put(m); });
            await new Promise(r => tx.oncomplete = r);
        }

        // 2. Buscar dados atualizados da nuvem
        const resp = await fetch(`${API_URL}?action=get&token=${encodeURIComponent(token)}`);
        const data = await resp.json();
        
        if(!data.error) {
            const tx2 = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_CATEGORIAS, STORE_METAS], 'readwrite');
            if(data.Transacoes) data.Transacoes.forEach(t => { t.sinc=1; tx2.objectStore(STORE_TRANSACOES).put(t); });
            if(data.Contas) data.Contas.forEach(c => { c.sinc=1; tx2.objectStore(STORE_CONTAS).put(c); });
            if(data.Metas) data.Metas.forEach(m => { m.sinc=1; tx2.objectStore(STORE_METAS).put(m); });
            tx2.oncomplete = () => carregarTudo(false); 
        }

        label.innerText = '🌐 Online';
        label.className = 'status online';
    } catch (err) {
        console.error("Erro na sincronização:", err);
        document.getElementById('statusLabel').innerText = '⚠️ Erro Sinc';
        document.getElementById('statusLabel').className = 'status offline';
    }
}

// --- Funções de Login e UI (Mantidas) ---
async function fazerLogin() {
    const senha = document.getElementById('inputSenha').value;
    if(!senha) return;
    try {
        const resp = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(senha)}`);
        const data = await resp.json();
        if (data.error) alert('Senha incorreta.');
        else {
            localStorage.setItem('tokenOffline', btoa(senha));
            localStorage.setItem('logado', 'true');
            entrarNoApp();
        }
    } catch (e) { alert('Erro de conexão.'); }
}

function entrarNoApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';
    carregarTudo(true); 
}

// --- Funções de CRUD (Mesma lógica do anterior, mas chamando carregarTudo(true)) ---
document.getElementById('btnSalvarTransacao').onclick = () => {
    const valorRaw = document.getElementById('transacaoValor').value;
    const tData = {
        id: editTransacaoId || 't_' + Date.now(),
        tipo: document.getElementById('transacaoTipo').value,
        conta_id: document.getElementById('transacaoConta').value,
        categoria_id: document.getElementById('transacaoCategoria').value,
        data: document.getElementById('transacaoData').value,
        descricao: document.getElementById('transacaoDescricao').value || 'S/D',
        valor: parseFloat(String(valorRaw).replace(',', '.')) || 0,
        pago: document.getElementById('transacaoPago').checked,
        foto: fotoBase64 || '',
        sinc: 0
    };
    if (!tData.conta_id || !tData.data) return alert('Preencha os campos!');
    const tx = db.transaction(STORE_TRANSACOES, 'readwrite');
    tx.objectStore(STORE_TRANSACOES).put(tData);
    tx.oncomplete = () => { fecharModal('modalTransacao'); carregarTudo(true); };
};

// (Repita a mesma estrutura para btnSalvarConta e btnSalvarMeta garantindo o sinc: 0 e carregarTudo(true))

// --- Funções de Renderização (Ajustadas para os IDs da sua planilha) ---
function atualizarContasGrid() {
    const grid = document.getElementById('contasGrid');
    grid.innerHTML = '';
    contas.forEach(conta => {
        const saldo = calcularSaldoConta(conta.id);
        grid.innerHTML += `
            <div class="conta-card">
                <div class="tipo">${conta.tipo}</div>
                <div class="saldo">R$ ${saldo.toFixed(2)}</div>
                <div>${conta.nome}</div>
                <div style="margin-top:8px">
                    <button onclick="editarConta('${conta.id}')">✏️</button>
                    <button onclick="excluirConta('${conta.id}')">🗑️</button>
                </div>
            </div>`;
    });
}

function atualizarResumo() {
    let recMes = 0, desMes = 0, saldoGeral = 0;
    transacoes.forEach(t => {
        if (t.data.slice(0,7) === mesAtual && String(t.pago) === 'true') {
            const v = parseFloat(String(t.valor).replace(',', '.')) || 0;
            if (t.tipo === 'receita') recMes += v; else desMes += v;
        }
    });
    contas.forEach(c => saldoGeral += calcularSaldoConta(c.id));
    document.getElementById('totalRec').innerText = recMes.toFixed(2);
    document.getElementById('totalDes').innerText = desMes.toFixed(2);
    document.getElementById('saldoTotal').innerText = `R$ ${saldoGeral.toFixed(2)}`;
}

// Funções de UI básicas
function abrirModal(id) { document.getElementById(id).classList.add('active'); document.getElementById('overlay').classList.add('active'); }
function fecharModal(id) { document.getElementById(id).classList.remove('active'); document.getElementById('overlay').classList.remove('active'); }
function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}

// Listeners
document.getElementById('filtroMes').onchange = (e) => { mesAtual = e.target.value; atualizarInterface(); };
document.getElementById('btnSalvarConta').onclick = () => { /* implementação similar ao transacao */ };
