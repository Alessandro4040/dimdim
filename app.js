// Configurações
const API_URL = 'https://script.google.com/macros/s/AKfycbwGk0XAFHppkf9iZ59O7y47QjNzo5z6Xqd5GUKOMpGTNVYxbJwUN8tpNKILNSe4pjp1/exec'; // ← SUBSTITUA PELO SEU ID
const DB_NAME = 'financas_v5';
let db, chartInstance;
let transacoes = [], contas = [], metas = [], categorias = [];
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';
let syncInProgress = false;
let authToken = localStorage.getItem('authToken');

// ============================================
// Geração de UUID v4
// ============================================
function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

// ============================================
// Redimensionar imagem (Canvas)
// ============================================
function resizeImage(file, maxWidth = 800, maxHeight = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(dataUrl);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// ============================================
// Tema
// ============================================
document.documentElement.setAttribute('data-theme', temaAtual);
function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}

// ============================================
// AUTENTICAÇÃO
// ============================================
async function submitPassword() {
    const password = document.getElementById('passwordInput').value;
    const errorDiv = document.getElementById('passwordError');
    errorDiv.textContent = '';
    try {
        const response = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(password)}`);
        const data = await response.json();
        if (data.success) {
            authToken = password;
            localStorage.setItem('authToken', authToken);
            document.getElementById('passwordScreen').classList.add('hidden');
            document.getElementById('lockScreen').classList.remove('hidden');
        } else {
            errorDiv.textContent = 'Senha incorreta.';
        }
    } catch (err) {
        errorDiv.textContent = 'Erro de conexão. Tente novamente.';
    }
}

async function checkStoredToken() {
    if (!authToken) {
        return false;
    }
    try {
        const response = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(authToken)}`);
        const data = await response.json();
        if (data.success) {
            document.getElementById('passwordScreen').classList.add('hidden');
            document.getElementById('lockScreen').classList.remove('hidden');
            return true;
        } else {
            localStorage.removeItem('authToken');
            authToken = null;
            return false;
        }
    } catch (err) {
        document.getElementById('passwordScreen').classList.add('hidden');
        document.getElementById('lockScreen').classList.remove('hidden');
        return true;
    }
}

function logout() {
    localStorage.removeItem('authToken');
    authToken = null;
    window.location.reload();
}

async function autenticarBiometria() {
    try {
        if (window.PublicKeyCredential) {
            document.getElementById('lockScreen').classList.add('hidden');
            document.getElementById('appContent').style.display = 'block';
            iniciarApp();
        } else {
            alert("Biometria não suportada. Acesso liberado.");
            document.getElementById('lockScreen').classList.add('hidden');
            document.getElementById('appContent').style.display = 'block';
            iniciarApp();
        }
    } catch (e) {
        alert("Erro na autenticação.");
    }
}

// ============================================
// IndexedDB
// ============================================
function iniciarApp() {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
        let db = e.target.result;
        if (!db.objectStoreNames.contains('transacoes')) db.createObjectStore('transacoes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('contas')) db.createObjectStore('contas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('metas')) db.createObjectStore('metas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('categorias')) db.createObjectStore('categorias', { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
        db = e.target.result;
        carregarDadosLocais();
        syncWithServer();
        setInterval(syncWithServer, 300000);
    };
    req.onerror = (e) => {
        console.error("Erro ao abrir IndexedDB:", e);
    };
}

function carregarDadosLocais() {
    const tx = db.transaction(['transacoes', 'contas', 'metas', 'categorias'], 'readonly');
    
    tx.objectStore('transacoes').getAll().onsuccess = e => { 
        transacoes = e.target.result || [];
        console.log("Transações carregadas:", transacoes.length);
    };
    tx.objectStore('contas').getAll().onsuccess = e => { 
        contas = e.target.result || [];
        atualizarSelectContas();
        console.log("Contas carregadas:", contas.length);
    };
    tx.objectStore('metas').getAll().onsuccess = e => { 
        metas = e.target.result || [];
        console.log("Metas carregadas:", metas.length);
    };
    tx.objectStore('categorias').getAll().onsuccess = e => { 
        categorias = e.target.result || [];
        if (categorias.length === 0) {
            const padrao = [
                { id: '1', nome: 'Alimentação', tipo: 'despesa', icone: '🍔', fixa: true, sinc: false, updated_at: new Date().toISOString() },
                { id: '2', nome: 'Transporte', tipo: 'despesa', icone: '🚗', fixa: true, sinc: false, updated_at: new Date().toISOString() },
                { id: '3', nome: 'Lazer', tipo: 'despesa', icone: '🎮', fixa: true, sinc: false, updated_at: new Date().toISOString() },
                { id: '4', nome: 'Salário', tipo: 'receita', icone: '💰', fixa: true, sinc: false, updated_at: new Date().toISOString() },
                { id: '5', nome: 'Outros', tipo: 'outros', icone: '📦', fixa: true, sinc: false, updated_at: new Date().toISOString() }
            ];
            padrao.forEach(c => salvarItemDB('categorias', c));
            categorias = padrao;
        }
        atualizarSelectCategorias();
        atualizarFiltroCategorias();
        console.log("Categorias carregadas:", categorias.length);
    };
    
    tx.oncomplete = () => {
        console.log("Todos os dados carregados, atualizando dashboard...");
        atualizarDashboard();
        verificarPendencias();
        atualizarSyncStatus();
    };
    tx.onerror = (e) => {
        console.error("Erro ao carregar dados:", e);
    };
}

function salvarItemDB(store, item) {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => carregarDadosLocais();
}

// ============================================
// Sincronização com servidor
// ============================================
async function syncWithServer() {
    if (syncInProgress) return;
    if (!authToken) return;
    syncInProgress = true;
    atualizarSyncStatus('sincronizando');
    try {
        const unsynced = { transacoes: [], contas: [], metas: [], categorias: [] };
        for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
            const items = await getAllFromStore(store);
            unsynced[store] = items.filter(i => !i.sinc);
        }
        
        if (Object.values(unsynced).some(arr => arr.length)) {
            const payload = { ...unsynced, token: authToken };
            const response = await fetch(API_URL, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                const result = await response.json();
                if (result.error) throw new Error(result.error);
                for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
                    for (const item of unsynced[store]) {
                        item.sinc = true;
                        await putToStore(store, item);
                    }
                }
            }
        }
        
        const pullResponse = await fetch(`${API_URL}?action=getAll&token=${encodeURIComponent(authToken)}`);
        const remoteData = await pullResponse.json();
        if (remoteData && !remoteData.error) {
            for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
                const remoteItems = remoteData[store] || [];
                for (const item of remoteItems) {
                    await putToStore(store, item);
                }
            }
        } else if (remoteData.error === "Acesso negado.") {
            logout();
            return;
        }
        atualizarSyncStatus('sincronizado');
        carregarDadosLocais();
    } catch (error) {
        console.error('Sync error', error);
        atualizarSyncStatus('erro');
    } finally {
        syncInProgress = false;
    }
}

function getAllFromStore(store) {
    return new Promise((resolve) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
    });
}

function putToStore(store, item) {
    return new Promise((resolve) => {
        const tx = db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put(item);
        req.onsuccess = () => resolve();
    });
}

function atualizarSyncStatus(status) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    if (status === 'sincronizando') {
        el.innerHTML = '🔄 Sincronizando...';
        el.className = 'sync-status status-pending';
    } else if (status === 'sincronizado') {
        el.innerHTML = '✅ Sincronizado';
        el.className = 'sync-status status-synced';
        setTimeout(() => { if (el.innerHTML === '✅ Sincronizado') el.innerHTML = '✅ Sincronizado'; }, 2000);
    } else if (status === 'erro') {
        el.innerHTML = '⚠️ Erro de sincronia';
        el.className = 'sync-status status-pending';
    } else {
        const unsyncedCount = (transacoes?.filter(t => !t.sinc)?.length || 0) + 
                              (contas?.filter(c => !c.sinc)?.length || 0) + 
                              (metas?.filter(m => !m.sinc)?.length || 0);
        if (unsyncedCount > 0) {
            el.innerHTML = `⚠️ ${unsyncedCount} pendente(s)`;
            el.className = 'sync-status status-pending';
        } else {
            el.innerHTML = '✅ Sincronizado';
            el.className = 'sync-status status-synced';
        }
    }
}

// ============================================
// Funções de UI
// ============================================
function atualizarSelectContas() {
    const sel = document.getElementById('tConta');
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecione...</option>';
    if (contas && contas.length) {
        contas.forEach(c => {
            sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
        });
    }
    const selMeta = document.getElementById('mConta');
    if (selMeta) {
        selMeta.innerHTML = '<option value="">Nenhuma</option>';
        if (contas && contas.length) {
            contas.forEach(c => {
                selMeta.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
            });
        }
    }
}

function atualizarSelectCategorias() {
    const sel = document.getElementById('tCategoria');
    if (!sel) return;
    sel.innerHTML = '';
    if (categorias && categorias.length) {
        categorias.forEach(c => {
            sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
        });
    }
}

function atualizarFiltroCategorias() {
    const sel = document.getElementById('categoryFilter');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todas categorias</option>';
    if (categorias && categorias.length) {
        categorias.forEach(c => {
            sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
        });
    }
}

// ============================================
// Dashboard e renderização
// ============================================
function atualizarDashboard() {
    console.log("Atualizando dashboard...");
    
    const mes = mesAtual;
    const searchTerm = document.getElementById('globalSearch')?.value?.toLowerCase() || '';
    const catFilter = document.getElementById('categoryFilter')?.value || '';

    let recMes = 0, desMes = 0, saldoGeral = 0;

    // Atualizar contas
    let htmlContas = '';
    if (contas && contas.length) {
        contas.forEach(c => {
            let saldoConta = c.tipo === 'corrente' ? parseFloat(c.saldo_inicial || 0) : parseFloat(c.limite || 0);
            if (transacoes && transacoes.length) {
                transacoes.forEach(t => {
                    if (t.conta_id === c.id && t.pago === 'true' || t.pago === true) {
                        if (t.tipo === 'receita') saldoConta += parseFloat(t.valor || 0);
                        if (t.tipo === 'despesa') saldoConta -= parseFloat(t.valor || 0);
                    }
                });
            }
            if (c.tipo === 'corrente') saldoGeral += saldoConta;
            htmlContas += `<div class="card" style="margin-bottom:10px; text-align:left;">
                <strong>${c.nome}</strong> (${c.tipo === 'corrente' ? 'Conta Corrente' : 'Cartão'})<br>
                ${c.tipo === 'cartao' ? 'Limite Disp.' : 'Saldo'}: R$ ${saldoConta.toFixed(2)}
            </div>`;
        });
    } else {
        htmlContas = '<div class="card">Nenhuma conta cadastrada</div>';
    }
    const listaContas = document.getElementById('listaContas');
    if (listaContas) listaContas.innerHTML = htmlContas;

    // Filtrar transações do mês
    let categoriasTotais = {};
    let htmlTransacoes = '';
    let transacoesFiltradas = [];
    
    if (transacoes && transacoes.length) {
        transacoesFiltradas = transacoes.filter(t => {
            if (!t.data || !t.data.startsWith(mes)) return false;
            if (searchTerm && !(t.descricao || '').toLowerCase().includes(searchTerm)) return false;
            if (catFilter && t.categoria_id !== catFilter) return false;
            return true;
        });
        
        transacoesFiltradas.forEach(t => {
            const valor = parseFloat(t.valor || 0);
            if (t.tipo === 'receita') {
                recMes += valor;
            }
            if (t.tipo === 'despesa') {
                desMes += valor;
                const catId = t.categoria_id;
                categoriasTotais[catId] = (categoriasTotais[catId] || 0) + valor;
            }
            
            const categoriaNome = categorias?.find(c => c.id === t.categoria_id)?.nome || 'Sem categoria';
            const pagoStatus = (t.pago === 'true' || t.pago === true) ? '✅ Pago' : '⏳ Pendente';
            const valorClass = t.tipo === 'receita' ? 'receita' : 'despesa';
            
            htmlTransacoes += `<div class="transacao-item">
                <div class="transacao-info">
                    <div class="transacao-descricao">${t.descricao || 'Sem descrição'}</div>
                    <div class="transacao-detalhes">${t.data} • ${categoriaNome} • ${pagoStatus}</div>
                    ${t.foto ? `<div><a href="#" onclick="abrirZoom('${t.foto}')" style="color:var(--p);font-size:12px;">📎 Ver Comprovante</a></div>` : ''}
                </div>
                <div class="transacao-valor ${valorClass}">
                    R$ ${valor.toFixed(2)}
                </div>
            </div>`;
        });
    }
    
    if (!htmlTransacoes) {
        htmlTransacoes = '<div class="card" style="text-align:center; padding:20px;">Nenhuma transação encontrada</div>';
    }

    // Atualizar elementos
    const saldoTotalEl = document.getElementById('saldoTotal');
    if (saldoTotalEl) saldoTotalEl.innerText = `R$ ${saldoGeral.toFixed(2)}`;
    
    const totalRecEl = document.getElementById('totalRec');
    if (totalRecEl) totalRecEl.innerText = `R$ ${recMes.toFixed(2)}`;
    
    const totalDesEl = document.getElementById('totalDes');
    if (totalDesEl) totalDesEl.innerText = `R$ ${desMes.toFixed(2)}`;
    
    const listaTransacoesEl = document.getElementById('listaTransacoes');
    if (listaTransacoesEl) listaTransacoesEl.innerHTML = htmlTransacoes;

    // Atualizar metas
    let htmlMetas = '';
    if (metas && metas.length) {
        metas.forEach(m => {
            const valorAtual = parseFloat(m.valor_atual || 0);
            const valorObjetivo = parseFloat(m.valor_objetivo || 1);
            let pct = Math.min((valorAtual / valorObjetivo) * 100, 100).toFixed(1);
            htmlMetas += `<div class="card" style="margin-bottom:10px; text-align:left;">
                <strong>${m.nome}</strong> - ${pct}% concluído<br>
                <progress value="${valorAtual}" max="${valorObjetivo}" style="width:100%;"></progress>
                <small>R$ ${valorAtual.toFixed(2)} / R$ ${valorObjetivo.toFixed(2)}</small>
            </div>`;
        });
    } else {
        htmlMetas = '<div class="card">Nenhuma meta cadastrada</div>';
    }
    const listaMetasEl = document.getElementById('listaMetas');
    if (listaMetasEl) listaMetasEl.innerHTML = htmlMetas;

    // Renderizar gráfico
    renderizarGrafico(categoriasTotais);
}

function verificarPendencias() {
    const hoje = new Date().toISOString().slice(0, 10);
    const pendentes = transacoes?.filter(t => {
        const pago = (t.pago === 'true' || t.pago === true);
        return !pago && t.data && t.data <= hoje;
    }) || [];
    
    const alertEl = document.getElementById('alertasPendentes');
    if (alertEl) {
        if (pendentes.length > 0) {
            alertEl.innerText = `⚠️ Aviso: ${pendentes.length} transação(ões) pendente(s) ou vencida(s)!`;
        } else {
            alertEl.innerText = '';
        }
    }
}

function renderizarGrafico(dados) {
    const ctx = document.getElementById('graficoDespesas');
    if (!ctx) return;
    
    const canvasCtx = ctx.getContext('2d');
    if (chartInstance) {
        chartInstance.destroy();
    }
    
    const labels = Object.keys(dados).map(id => {
        const cat = categorias?.find(c => c.id === id);
        return cat ? cat.nome : id;
    });
    const valores = Object.values(dados);
    
    if (valores.length === 0) {
        chartInstance = new Chart(canvasCtx, {
            type: 'doughnut',
            data: {
                labels: ['Sem dados'],
                datasets: [{
                    data: [1],
                    backgroundColor: ['#e2e8f0'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: 'var(--txt)' } },
                    tooltip: { callbacks: { label: () => 'Nenhuma despesa no período' } }
                }
            }
        });
        return;
    }
    
    chartInstance = new Chart(canvasCtx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: valores,
                backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec489a', '#6366f1'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { position: 'bottom', labels: { color: 'var(--txt)' } }
            }
        }
    });
}

// ============================================
// Salvar transações, contas e metas
// ============================================
async function salvarTransacao() {
    const descricao = document.getElementById('tDescricao')?.value;
    const valorTotal = parseFloat(document.getElementById('tValor')?.value);
    const dataInicial = new Date(document.getElementById('tData')?.value);
    const parcelas = parseInt(document.getElementById('tParcelas')?.value) || 1;
    const tipo = document.getElementById('tTipo')?.value;
    const contaId = document.getElementById('tConta')?.value;
    const categoriaId = document.getElementById('tCategoria')?.value;
    const pago = document.getElementById('tStatus')?.value === "true";
    const fotoFile = document.getElementById('tFoto')?.files[0];

    if (!descricao || !valorTotal || !dataInicial || !contaId || !categoriaId) {
        alert("Preencha todos os campos obrigatórios!");
        return;
    }

    let fotoBase64 = null;
    if (fotoFile) {
        fotoBase64 = await resizeImage(fotoFile);
    }

    const idOriginal = uuidv4();
    const valorParcela = valorTotal / parcelas;

    for (let i = 0; i < parcelas; i++) {
        let dataParcela = new Date(dataInicial);
        dataParcela.setMonth(dataParcela.getMonth() + i);
        const transacao = {
            id: uuidv4(),
            id_original: idOriginal,
            tipo: tipo,
            descricao: parcelas > 1 ? `${descricao} (${i+1}/${parcelas})` : descricao,
            valor: valorParcela,
            data: dataParcela.toISOString().split('T')[0],
            conta_id: contaId,
            categoria_id: categoriaId,
            pago: pago,
            parcela_num: i + 1,
            parcela_total: parcelas,
            foto: fotoBase64,
            sinc: false,
            updated_at: new Date().toISOString()
        };
        salvarItemDB('transacoes', transacao);
    }
    fecharModais();
    alert("Transação(ões) salva(s) com sucesso!");
}

function salvarConta() {
    const nome = document.getElementById('cNome')?.value;
    const tipo = document.getElementById('cTipo')?.value;
    const saldoLimite = parseFloat(document.getElementById('cSaldoLimite')?.value) || 0;
    
    if (!nome) {
        alert("Digite o nome da conta!");
        return;
    }
    
    const novaConta = {
        id: uuidv4(),
        nome: nome,
        tipo: tipo,
        saldo_inicial: tipo === 'corrente' ? saldoLimite : 0,
        limite: tipo === 'cartao' ? saldoLimite : 0,
        vencimento: document.getElementById('cVencimento')?.value || null,
        sinc: false,
        updated_at: new Date().toISOString()
    };
    salvarItemDB('contas', novaConta);
    fecharModais();
    alert("Conta salva com sucesso!");
}

function salvarMeta() {
    const nome = document.getElementById('mNome')?.value;
    const valorObjetivo = parseFloat(document.getElementById('mObjetivo')?.value);
    const valorAtual = parseFloat(document.getElementById('mAtual')?.value) || 0;
    
    if (!nome || !valorObjetivo) {
        alert("Preencha o nome e o valor objetivo da meta!");
        return;
    }
    
    const novaMeta = {
        id: uuidv4(),
        nome: nome,
        valor_objetivo: valorObjetivo,
        valor_atual: valorAtual,
        data_limite: document.getElementById('mData')?.value || null,
        conta_id: document.getElementById('mConta')?.value || null,
        sinc: false,
        updated_at: new Date().toISOString()
    };
    salvarItemDB('metas', novaMeta);
    fecharModais();
    alert("Meta salva com sucesso!");
}

// ============================================
// Utilitários de UI
// ============================================
function abrirModal(id) {
    const modal = document.getElementById(id);
    const overlay = document.getElementById('overlay');
    if (modal) modal.classList.add('active');
    if (overlay) overlay.classList.add('active');
}

function fecharModais() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('active');
}

function abrirZoom(base64) {
    const zoomImg = document.getElementById('zoomImg');
    const viewer = document.getElementById('imageViewer');
    if (zoomImg && viewer) {
        zoomImg.src = base64;
        zoomImg.style.transform = 'scale(1)';
        viewer.style.display = 'flex';
    }
}

function fecharZoom() {
    const viewer = document.getElementById('imageViewer');
    if (viewer) viewer.style.display = 'none';
}

function aplicarZoom(img) {
    img.style.transform = img.style.transform === 'scale(2)' ? 'scale(1)' : 'scale(2)';
}

function baixarRelatorio() {
    const ini = document.getElementById('eDataIni')?.value;
    const fim = document.getElementById('eDataFim')?.value;
    if (!ini || !fim) {
        alert("Selecione as datas de início e fim!");
        return;
    }
    
    let filtrado = transacoes?.filter(t => t.data >= ini && t.data <= fim) || [];
    let csv = "Data,Tipo,Descrição,Valor,Status,Categoria\n";
    filtrado.forEach(t => {
        const catNome = categorias?.find(c => c.id === t.categoria_id)?.nome || '';
        csv += `${t.data},${t.tipo},${t.descricao},${t.valor},${t.pago === 'true' || t.pago === true ? 'Pago' : 'Pendente'},${catNome}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio_${ini}_a_${fim}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
}

function baixarPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const ini = document.getElementById('eDataIni')?.value;
    const fim = document.getElementById('eDataFim')?.value;
    
    if (!ini || !fim) {
        alert("Selecione as datas de início e fim!");
        return;
    }
    
    let filtrado = transacoes?.filter(t => t.data >= ini && t.data <= fim) || [];
    const tableData = filtrado.map(t => [
        t.data,
        t.tipo === 'receita' ? 'Receita' : 'Despesa',
        t.descricao,
        `R$ ${parseFloat(t.valor || 0).toFixed(2)}`,
        t.pago === 'true' || t.pago === true ? 'Pago' : 'Pendente',
        categorias?.find(c => c.id === t.categoria_id)?.nome || ''
    ]);
    
    doc.text(`Relatório de Transações - ${ini} a ${fim}`, 14, 16);
    doc.autoTable({
        head: [['Data', 'Tipo', 'Descrição', 'Valor', 'Status', 'Categoria']],
        body: tableData,
        startY: 20,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [37, 99, 235] }
    });
    doc.save(`relatorio_${ini}_a_${fim}.pdf`);
}

// ============================================
// Event Listeners
// ============================================
const monthPicker = document.getElementById('monthPicker');
if (monthPicker) {
    monthPicker.value = mesAtual;
    monthPicker.addEventListener('change', (e) => {
        mesAtual = e.target.value;
        atualizarDashboard();
    });
}

const globalSearch = document.getElementById('globalSearch');
if (globalSearch) {
    globalSearch.addEventListener('input', () => atualizarDashboard());
}

const categoryFilter = document.getElementById('categoryFilter');
if (categoryFilter) {
    categoryFilter.addEventListener('change', () => atualizarDashboard());
}

// Inicialização
window.addEventListener('load', () => {
    checkStoredToken();
});
