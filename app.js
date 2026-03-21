// ============================================
// Configurações
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

// Aplica tema salvo
if (temaAtual === 'escuro') document.documentElement.setAttribute('data-theme', 'escuro');

// ============================================
// IndexedDB: Inicialização e carga
// ============================================
const request = indexedDB.open(DB_NAME, 2);
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
    else document.getElementById('loginScreen').style.display = 'flex';
};

request.onerror = (e) => console.error('Erro IndexedDB', e);

// ============================================
// Funções auxiliares
// ============================================
function getStore(storeName, mode = 'readonly') {
    return db.transaction(storeName, mode).objectStore(storeName);
}

async function carregarTudo(chamarSinc = false) {
    transacoes = await getAllFromStore(STORE_TRANSACOES);
    contas = await getAllFromStore(STORE_CONTAS);
    categorias = await getAllFromStore(STORE_CATEGORIAS);
    metas = await getAllFromStore(STORE_METAS);
    atualizarInterface();
    if (chamarSinc && navigator.onLine) sincronizar();
}

function getAllFromStore(storeName) {
    return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
    });
}

function salvarItem(storeName, item, onComplete) {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => { if (onComplete) onComplete(); carregarTudo(true); };
    tx.onerror = (e) => console.error(`Erro ao salvar em ${storeName}`, e);
}

function deletarItem(storeName, id, onComplete) {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => { if (onComplete) onComplete(); carregarTudo(true); };
}

// ============================================
// Sincronização com Google Sheets (CORS corrigido)
// ============================================
async function sincronizar() {
    if (!navigator.onLine) {
        document.getElementById('statusLabel').innerHTML = '📴 Offline';
        document.getElementById('statusLabel').className = 'status offline';
        return;
    }
    const tokenStr = localStorage.getItem('tokenOffline');
    if (!tokenStr) return;
    const token = atob(tokenStr);

    const statusLabel = document.getElementById('statusLabel');
    statusLabel.innerHTML = '🔄 Sincronizando...';
    statusLabel.className = 'status online';

    try {
        // 1. Enviar alterações pendentes
        const pendentesTrans = transacoes.filter(t => t.sinc !== 1);
        const pendentesContas = contas.filter(c => c.sinc !== 1);
        const pendentesMetas = metas.filter(m => m.sinc !== 1);
        
        if (pendentesTrans.length || pendentesContas.length || pendentesMetas.length) {
            const payload = {
                token,
                transacoes: pendentesTrans,
                contas: pendentesContas,
                metas: pendentesMetas
            };
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!result.error) {
                // Marcar como sincronizado
                const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_METAS], 'readwrite');
                pendentesTrans.forEach(t => { t.sinc = 1; tx.objectStore(STORE_TRANSACOES).put(t); });
                pendentesContas.forEach(c => { c.sinc = 1; tx.objectStore(STORE_CONTAS).put(c); });
                pendentesMetas.forEach(m => { m.sinc = 1; tx.objectStore(STORE_METAS).put(m); });
                await new Promise(r => tx.oncomplete = r);
            } else {
                console.warn('Erro no POST:', result.error);
            }
        }

        // 2. Buscar dados atualizados da nuvem
        const getResp = await fetch(`${API_URL}?token=${encodeURIComponent(token)}`);
        const data = await getResp.json();
        if (!data.error) {
            const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_CATEGORIAS, STORE_METAS], 'readwrite');
            if (data.Transacoes) data.Transacoes.forEach(t => tx.objectStore(STORE_TRANSACOES).put({ ...t, sinc: 1 }));
            if (data.Contas) data.Contas.forEach(c => tx.objectStore(STORE_CONTAS).put({ ...c, sinc: 1 }));
            if (data.Categorias) data.Categorias.forEach(c => tx.objectStore(STORE_CATEGORIAS).put(c));
            if (data.Metas) data.Metas.forEach(m => tx.objectStore(STORE_METAS).put({ ...m, sinc: 1 }));
            await new Promise(r => tx.oncomplete = r);
            await carregarTudo(false);
        }
        statusLabel.innerHTML = '🌐 Online';
    } catch (err) {
        console.error('Erro sincronização:', err);
        statusLabel.innerHTML = '⚠️ Erro Sinc';
        statusLabel.className = 'status offline';
    }
}

// ============================================
// Login
// ============================================
async function fazerLogin() {
    const senha = document.getElementById('inputSenha').value;
    if (!senha) return;
    try {
        const resp = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(senha)}`);
        const data = await resp.json();
        if (data.error) {
            document.getElementById('loginErro').style.display = 'block';
            document.getElementById('loginErro').innerText = data.error;
        } else {
            localStorage.setItem('tokenOffline', btoa(senha));
            localStorage.setItem('logado', 'true');
            entrarNoApp();
        }
    } catch (e) {
        alert('Erro de conexão. Verifique sua internet.');
    }
}

function entrarNoApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';
    carregarTudo(true);
}

// ============================================
// Cálculo de saldos
// ============================================
function calcularSaldoConta(contaId) {
    const conta = contas.find(c => c.id === contaId);
    if (!conta) return 0;
    let saldo = parseFloat(String(conta.saldo_inicial).replace(',', '.')) || 0;
    transacoes.forEach(t => {
        if (t.conta_id === contaId && (t.pago === true || t.pago === 'true')) {
            const valor = parseFloat(String(t.valor).replace(',', '.')) || 0;
            saldo += t.tipo === 'receita' ? valor : -valor;
        }
    });
    return saldo;
}

// ============================================
// Renderização da UI
// ============================================
function atualizarInterface() {
    atualizarSelects();
    atualizarContasGrid();
    atualizarListaTransacoes();
    atualizarResumo();
    atualizarMetasLista();
    desenharGrafico();
}

function atualizarSelects() {
    const contaSelects = ['transacaoConta', 'metaConta', 'filtroConta', 'filtroGraficoConta'];
    contaSelects.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        const current = select.value;
        select.innerHTML = id === 'filtroConta' ? '<option value="">Todas contas</option>' : '';
        contas.forEach(conta => {
            select.innerHTML += `<option value="${conta.id}">${conta.nome}</option>`;
        });
        if (contas.some(c => c.id === current)) select.value = current;
    });

    const catSelect = document.getElementById('transacaoCategoria');
    if (catSelect) {
        const tipo = document.getElementById('transacaoTipo').value;
        catSelect.innerHTML = '';
        categorias.forEach(cat => {
            if (cat.tipo === tipo || cat.tipo === 'ambos') {
                catSelect.innerHTML += `<option value="${cat.id}">${cat.icone || ''} ${cat.nome}</option>`;
            }
        });
    }
}

function atualizarContasGrid() {
    const grid = document.getElementById('contasGrid');
    if (!grid) return;
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
        const pago = t.pago === true || t.pago === 'true';
        if (t.data.slice(0,7) === mesAtual && pago) {
            const v = parseFloat(String(t.valor).replace(',', '.')) || 0;
            if (t.tipo === 'receita') recMes += v;
            else desMes += v;
        }
    });
    contas.forEach(c => saldoGeral += calcularSaldoConta(c.id));
    document.getElementById('totalRec').innerText = recMes.toFixed(2);
    document.getElementById('totalDes').innerText = desMes.toFixed(2);
    document.getElementById('saldoTotal').innerText = `R$ ${saldoGeral.toFixed(2)}`;
}

function atualizarListaTransacoes() {
    const container = document.getElementById('listaTransacoes');
    if (!container) return;
    const busca = document.getElementById('busca')?.value.toLowerCase() || '';
    const filtroConta = document.getElementById('filtroConta')?.value || '';
    let filtered = transacoes.filter(t => t.data.slice(0,7) === mesAtual);
    if (busca) filtered = filtered.filter(t => t.descricao?.toLowerCase().includes(busca));
    if (filtroConta) filtered = filtered.filter(t => t.conta_id === filtroConta);
    filtered.sort((a,b) => (b.data || '').localeCompare(a.data || ''));

    container.innerHTML = '';
    filtered.forEach(t => {
        const categoria = categorias.find(c => c.id === t.categoria_id) || { nome: 'Sem categoria', icone: '❓' };
        const conta = contas.find(c => c.id === t.conta_id) || { nome: 'Conta removida' };
        const valor = parseFloat(String(t.valor).replace(',', '.')) || 0;
        const valorFormatado = `R$ ${valor.toFixed(2)}`;
        const classeValor = t.tipo === 'receita' ? 'receita' : 'despesa';
        const sinal = t.tipo === 'receita' ? '+' : '-';
        container.innerHTML += `
            <div class="transacao-item">
                ${t.foto ? `<img class="mini-foto" src="${t.foto}" onclick="abrirZoom('${t.foto}')">` : '<div class="mini-foto" style="background:#ccc;"></div>'}
                <div class="info">
                    <div class="desc">${t.descricao || 'Sem descrição'}</div>
                    <div class="categoria">${categoria.icone} ${categoria.nome} • ${conta.nome}</div>
                    <small>${new Date(t.data).toLocaleDateString()}</small>
                </div>
                <div class="valor ${classeValor}">${sinal} ${valorFormatado}</div>
                <div>
                    <button onclick="editarTransacao('${t.id}')">✏️</button>
                    <button onclick="excluirTransacao('${t.id}')">🗑️</button>
                </div>
            </div>`;
    });
    if (filtered.length === 0) container.innerHTML = '<p style="text-align:center;">Nenhuma transação neste período.</p>';
}

function atualizarMetasLista() {
    const container = document.getElementById('metasLista');
    if (!container) return;
    container.innerHTML = '';
    metas.forEach(meta => {
        const conta = contas.find(c => c.id === meta.conta_id);
        const saldoConta = conta ? calcularSaldoConta(conta.id) : 0;
        const progresso = (saldoConta / meta.valor_objetivo) * 100;
        container.innerHTML += `
            <div class="conta-card">
                <div><strong>${meta.nome}</strong></div>
                <div>Objetivo: R$ ${Number(meta.valor_objetivo).toFixed(2)}</div>
                <div>Atual: R$ ${saldoConta.toFixed(2)} (${progresso.toFixed(1)}%)</div>
                <div>Conta: ${conta?.nome || 'Não definida'}</div>
                <div>Limite: ${meta.data_limite ? new Date(meta.data_limite).toLocaleDateString() : 'Sem prazo'}</div>
                <div style="margin-top:8px">
                    <button onclick="editarMeta('${meta.id}')">✏️</button>
                    <button onclick="excluirMeta('${meta.id}')">🗑️</button>
                </div>
            </div>`;
    });
    if (metas.length === 0) container.innerHTML = '<p>Nenhuma meta cadastrada.</p>';
}

function desenharGrafico() {
    const canvas = document.getElementById('meuGrafico');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const contaFiltro = document.getElementById('filtroGraficoConta')?.value || '';
    let dados = transacoes.filter(t => t.data.slice(0,7) === mesAtual);
    if (contaFiltro) dados = dados.filter(t => t.conta_id === contaFiltro);
    
    const categoriasReceita = {}, categoriasDespesa = {};
    dados.forEach(t => {
        const cat = categorias.find(c => c.id === t.categoria_id);
        const nomeCat = cat ? cat.nome : 'Outros';
        const valor = parseFloat(String(t.valor).replace(',', '.')) || 0;
        if (t.tipo === 'receita') {
            categoriasReceita[nomeCat] = (categoriasReceita[nomeCat] || 0) + valor;
        } else {
            categoriasDespesa[nomeCat] = (categoriasDespesa[nomeCat] || 0) + valor;
        }
    });
    
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [...new Set([...Object.keys(categoriasReceita), ...Object.keys(categoriasDespesa)])],
            datasets: [
                { label: 'Receitas', data: Object.values(categoriasReceita), backgroundColor: '#16a34a' },
                { label: 'Despesas', data: Object.values(categoriasDespesa), backgroundColor: '#dc2626' }
            ]
        },
        options: { responsive: true, maintainAspectRatio: true }
    });
}

// ============================================
// CRUD Transações
// ============================================
function abrirModalTransacao(transacaoId = null) {
    editTransacaoId = transacaoId;
    document.getElementById('modalTransacaoTitle').innerText = transacaoId ? 'Editar transação' : 'Nova transação';
    if (transacaoId) {
        const t = transacoes.find(t => t.id === transacaoId);
        if (t) {
            document.getElementById('transacaoTipo').value = t.tipo;
            document.getElementById('transacaoConta').value = t.conta_id;
            document.getElementById('transacaoData').value = t.data;
            document.getElementById('transacaoDescricao').value = t.descricao;
            document.getElementById('transacaoValor').value = t.valor;
            document.getElementById('transacaoPago').checked = t.pago === true || t.pago === 'true';
            fotoBase64 = t.foto || null;
            if (fotoBase64) {
                document.getElementById('fotoPreview').src = fotoBase64;
                document.getElementById('fotoPreview').style.display = 'block';
            }
            atualizarSelects(); // para carregar categorias corretas
            document.getElementById('transacaoCategoria').value = t.categoria_id;
        }
    } else {
        document.getElementById('transacaoTipo').value = 'despesa';
        document.getElementById('transacaoData').value = new Date().toISOString().slice(0,10);
        document.getElementById('transacaoDescricao').value = '';
        document.getElementById('transacaoValor').value = '';
        document.getElementById('transacaoPago').checked = true;
        fotoBase64 = null;
        document.getElementById('fotoPreview').style.display = 'none';
        atualizarSelects();
    }
    abrirModal('modalTransacao');
}

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
    if (!tData.conta_id || !tData.data) return alert('Preencha conta e data!');
    salvarItem(STORE_TRANSACOES, tData, () => fecharModal('modalTransacao'));
};

function editarTransacao(id) { abrirModalTransacao(id); }
function excluirTransacao(id) { if (confirm('Excluir esta transação?')) deletarItem(STORE_TRANSACOES, id); }

// ============================================
// CRUD Contas
// ============================================
document.getElementById('btnSalvarConta').onclick = () => {
    const conta = {
        id: editContaId || 'conta_' + Date.now(),
        nome: document.getElementById('contaNome').value,
        tipo: document.getElementById('contaTipo').value,
        saldo_inicial: parseFloat(document.getElementById('contaSaldoInicial').value) || 0,
        vencimento: document.getElementById('contaVencimento').value || '',
        limite: 0,
        sinc: 0
    };
    if (!conta.nome) return alert('Nome da conta é obrigatório');
    salvarItem(STORE_CONTAS, conta, () => {
        fecharModal('modalConta');
        editContaId = null;
    });
};

function editarConta(id) {
    editContaId = id;
    const conta = contas.find(c => c.id === id);
    if (conta) {
        document.getElementById('contaNome').value = conta.nome;
        document.getElementById('contaTipo').value = conta.tipo;
        document.getElementById('contaSaldoInicial').value = conta.saldo_inicial;
        document.getElementById('contaVencimento').value = conta.vencimento || '';
        abrirModal('modalConta');
    }
}
function excluirConta(id) {
    if (confirm('Excluir conta? Todas as transações associadas também serão apagadas.')) {
        const tx = db.transaction([STORE_CONTAS, STORE_TRANSACOES], 'readwrite');
        tx.objectStore(STORE_CONTAS).delete(id);
        const transacoesDaConta = transacoes.filter(t => t.conta_id === id);
        transacoesDaConta.forEach(t => tx.objectStore(STORE_TRANSACOES).delete(t.id));
        tx.oncomplete = () => carregarTudo(true);
    }
}

// ============================================
// CRUD Metas
// ============================================
function abrirModalMeta(metaId = null) {
    editMetaId = metaId;
    if (metaId) {
        const meta = metas.find(m => m.id === metaId);
        if (meta) {
            document.getElementById('metaNome').value = meta.nome;
            document.getElementById('metaValorObjetivo').value = meta.valor_objetivo;
            document.getElementById('metaDataLimite').value = meta.data_limite;
            document.getElementById('metaConta').value = meta.conta_id;
        }
    } else {
        document.getElementById('metaNome').value = '';
        document.getElementById('metaValorObjetivo').value = '';
        document.getElementById('metaDataLimite').value = '';
        document.getElementById('metaConta').value = '';
    }
    abrirModal('modalMeta');
}

document.getElementById('btnSalvarMeta').onclick = () => {
    const meta = {
        id: editMetaId || 'meta_' + Date.now(),
        nome: document.getElementById('metaNome').value,
        valor_objetivo: parseFloat(document.getElementById('metaValorObjetivo').value) || 0,
        data_limite: document.getElementById('metaDataLimite').value,
        conta_id: document.getElementById('metaConta').value,
        valor_atual: 0,
        sinc: 0
    };
    if (!meta.nome || !meta.conta_id) return alert('Preencha nome e conta');
    salvarItem(STORE_METAS, meta, () => {
        fecharModal('modalMeta');
        editMetaId = null;
    });
};

function editarMeta(id) { abrirModalMeta(id); }
function excluirMeta(id) { if (confirm('Excluir meta?')) deletarItem(STORE_METAS, id); }

// ============================================
// Exportar CSV
// ============================================
document.getElementById('btnConfirmarExportar').onclick = () => {
    const ini = document.getElementById('exportDataIni').value;
    const fim = document.getElementById('exportDataFim').value;
    if (!ini || !fim) return alert('Selecione o período');
    let filtered = transacoes.filter(t => t.data >= ini && t.data <= fim);
    if (filtered.length === 0) return alert('Nenhuma transação no período');
    const csvRows = [['ID','Data','Descrição','Valor','Tipo','Categoria','Conta','Pago']];
    filtered.forEach(t => {
        const cat = categorias.find(c => c.id === t.categoria_id)?.nome || '';
        const conta = contas.find(c => c.id === t.conta_id)?.nome || '';
        csvRows.push([
            t.id, t.data, t.descricao, t.valor, t.tipo, cat, conta, t.pago
        ]);
    });
    const csv = csvRows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `financas_${ini}_${fim}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
};

// ============================================
// UI Auxiliares
// ============================================
function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}

function abrirModal(id) {
    document.getElementById(id).classList.add('active');
    document.getElementById('overlay').classList.add('active');
}
function fecharModal(id) {
    document.getElementById(id).classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}
function fecharTodasModals() {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    document.getElementById('overlay').classList.remove('active');
}
function abrirZoom(imgSrc) {
    document.getElementById('zoomedImg').src = imgSrc;
    document.getElementById('zoomOverlay').classList.add('active');
}
function fecharZoom() {
    document.getElementById('zoomOverlay').classList.remove('active');
}

// Navegação entre telas
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.getAttribute('data-view');
        document.getElementById('viewResumo').style.display = view === 'resumo' ? 'block' : 'none';
        document.getElementById('viewGrafico').style.display = view === 'grafico' ? 'block' : 'none';
        document.getElementById('viewMetas').style.display = view === 'metas' ? 'block' : 'none';
        if (view === 'grafico') desenharGrafico();
    };
});

document.getElementById('fabAdd').onclick = () => abrirModalTransacao();
document.getElementById('btnLogin').onclick = fazerLogin;
document.getElementById('transacaoTipo').onchange = () => atualizarSelects();
document.getElementById('filtroMes').onchange = (e) => { mesAtual = e.target.value; atualizarInterface(); };
document.getElementById('busca').oninput = () => atualizarListaTransacoes();
document.getElementById('filtroConta').onchange = () => atualizarListaTransacoes();
document.getElementById('filtroGraficoConta').onchange = () => desenharGrafico();
document.getElementById('fotoInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            fotoBase64 = ev.target.result;
            document.getElementById('fotoPreview').src = fotoBase64;
            document.getElementById('fotoPreview').style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
};

// Sincronização automática quando online
window.addEventListener('online', () => sincronizar());
setInterval(() => { if (navigator.onLine) sincronizar(); }, 60000);
