// ============================================
// Configurações globais
// ============================================
const API_URL = 'https://script.google.com/macros/s/AKfycbweYsdwHphUf1hdNjr9ZJGxR6TlNG27C1w45lI-164s2FhSH7LUAMZk6-_GpnN_cXGE/exec'; // substitua pelo seu
const DB_NAME = 'financas_familiar_v2';
const STORE_TRANSACOES = 'transacoes';
const STORE_CONTAS = 'contas';
const STORE_CATEGORIAS = 'categorias';
const STORE_METAS = 'metas';

let db;
let transacoes = [], contas = [], categorias = [], metas = [];
let chartInstance = null;
let fotoBase64 = null;
let editTransacaoId = null;
let editContaId = null;
let editMetaId = null;
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';

// ============================================
// Inicialização do IndexedDB
// ============================================
const request = indexedDB.open(DB_NAME, 1);
request.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_TRANSACOES)) {
        const store = db.createObjectStore(STORE_TRANSACOES, { keyPath: 'id' });
        store.createIndex('data', 'data');
        store.createIndex('conta_id', 'conta_id');
        store.createIndex('pago', 'pago');
    }
    if (!db.objectStoreNames.contains(STORE_CONTAS)) {
        db.createObjectStore(STORE_CONTAS, { keyPath: 'id' });
    }
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
    if (!db.objectStoreNames.contains(STORE_METAS)) {
        db.createObjectStore(STORE_METAS, { keyPath: 'id' });
    }
};
request.onsuccess = (e) => {
    db = e.target.result;
    document.getElementById('filtroMes').value = mesAtual;
    if (localStorage.getItem('logado') === 'true') {
        carregarTudo();
        sincronizar();
    }
    verificarNotificacoes();
    setInterval(verificarNotificacoes, 3600000); 
};
request.onerror = (e) => console.error('Erro IndexedDB', e);

// ============================================
// Login Seguro via API
// ============================================
async function fazerLogin() {
    const senha = document.getElementById('inputSenha').value;
    const btn = document.getElementById('btnLogin');
    const erroMsg = document.getElementById('loginErro');
    
    if(!senha) return;
    
    erroMsg.style.display = 'none';

    if (!navigator.onLine) {
        if (localStorage.getItem('tokenOffline') === btoa(senha)) {
            entrarNoApp();
        } else {
            erroMsg.innerText = 'Offline: Senha incorreta ou não salva no dispositivo.';
            erroMsg.style.display = 'block';
        }
        return;
    }

    btn.innerText = 'Verificando...';
    btn.disabled = true;

    try {
        const resp = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(senha)}`);
        const data = await resp.json();
        
        if (data.error) {
            erroMsg.innerText = 'Senha incorreta.';
            erroMsg.style.display = 'block';
        } else {
            localStorage.setItem('tokenOffline', btoa(senha));
            localStorage.setItem('logado', 'true');
            entrarNoApp();
        }
    } catch (e) {
        erroMsg.innerText = 'Erro ao conectar. Tente novamente.';
        erroMsg.style.display = 'block';
    } finally {
        btn.innerText = 'Entrar';
        btn.disabled = false;
    }
}

function entrarNoApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';
    carregarTudo();
    sincronizar();
}

if (localStorage.getItem('logado') === 'true') {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appMain').style.display = 'block';
}

// ============================================
// Carregar e Atualizar Interface
// ============================================
function carregarTudo() {
    const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_CATEGORIAS, STORE_METAS], 'readonly');
    tx.objectStore(STORE_TRANSACOES).getAll().onsuccess = (e) => {
        transacoes = e.target.result;
        tx.objectStore(STORE_CONTAS).getAll().onsuccess = (e2) => {
            contas = e2.target.result;
            tx.objectStore(STORE_CATEGORIAS).getAll().onsuccess = (e3) => {
                categorias = e3.target.result;
                tx.objectStore(STORE_METAS).getAll().onsuccess = (e4) => {
                    metas = e4.target.result;
                    atualizarInterface();
                };
            };
        };
    };
}

function atualizarInterface() {
    atualizarContasGrid();
    atualizarSelects();
    atualizarListaTransacoes();
    atualizarResumo();
    atualizarMetasLista();
    desenharGrafico();
}

function atualizarContasGrid() {
    const grid = document.getElementById('contasGrid');
    grid.innerHTML = '';
    contas.sort((a,b) => a.nome.localeCompare(b.nome)).forEach(conta => {
        const saldo = calcularSaldoConta(conta.id);
        const card = document.createElement('div');
        card.className = 'conta-card';
        card.innerHTML = `
            <div class="tipo">${conta.tipo}</div>
            <div class="saldo">R$ ${saldo.toFixed(2)}</div>
            <div>${conta.nome}</div>
            ${conta.tipo === 'cartao' && conta.vencimento ? `<div class="vencimento">Vence ${new Date(conta.vencimento).toLocaleDateString()}</div>` : ''}
            <div style="display: flex; gap: 8px; margin-top: 8px;">
                <button onclick="editarConta('${conta.id}')">✏️</button>
                <button onclick="excluirConta('${conta.id}')">🗑️</button>
            </div>
        `;
        grid.appendChild(card);
    });
}

function atualizarSelects() {
    const selects = {
        conta: ['transacaoConta', 'filtroConta', 'filtroGraficoConta', 'metaConta']
    };
    
    let optionsConta = '<option value="">Selecione uma conta</option>';
    let optionsFiltro = '<option value="">Todas contas</option>';
    contas.forEach(c => {
        optionsConta += `<option value="${c.id}">${c.nome}</option>`;
        optionsFiltro += `<option value="${c.id}">${c.nome}</option>`;
    });

    document.getElementById('transacaoConta').innerHTML = optionsConta;
    document.getElementById('metaConta').innerHTML = optionsConta;
    document.getElementById('filtroConta').innerHTML = optionsFiltro;
    document.getElementById('filtroGraficoConta').innerHTML = optionsFiltro;

    const selectCategoria = document.getElementById('transacaoCategoria');
    let optionsCat = '<option value="">Selecione uma categoria</option>';
    categorias.forEach(c => optionsCat += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
    selectCategoria.innerHTML = optionsCat;
}

function atualizarListaTransacoes() {
    const busca = document.getElementById('busca').value.toLowerCase();
    const contaFiltro = document.getElementById('filtroConta').value;
    
    const filtradas = transacoes.filter(t => {
        if (t.data.slice(0,7) !== mesAtual) return false;
        if (contaFiltro && t.conta_id !== contaFiltro) return false;
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
        const valor = parseFloat(t.valor) || 0;
        const item = document.createElement('div');
        item.className = 'transacao-item';
        item.innerHTML = `
            <img class="mini-foto" src="${t.foto || 'https://via.placeholder.com/50?text=S/F'}" onclick="abrirZoom('${t.foto}')">
            <div class="info">
                <div class="desc">${t.descricao}</div>
                <div class="categoria">${categoria.icone} ${categoria.nome} · ${conta.nome}</div>
                ${t.parcela_total ? `<small>${t.parcela_num}/${t.parcela_total}</small>` : ''}
            </div>
            <div class="valor ${t.tipo}">R$ ${valor.toFixed(2)}</div>
            <div style="display: flex; gap: 4px;">
                <button onclick="editarTransacao('${t.id}')">✏️</button>
                <button onclick="excluirTransacao('${t.id}')">🗑️</button>
            </div>
        `;
        lista.appendChild(item);
    });
}

function atualizarResumo() {
    let totalRec = 0, totalDes = 0;
    transacoes.forEach(t => {
        if (t.data.slice(0,7) !== mesAtual) return;
        const v = parseFloat(t.valor) || 0;
        if (t.tipo === 'receita') totalRec += v;
        else totalDes += v;
    });
    document.getElementById('totalRec').innerText = totalRec.toFixed(2);
    document.getElementById('totalDes').innerText = totalDes.toFixed(2);
    document.getElementById('saldoTotal').innerText = `R$ ${(totalRec - totalDes).toFixed(2)}`;
}

function calcularSaldoConta(contaId) {
    return transacoes.reduce((acc, t) => {
        if (t.conta_id === contaId && t.pago !== false) {
            const v = parseFloat(t.valor) || 0;
            return acc + (t.tipo === 'receita' ? v : -v);
        }
        return acc;
    }, 0);
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
                        <button onclick="editarMeta('${m.id}')" style="background: none; border: none; font-size: 16px;">✏️</button>
                        <button onclick="excluirMeta('${m.id}')" style="background: none; border: none; font-size: 16px;">🗑️</button>
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 8px;">
                    <span>R$ ${m.valor_atual} / R$ ${m.valor_objetivo}</span>
                    <span>${progresso}%</span>
                </div>
                <progress value="${m.valor_atual}" max="${m.valor_objetivo}" style="width:100%; height:12px; border-radius: 10px;"></progress>
            </div>
        `;
    });
}

// ============================================
// Gráfico
// ============================================
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
// CRUD Transações
// ============================================
document.getElementById('btnSalvarTransacao').onclick = salvarTransacao;

function salvarTransacao() {
    const tipo = document.getElementById('transacaoTipo').value;
    const conta_id = document.getElementById('transacaoConta').value;
    const categoria_id = document.getElementById('transacaoCategoria').value;
    const data = document.getElementById('transacaoData').value;
    const descricao = document.getElementById('transacaoDescricao').value || 'S/D';
    const valor = parseFloat(document.getElementById('transacaoValor').value) || 0;
    const pago = document.getElementById('transacaoPago').checked;
    const parcelas = parseInt(document.getElementById('parcelasNum').value) || 1;

    if (!conta_id || !categoria_id || !data) {
        alert('Preencha todos os campos obrigatórios');
        return;
    }

    const idBase = editTransacaoId || Date.now().toString();
    const transacoesParaSalvar = [];

    if (parcelas > 1 && tipo === 'despesa') {
        const valorParcela = valor / parcelas;
        for (let i = 1; i <= parcelas; i++) {
            transacoesParaSalvar.push({
                id: `${idBase}_p${i}`,
                tipo,
                conta_id,
                categoria_id,
                data: new Date(new Date(data).setMonth(new Date(data).getMonth() + i - 1)).toISOString().slice(0,10),
                descricao: `${descricao} (${i}/${parcelas})`,
                valor: valorParcela,
                pago: i === 1 ? pago : false,
                parcela_num: i,
                parcela_total: parcelas,
                id_original: idBase,
                foto: fotoBase64 || '',
                sinc: 0
            });
        }
    } else {
        transacoesParaSalvar.push({
            id: editTransacaoId || idBase,
            tipo,
            conta_id,
            categoria_id,
            data,
            descricao,
            valor,
            pago,
            foto: fotoBase64 || '',
            sinc: 0
        });
    }

    const tx = db.transaction(STORE_TRANSACOES, 'readwrite');
    transacoesParaSalvar.forEach(t => tx.objectStore(STORE_TRANSACOES).put(t));
    tx.oncomplete = () => {
        fecharModal('modalTransacao');
        carregarTudo();
        sincronizar();
    };
}

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
    
    if (t.parcela_total) document.getElementById('parcelasNum').value = t.parcela_total;
    
    if (t.foto) {
        fotoBase64 = t.foto;
        document.getElementById('fotoPreview').src = t.foto;
        document.getElementById('fotoPreview').style.display = 'block';
    }
    abrirModal('modalTransacao');
}

function excluirTransacao(id) {
    if (confirm('Remover esta transação?')) {
        const tx = db.transaction(STORE_TRANSACOES, 'readwrite');
        tx.objectStore(STORE_TRANSACOES).delete(id);
        tx.oncomplete = () => carregarTudo();
    }
}

// ============================================
// CRUD Contas
// ============================================
document.getElementById('btnSalvarConta').onclick = salvarConta;

function salvarConta() {
    const conta = {
        id: editContaId || 'conta_' + Date.now(),
        nome: document.getElementById('contaNome').value,
        tipo: document.getElementById('contaTipo').value,
        saldo_inicial: parseFloat(document.getElementById('contaSaldoInicial').value) || 0,
        vencimento: document.getElementById('contaVencimento').value || null,
        limite: parseFloat(document.getElementById('contaLimite').value) || null,
        sinc: 0
    };
    if (!conta.nome) return alert('Nome obrigatório');
    const tx = db.transaction(STORE_CONTAS, 'readwrite');
    tx.objectStore(STORE_CONTAS).put(conta);
    tx.oncomplete = () => {
        fecharModal('modalConta');
        carregarTudo();
        sincronizar();
    };
}

function editarConta(id) {
    const c = contas.find(c => c.id === id);
    if (!c) return;
    editContaId = id;
    document.getElementById('contaNome').value = c.nome;
    document.getElementById('contaTipo').value = c.tipo;
    document.getElementById('contaSaldoInicial').value = c.saldo_inicial || 0;
    document.getElementById('contaVencimento').value = c.vencimento || '';
    document.getElementById('contaLimite').value = c.limite || '';
    abrirModal('modalConta');
}

function excluirConta(id) {
    if (confirm('Remover conta? Todas as transações associadas serão perdidas.')) {
        const tx = db.transaction([STORE_CONTAS, STORE_TRANSACOES], 'readwrite');
        tx.objectStore(STORE_CONTAS).delete(id);
        transacoes.filter(t => t.conta_id === id).forEach(t => {
            tx.objectStore(STORE_TRANSACOES).delete(t.id);
        });
        tx.oncomplete = () => carregarTudo();
    }
}

// ============================================
// CRUD Metas
// ============================================
document.getElementById('btnSalvarMeta').onclick = salvarMeta;

function abrirModalMeta() {
    editMetaId = null;
    document.getElementById('metaNome').value = '';
    document.getElementById('metaValorObjetivo').value = '';
    document.getElementById('metaDataLimite').value = '';
    document.getElementById('metaConta').value = '';
    abrirModal('modalMeta');
}

function salvarMeta() {
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
        carregarTudo();
        sincronizar();
    };
}

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
        tx.oncomplete = () => carregarTudo();
    }
}

// ============================================
// Tratamento de Fotos e UX
// ============================================
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

function abrirZoom(src) {
    if (src && src.startsWith('data:image')) {
        document.getElementById('zoomedImg').src = src;
        document.getElementById('zoomOverlay').classList.add('active');
    }
}

function fecharZoom() {
    document.getElementById('zoomOverlay').classList.remove('active');
}

function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}
if (temaAtual === 'escuro') document.documentElement.setAttribute('data-theme', 'escuro');

// ============================================
// Relatórios Personalizados
// ============================================
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

// ============================================
// Navegação e Modais Globais
// ============================================
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        document.getElementById('viewResumo').style.display = view === 'resumo' ? 'block' : 'none';
        document.getElementById('viewGrafico').style.display = view === 'grafico' ? 'block' : 'none';
        document.getElementById('viewMetas').style.display = view === 'metas' ? 'block' : 'none';
        if (view === 'grafico') desenharGrafico();
    });
});

document.getElementById('fabAdd').onclick = () => {
    editTransacaoId = null;
    fotoBase64 = null;
    document.getElementById('fotoPreview').style.display = 'none';
    document.getElementById('parcelasContainer').style.display = 'none';
    document.getElementById('transacaoPago').checked = true;
    document.getElementById('transacaoDescricao').value = '';
    document.getElementById('transacaoValor').value = '';
    document.getElementById('transacaoData').value = new Date().toISOString().slice(0, 10);
    abrirModal('modalTransacao');
};

document.getElementById('transacaoTipo').addEventListener('change', (e) => {
    document.getElementById('parcelasContainer').style.display = e.target.value === 'despesa' ? 'block' : 'none';
});

function abrirModal(id) {
    document.getElementById(id).classList.add('active');
    document.getElementById('overlay').classList.add('active');
}

function fecharModal(id) {
    document.getElementById(id).classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}

document.getElementById('filtroMes').addEventListener('change', (e) => {
    mesAtual = e.target.value;
    atualizarInterface();
});
document.getElementById('busca').addEventListener('input', atualizarListaTransacoes);
document.getElementById('filtroConta').addEventListener('change', atualizarListaTransacoes);
document.getElementById('filtroGraficoConta').addEventListener('change', desenharGrafico);

// ============================================
// Sincronização Google Sheets / Notificações
// ============================================
async function sincronizar() {
    if (!navigator.onLine) return;
    const tokenOffline = localStorage.getItem('tokenOffline');
    if (!tokenOffline) return;

    try {
        const token = atob(tokenOffline);
        document.getElementById('statusLabel').innerText = '🔄 Sincronizando...';
        
        const pendentesTrans = transacoes.filter(t => t.sinc === 0);
        const pendentesContas = contas.filter(c => c.sinc === 0);
        const pendentesMetas = metas.filter(m => m.sinc === 0);

        if(pendentesTrans.length > 0 || pendentesContas.length > 0 || pendentesMetas.length > 0) {
            const postData = {
                token: token,
                transacoes: pendentesTrans,
                contas: pendentesContas,
                categorias: [],
                metas: pendentesMetas
            };

            await fetch(API_URL, {
                method: 'POST',
                body: JSON.stringify(postData)
            });

            const tx = db.transaction([STORE_TRANSACOES, STORE_CONTAS, STORE_METAS], 'readwrite');
            pendentesTrans.forEach(t => { t.sinc = 1; tx.objectStore(STORE_TRANSACOES).put(t); });
            pendentesContas.forEach(c => { c.sinc = 1; tx.objectStore(STORE_CONTAS).put(c); });
            pendentesMetas.forEach(m => { m.sinc = 1; tx.objectStore(STORE_METAS).put(m); });
        }

        document.getElementById('statusLabel').innerText = '🌐 Online';
        document.getElementById('statusLabel').className = 'status online';
    } catch (err) {
        document.getElementById('statusLabel').innerText = '⚠️ Erro Sinc';
        document.getElementById('statusLabel').className = 'status offline';
    }
}

function verificarNotificacoes() {
    if (!("Notification" in window) || Notification.permission !== 'granted') return;
    const hoje = new Date().toISOString().slice(0,10);
    transacoes.forEach(t => {
        if (t.pago === false && t.data === hoje) {
            new Notification('Lembrete: transação hoje', { body: t.descricao });
        }
    });
}
if (Notification.permission === 'default') Notification.requestPermission();
