// ============================================
// Configurações globais
// ============================================
// Lembre-se de usar a URL do seu Google Apps Script!
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

// ============================================
// Inicialização do IndexedDB
// ============================================
const request = indexedDB.open(DB_NAME, 1);
request.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_TRANSACOES)) db.createObjectStore(STORE_TRANSACOES, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_CONTAS)) db.createObjectStore(STORE_CONTAS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_METAS)) db.createObjectStore(STORE_METAS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_CATEGORIAS)) {
        const storeCat = db.createObjectStore(STORE_CATEGORIAS, { keyPath: 'id' });
        storeCat.put({ id: 'cat1', nome: 'Salário', tipo: 'receita', icone: '💰' });
        storeCat.put({ id: 'cat2', nome: 'Alimentação', tipo: 'despesa', icone: '🍔' });
        storeCat.put({ id: 'cat3', nome: 'Transporte', tipo: 'despesa', icone: '🚗' });
        storeCat.put({ id: 'cat4', nome: 'Lazer', tipo: 'despesa', icone: '🎬' });
        storeCat.put({ id: 'cat5', nome: 'Moradia', tipo: 'despesa', icone: '🏠' });
        storeCat.put({ id: 'cat6', nome: 'Investimentos', tipo: 'receita', icone: '📈' });
        storeCat.put({ id: 'cat7', nome: 'Outros', tipo: 'ambos', icone: '📦' });
    }
};
request.onsuccess = (e) => {
    db = e.target.result;
    document.getElementById('filtroMes').value = mesAtual;
    if (localStorage.getItem('logado') === 'true') {
        entrarNoApp();
    }
};
request.onerror = (e) => console.error('Erro IndexedDB', e);

// ============================================
// Login
// ============================================
async function fazerLogin() {
    const senha = document.getElementById('inputSenha').value;
    const btn = document.getElementById('btnLogin');
    const erroMsg = document.getElementById('loginErro');
    
    if(!senha) return;
    erroMsg.style.display = 'none';

    if (!navigator.onLine) {
        if (localStorage.getItem('tokenOffline') === btoa(senha)) entrarNoApp();
        else { erroMsg.innerText = 'Offline: Senha não salva.'; erroMsg.style.display = 'block'; }
        return;
    }

    btn.innerText = 'Verificando...'; btn.disabled = true;

    try {
        const resp = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(senha)}`);
        const data = await resp.json();
        
        if (data.error) {
            erroMsg.innerText = 'Senha incorreta.'; erroMsg.style.display = 'block';
        } else {
            localStorage.setItem('tokenOffline', btoa(senha));
            localStorage.setItem('logado', 'true');
            entrarNoApp();
        }
    } catch (e) {
        erroMsg.innerText = 'Erro de conexão.'; erroMsg.style.display = 'block';
    } finally {
        btn.innerText = 'Entrar'; btn.disabled = false;
    }
}

function entrarNoApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';
    carregarTudo(true); 
}

if (localStorage.getItem('logado') === 'true') {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';
}

// ============================================
// Core: Carregar Interface Local
// ============================================
function carregarTudo(chamarSinc = false) {
    const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_CATEGORIAS, STORE_METAS], 'readonly');
    tx.objectStore(STORE_TRANSACOES).getAll().onsuccess = (e) => { transacoes = e.target.result; };
    tx.objectStore(STORE_CONTAS).getAll().onsuccess = (e) => { contas = e.target.result; };
    tx.objectStore(STORE_CATEGORIAS).getAll().onsuccess = (e) => { categorias = e.target.result; };
    tx.objectStore(STORE_METAS).getAll().onsuccess = (e) => { 
        metas = e.target.result;
        atualizarInterface();
        if (chamarSinc) sincronizar(); 
    };
}

function atualizarInterface() {
    atualizarSelects();
    atualizarContasGrid();
    atualizarListaTransacoes();
    atualizarResumo();
    atualizarMetasLista();
    desenharGrafico();
}

function atualizarSelects() {
    let optConta = '<option value="">Selecione uma conta</option>';
    let optFiltro = '<option value="">Todas contas</option>';
    contas.forEach(c => {
        optConta += `<option value="${c.id}">${c.nome}</option>`;
        optFiltro += `<option value="${c.id}">${c.nome}</option>`;
    });

    document.getElementById('transacaoConta').innerHTML = optConta;
    document.getElementById('metaConta').innerHTML = optConta;
    document.getElementById('filtroConta').innerHTML = optFiltro;
    document.getElementById('filtroGraficoConta').innerHTML = optFiltro;

    let optCat = '<option value="">Selecione a categoria</option>';
    categorias.forEach(c => optCat += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
    document.getElementById('transacaoCategoria').innerHTML = optCat;
}

// ============================================
// Lógica de Saldo
// ============================================
function calcularSaldoConta(contaId) {
    const conta = contas.find(c => c.id === contaId);
    const inicial = conta ? (parseFloat(conta.saldo_inicial) || 0) : 0;
    
    const saldoTransacoes = transacoes.reduce((acc, t) => {
        if (t.conta_id === contaId && t.pago !== false) {
            const v = parseFloat(t.valor) || 0;
            return acc + (t.tipo === 'receita' ? v : -v);
        }
        return acc;
    }, 0);
    
    return inicial + saldoTransacoes;
}

function atualizarResumo() {
    let recMes = 0, desMes = 0, saldoGeral = 0;
    
    transacoes.forEach(t => {
        if (t.data.slice(0,7) === mesAtual && t.pago !== false) {
            const v = parseFloat(t.valor) || 0;
            if (t.tipo === 'receita') recMes += v; else desMes += v;
        }
    });
    
    contas.forEach(c => { saldoGeral += calcularSaldoConta(c.id); });

    document.getElementById('totalRec').innerText = recMes.toFixed(2);
    document.getElementById('totalDes').innerText = desMes.toFixed(2);
    document.getElementById('saldoTotal').innerText = `R$ ${saldoGeral.toFixed(2)}`;
}

function atualizarContasGrid() {
    const grid = document.getElementById('contasGrid');
    grid.innerHTML = '';
    contas.sort((a,b) => a.nome.localeCompare(b.nome)).forEach(conta => {
        const saldo = calcularSaldoConta(conta.id);
        grid.innerHTML += `
            <div class="conta-card">
                <div class="tipo">${conta.tipo}</div>
                <div class="saldo">R$ ${saldo.toFixed(2)}</div>
                <div>${conta.nome}</div>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <button onclick="editarConta('${conta.id}')" style="background:none; border:none; font-size:16px; cursor:pointer;">✏️</button>
                    <button onclick="excluirConta('${conta.id}')" style="background:none; border:none; font-size:16px; cursor:pointer;">🗑️</button>
                </div>
            </div>
        `;
    });
}

function atualizarListaTransacoes() {
    const busca = document.getElementById('busca').value.toLowerCase();
    const cFiltro = document.getElementById('filtroConta').value;
    
    const filtradas = transacoes.filter(t => {
        if (t.data.slice(0,7) !== mesAtual) return false;
        if (cFiltro && t.conta_id !== cFiltro) return false;
        const desc = (t.descricao || '').toLowerCase();
        const cat = categorias.find(c => c.id === t.categoria_id)?.nome || '';
        return desc.includes(busca) || cat.toLowerCase().includes(busca);
    });

    filtradas.sort((a,b) => b.data.localeCompare(a.data));
    const lista = document.getElementById('listaTransacoes');
    lista.innerHTML = '';
    filtradas.forEach(t => {
        const conta = contas.find(c => c.id === t.conta_id) || { nome: '?' };
        const categoria = categorias.find(c => c.id === t.categoria_id) || { nome: '?', icone: '📌' };
        const v = parseFloat(t.valor) || 0;
        lista.innerHTML += `
            <div class="transacao-item">
                <img class="mini-foto" src="${t.foto || 'https://via.placeholder.com/50?text=S/F'}" onclick="abrirZoom('${t.foto}')">
                <div class="info">
                    <div class="desc">${t.descricao}</div>
                    <div class="categoria">${categoria.icone} ${categoria.nome} · ${conta.nome}</div>
                    <span style="font-size:10px; color:${t.pago ? 'var(--s)' : 'var(--d)'}">${t.pago ? '✔ Pago' : '⏳ Pendente'}</span>
                </div>
                <div class="valor ${t.tipo}">R$ ${v.toFixed(2)}</div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <button onclick="editarTransacao('${t.id}')" style="border:none; background:none; cursor:pointer;">✏️</button>
                    <button onclick="excluirTransacao('${t.id}')" style="border:none; background:none; cursor:pointer;">🗑️</button>
                </div>
            </div>
        `;
    });
}

function atualizarMetasLista() {
    const div = document.getElementById('metasLista');
    div.innerHTML = '';
    metas.forEach(m => {
        const progresso = m.valor_objetivo > 0 ? (m.valor_atual / m.valor_objetivo * 100).toFixed(1) : 0;
        div.innerHTML += `
            <div style="background: var(--card); border-radius: 20px; padding: 16px; margin-bottom: 12px; border: 1px solid var(--border);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <h4 style="margin: 0;">${m.nome}</h4>
                    <div style="display: flex; gap: 8px;">
                        <button onclick="editarMeta('${m.id}')" style="background: none; border: none; font-size: 16px; cursor:pointer;">✏️</button>
                        <button onclick="excluirMeta('${m.id}')" style="background: none; border: none; font-size: 16px; cursor:pointer;">🗑️</button>
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 8px;">
                    <span>R$ ${m.valor_atual || 0} / R$ ${m.valor_objetivo}</span>
                    <span>${progresso}%</span>
                </div>
                <progress value="${m.valor_atual || 0}" max="${m.valor_objetivo}" style="width:100%; height:12px; border-radius: 10px;"></progress>
            </div>
        `;
    });
}

function desenharGrafico() {
    const ctx = document.getElementById('meuGrafico').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    const contaFiltro = document.getElementById('filtroGraficoConta').value;
    const despesasPorCategoria = {};
    
    transacoes.forEach(t => {
        if (t.tipo !== 'despesa') return;
        if (contaFiltro && t.conta_id !== contaFiltro) return;
        if (t.data.slice(0,7) !== mesAtual) return;
        
        const cat = categorias.find(c => c.id === t.categoria_id)?.nome || 'Outros';
        despesasPorCategoria[cat] = (despesasPorCategoria[cat] || 0) + parseFloat(t.valor);
    });

    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(despesasPorCategoria),
            datasets: [{
                data: Object.values(despesasPorCategoria),
                backgroundColor: ['#f43f5e', '#8b5cf6', '#10b981', '#f59e0b', '#3b82f6', '#6366f1']
            }]
        },
        options: { plugins: { legend: { position: 'bottom' } } }
    });
}

// ============================================
// Salvamento e Edição (Contas, Transações, Metas)
// ============================================
document.getElementById('btnSalvarConta').onclick = () => {
    const id = editContaId || 'conta_' + Date.now();
    const conta = {
        id: id,
        nome: document.getElementById('contaNome').value,
        tipo: document.getElementById('contaTipo').value,
        saldo_inicial: parseFloat(document.getElementById('contaSaldoInicial').value) || 0,
        vencimento: document.getElementById('contaVencimento').value || '',
        sinc: 0
    };
    if (!conta.nome) return alert('Nome obrigatório');
    const tx = db.transaction(STORE_CONTAS, 'readwrite');
    tx.objectStore(STORE_CONTAS).put(conta);
    tx.oncomplete = () => {
        fecharModal('modalConta');
        carregarTudo(true); 
    };
};

function editarConta(id) {
    const c = contas.find(c => c.id === id);
    if (!c) return;
    editContaId = id;
    document.getElementById('contaNome').value = c.nome;
    document.getElementById('contaTipo').value = c.tipo;
    document.getElementById('contaSaldoInicial').value = c.saldo_inicial || 0;
    document.getElementById('contaVencimento').value = c.vencimento || '';
    abrirModal('modalConta');
}

function excluirConta(id) {
    if(confirm('Apagar conta e todas as transações vinculadas?')) {
        const tx = db.transaction([STORE_CONTAS, STORE_TRANSACOES], 'readwrite');
        tx.objectStore(STORE_CONTAS).delete(id);
        transacoes.filter(t => t.conta_id === id).forEach(t => {
            tx.objectStore(STORE_TRANSACOES).delete(t.id);
        });
        tx.oncomplete = () => carregarTudo(true);
    }
}

document.getElementById('btnSalvarTransacao').onclick = () => {
    const tData = {
        tipo: document.getElementById('transacaoTipo').value,
        conta_id: document.getElementById('transacaoConta').value,
        categoria_id: document.getElementById('transacaoCategoria').value,
        data: document.getElementById('transacaoData').value,
        descricao: document.getElementById('transacaoDescricao').value || 'S/D',
        valor: parseFloat(document.getElementById('transacaoValor').value) || 0,
        pago: document.getElementById('transacaoPago').checked
    };
    if (!tData.conta_id || !tData.categoria_id || !tData.data) return alert('Preencha conta, categoria e data!');
    
    const tx = db.transaction(STORE_TRANSACOES, 'readwrite');
    const obj = { ...tData, id: editTransacaoId || 't_' + Date.now(), foto: fotoBase64 || '', sinc: 0 };
    
    tx.objectStore(STORE_TRANSACOES).put(obj);
    tx.oncomplete = () => {
        fecharModal('modalTransacao');
        carregarTudo(true);
    };
};

function editarTransacao(id) {
    const t = transacoes.find(t => t.id === id);
    if (!t) return;
    editTransacaoId = id;
    document.getElementById('transacaoTipo').value = t.tipo;
    document.getElementById('transacaoConta').value = t.conta_id || '';
    document.getElementById('transacaoCategoria').value = t.categoria_id || '';
    document.getElementById('transacaoData').value = t.data;
    document.getElementById('transacaoDescricao').value = t.descricao;
    document.getElementById('transacaoValor').value = t.valor;
    document.getElementById('transacaoPago').checked = t.pago !== false;
    
    if (t.foto) {
        fotoBase64 = t.foto;
        document.getElementById('fotoPreview').src = t.foto;
        document.getElementById('fotoPreview').style.display = 'block';
    } else {
        fotoBase64 = null;
        document.getElementById('fotoPreview').style.display = 'none';
    }
    document.getElementById('parcelasContainer').style.display = 'none'; 
    abrirModal('modalTransacao');
}

function excluirTransacao(id) {
    if(confirm('Apagar transação?')) {
        const tx = db.transaction(STORE_TRANSACOES, 'readwrite');
        tx.objectStore(STORE_TRANSACOES).delete(id);
        tx.oncomplete = () => carregarTudo(true);
    }
}

document.getElementById('btnSalvarMeta').onclick = () => {
    const meta = {
        id: editMetaId || 'meta_' + Date.now(),
        nome: document.getElementById('metaNome').value,
        valor_objetivo: parseFloat(document.getElementById('metaValorObjetivo').value) || 0,
        valor_atual: editMetaId ? (metas.find(m => m.id === editMetaId)?.valor_atual || 0) : 0,
        data_limite: document.getElementById('metaDataLimite').value,
        conta_id: document.getElementById('metaConta').value,
        sinc: 0
    };
    if (!meta.nome || meta.valor_objetivo <= 0) return alert('Preencha nome e valor objetivo');
    const tx = db.transaction(STORE_METAS, 'readwrite');
    tx.objectStore(STORE_METAS).put(meta);
    tx.oncomplete = () => {
        fecharModal('modalMeta');
        carregarTudo(true);
    };
};

function editarMeta(id) {
    const m = metas.find(m => m.id === id);
    if (!m) return;
    editMetaId = id;
    document.getElementById('metaNome').value = m.nome;
    document.getElementById('metaValorObjetivo').value = m.valor_objetivo;
    document.getElementById('metaDataLimite').value = m.data_limite || '';
    document.getElementById('metaConta').value = m.conta_id || '';
    abrirModal('modalMeta');
}

function excluirMeta(id) {
    if(confirm('Tem certeza que deseja remover esta meta?')) {
        const tx = db.transaction(STORE_METAS, 'readwrite');
        tx.objectStore(STORE_METAS).delete(id);
        tx.oncomplete = () => carregarTudo(true);
    }
}

// ============================================
// Sincronismo Forte (Nuvem)
// ============================================
async function sincronizar() {
    if (!navigator.onLine) return;
    const tokenStr = localStorage.getItem('tokenOffline');
    if (!tokenStr) return;
    const token = atob(tokenStr);

    try {
        document.getElementById('statusLabel').innerText = '🔄 Sincronizando...';
        
        const penTrans = transacoes.filter(t => t.sinc === 0);
        const penCont = contas.filter(c => c.sinc === 0);
        const penMetas = metas.filter(m => m.sinc === 0);

        if(penTrans.length > 0 || penCont.length > 0 || penMetas.length > 0) {
            await fetch(API_URL, {
                method: 'POST',
                body: JSON.stringify({ token, transacoes: penTrans, contas: penCont, metas: penMetas })
            });
            const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_METAS], 'readwrite');
            penTrans.forEach(t => { t.sinc = 1; tx.objectStore(STORE_TRANSACOES).put(t); });
            penCont.forEach(c => { c.sinc = 1; tx.objectStore(STORE_CONTAS).put(c); });
            penMetas.forEach(m => { m.sinc = 1; tx.objectStore(STORE_METAS).put(m); });
        }

        const resp = await fetch(`${API_URL}?action=get&token=${encodeURIComponent(token)}`);
        const data = await resp.json();
        
        if(!data.error) {
            const tx2 = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_CATEGORIAS, STORE_METAS], 'readwrite');
            if(data.Transacoes) data.Transacoes.forEach(t => { t.sinc=1; t.pago = (t.pago === 'true' || t.pago === true); tx2.objectStore(STORE_TRANSACOES).put(t); });
            if(data.Contas) data.Contas.forEach(c => { c.sinc=1; tx2.objectStore(STORE_CONTAS).put(c); });
            if(data.Metas) data.Metas.forEach(m => { m.sinc=1; tx2.objectStore(STORE_METAS).put(m); });
            if(data.Categorias && data.Categorias.length > 0) data.Categorias.forEach(c => tx2.objectStore(STORE_CATEGORIAS).put(c));
            
            tx2.oncomplete = () => carregarTudo(false); 
        }

        document.getElementById('statusLabel').innerText = '🌐 Online';
        document.getElementById('statusLabel').className = 'status online';
    } catch (err) {
        document.getElementById('statusLabel').innerText = '⚠️ Erro Sinc';
        document.getElementById('statusLabel').className = 'status offline';
    }
}

// ============================================
// Utilitários Extras e Interface
// ============================================
function abrirModal(id) { document.getElementById(id).classList.add('active'); document.getElementById('overlay').classList.add('active'); }
function fecharModal(id) { document.getElementById(id).classList.remove('active'); document.getElementById('overlay').classList.remove('active'); }
function abrirZoom(src) { if(src && src.startsWith('data:')){ document.getElementById('zoomedImg').src = src; abrirModal('zoomOverlay'); } }
function fecharZoom() { fecharModal('zoomOverlay'); }

document.getElementById('fotoInput').onchange = (e) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX = 800;
            const scale = MAX / Math.max(img.width, img.height);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            fotoBase64 = canvas.toDataURL('image/jpeg', 0.7);
            document.getElementById('fotoPreview').src = fotoBase64;
            document.getElementById('fotoPreview').style.display = 'block';
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(e.target.files[0]);
};

document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const v = btn.dataset.view;
        document.getElementById('viewResumo').style.display = v === 'resumo' ? 'block' : 'none';
        document.getElementById('viewGrafico').style.display = v === 'grafico' ? 'block' : 'none';
        document.getElementById('viewMetas').style.display = v === 'metas' ? 'block' : 'none';
        if (v === 'grafico') desenharGrafico();
    });
});

document.getElementById('fabAdd').onclick = () => {
    editTransacaoId = null; fotoBase64 = null;
    document.getElementById('fotoPreview').style.display = 'none';
    document.getElementById('transacaoPago').checked = true;
    document.getElementById('transacaoDescricao').value = '';
    document.getElementById('transacaoValor').value = '';
    document.getElementById('transacaoData').value = new Date().toISOString().slice(0, 10);
    abrirModal('modalTransacao');
};

function abrirModalMeta() {
    editMetaId = null;
    document.getElementById('metaNome').value = '';
    document.getElementById('metaValorObjetivo').value = '';
    document.getElementById('metaDataLimite').value = '';
    document.getElementById('metaConta').value = '';
    abrirModal('modalMeta');
}

function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}
if(temaAtual === 'escuro') document.documentElement.setAttribute('data-theme', 'escuro');

document.getElementById('filtroMes').addEventListener('change', (e) => { mesAtual = e.target.value; atualizarInterface(); });
document.getElementById('busca').addEventListener('input', atualizarListaTransacoes);
document.getElementById('filtroConta').addEventListener('change', atualizarListaTransacoes);
document.getElementById('filtroGraficoConta').addEventListener('change', desenharGrafico);

document.getElementById('transacaoTipo').addEventListener('change', (e) => {
    document.getElementById('parcelasContainer').style.display = e.target.value === 'despesa' ? 'block' : 'none';
});

document.getElementById('btnConfirmarExportar').onclick = () => {
    const dataIni = document.getElementById('exportDataIni').value;
    const dataFim = document.getElementById('exportDataFim').value;

    if (!dataIni || !dataFim) {
        alert('Selecione as datas para continuar!');
        return;
    }

    const transacoesFiltradas = transacoes.filter(t => t.data >= dataIni && t.data <= dataFim);
    
    if (transacoesFiltradas.length === 0) {
        alert('Nenhuma transação encontrada no período.');
        return;
    }

    const linhas = transacoesFiltradas.map(t => {
        const conta = contas.find(c => c.id === t.conta_id)?.nome || '';
        const cat = categorias.find(c => c.id === t.categoria_id)?.nome || '';
        return `${t.data},${cat},${t.descricao},${t.valor},${t.tipo},${conta}`;
    }).join('\n');
    
    const blob = new Blob(['data,categoria,descricao,valor,tipo,conta\n' + linhas], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `relatorio_${dataIni}_ate_${dataFim}.csv`;
    a.click();
    
    fecharModal('modalExportar');
};
