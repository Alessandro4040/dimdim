// ============================================================
// CONFIGURAÇÕES GLOBAIS
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbznPvhHLdMUEfl2Vbb3BPDqwKmlQaQZxHISujSjeLgPzbwLPSkLqIlnayyvZh-M_p1e/exec';
const DB_NAME = 'financas_v5';
const MAX_SYNC_RETRIES = 3;
const SYNC_DEBOUNCE_MS = 2000;

// Estado global
let db;
let transacoes = [];
let contas = [];
let metas = [];
let categorias = [];
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';
let syncInProgress = false;
let authToken = localStorage.getItem('authToken');
let syncDebounceTimer = null;
let syncRetryTimer = null;
let syncRetryCount = 0;
let filtroDataInicio = '';
let filtroDataFim = '';

// Flag para adicionar conta a partir do modal de transação
let adicionandoContaParaTransacao = false;
let novaContaId = null;

// ============================================================
// UTILITÁRIOS
// ============================================================

function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

function formatarDataBR(dataISO) {
    if (!dataISO) return '';
    const partes = dataISO.split('-');
    if (partes.length !== 3) return dataISO;
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

function resizeImage(file, maxWidth = 800, maxHeight = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let width = img.width, height = img.height;
                if (width > maxWidth) { height *= maxWidth / width; width = maxWidth; }
                if (height > maxHeight) { width *= maxHeight / height; height = maxHeight; }
                const canvas = document.createElement('canvas');
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function parseMoedaBR(valor) {
    if (typeof valor === 'number') return valor;
    if (!valor) return 0;
    let str = String(valor).replace(/[^0-9,\-]/g, '');
    str = str.replace(',', '.');
    return parseFloat(str) || 0;
}

function parseDataBR(dataStr) {
    if (!dataStr) return '';
    if (String(dataStr).includes('-') && String(dataStr).length === 10) return dataStr;
    if (String(dataStr).includes('/')) {
        const partes = String(dataStr).split(' ')[0].split('/');
        if (partes.length === 3) {
            return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        }
    }
    return dataStr;
}

// ============================================================
// TEMA
// ============================================================
document.documentElement.setAttribute('data-theme', temaAtual);

function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}

// ============================================================
// AUTENTICAÇÃO
// ============================================================
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
            
            // Entra direto no app
            document.getElementById('passwordScreen').classList.add('hidden');
            document.getElementById('appContent').style.display = 'block';
            iniciarApp();
        } else {
            errorDiv.textContent = 'Senha incorreta.';
        }
    } catch (err) {
        errorDiv.textContent = 'Erro de conexão. Tente novamente.';
    }
}

async function checkStoredToken() {
    if (!authToken) return false;
    try {
        const response = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(authToken)}`);
        const data = await response.json();
        if (data.success) {
            document.getElementById('passwordScreen').classList.add('hidden');
            document.getElementById('appContent').style.display = 'block';
            iniciarApp();
            return true;
        } else {
            localStorage.removeItem('authToken');
            authToken = null;
            return false;
        }
    } catch (err) {
        // Se estiver offline mas com token, permite entrar
        document.getElementById('passwordScreen').classList.add('hidden');
        document.getElementById('appContent').style.display = 'block';
        iniciarApp();
        return true;
    }
}

function logout() {
    localStorage.removeItem('authToken');
    authToken = null;
    window.location.reload();
}

// ============================================================
// INDEXEDDB
// ============================================================
function iniciarApp() {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('transacoes')) db.createObjectStore('transacoes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('contas')) db.createObjectStore('contas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('metas')) db.createObjectStore('metas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('categorias')) db.createObjectStore('categorias', { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
        db = e.target.result;
        carregarDadosLocais();
        if (navigator.onLine) scheduleSync(true);
        setInterval(() => {
            if (!syncInProgress && navigator.onLine) {
                const temPendencias = transacoes.some(t => !t.sinc) || contas.some(c => !c.sinc) || metas.some(m => !m.sinc);
                if (temPendencias) scheduleSync(true);
            }
        }, 300000);
    };
}

function carregarDadosLocais() {
    const tx = db.transaction(['transacoes', 'contas', 'metas', 'categorias'], 'readonly');
    tx.objectStore('transacoes').getAll().onsuccess = e => { transacoes = e.target.result; };
    tx.objectStore('contas').getAll().onsuccess = e => {
        contas = e.target.result;
        atualizarSelectContas();
    };
    tx.objectStore('metas').getAll().onsuccess = e => { metas = e.target.result; };
    tx.objectStore('categorias').getAll().onsuccess = e => {
        categorias = e.target.result;
        if (categorias.length === 0) {
            const padrao = [
                { id: '1', nome: 'Alimentação', tipo: 'despesa', icone: '🍔', fixa: true, sinc: true, updated_at: new Date().toISOString() },
                { id: '2', nome: 'Transporte', tipo: 'despesa', icone: '🚗', fixa: true, sinc: true, updated_at: new Date().toISOString() },
                { id: '3', nome: 'Lazer', tipo: 'despesa', icone: '🎮', fixa: true, sinc: true, updated_at: new Date().toISOString() },
                { id: '4', nome: 'Salário', tipo: 'receita', icone: '💰', fixa: true, sinc: true, updated_at: new Date().toISOString() },
                { id: '5', nome: 'Outros', tipo: 'outros', icone: '📦', fixa: true, sinc: true, updated_at: new Date().toISOString() },
                { id: 'cat_transferencia', nome: '🔄 Transf. / Fatura', tipo: 'outros', icone: '🔄', fixa: true, sinc: true, updated_at: new Date().toISOString() }
            ];
            padrao.forEach(c => salvarItemDB('categorias', c));
            categorias = padrao;
        }
        atualizarSelectCategorias();
        atualizarFiltroCategorias();
    };
    tx.oncomplete = () => {
        atualizarDashboard();
        verificarPendencias();
        atualizarSyncStatus();
    };
}

function salvarItemDB(store, item) {
    return new Promise((resolve, reject) => {
        if (!db) {
            setTimeout(() => {
                salvarItemDB(store, item).then(resolve).catch(reject);
            }, 200);
            return;
        }
        const tx = db.transaction(store, 'readwrite');
        const storeObj = tx.objectStore(store);
        const request = storeObj.put(item);
        request.onsuccess = () => {
            tx.oncomplete = () => {
                carregarDadosLocais();
                resolve();
            };
        };
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
    });
}

function getAllFromStore(store) {
    return new Promise((resolve) => {
        const tx = db.transaction(store, 'readonly');
        tx.objectStore(store).getAll().onsuccess = e => resolve(e.target.result);
    });
}

function putToStore(store, item) {
    return new Promise((resolve) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(item).onsuccess = () => resolve();
    });
}

async function excluirItem(store, inputId) {
    const id = document.getElementById(inputId).value;
    if (!id || !confirm('Tem certeza que deseja excluir este item?')) return;
    
    if (store === 'transacoes') {
        const transacao = transacoes.find(t => t.id === id);
        if (transacao && transacao.id_original) {
            const related = transacoes.filter(t => t.id_original === transacao.id_original);
            if (related.length > 1) {
                if (confirm('Esta é uma transferência. Deseja excluir ambas as movimentações (saída e entrada)?')) {
                    for (const t of related) {
                        const tx = db.transaction('transacoes', 'readwrite');
                        tx.objectStore('transacoes').delete(t.id);
                        let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
                        deletados['transacoes'].push(t.id);
                        localStorage.setItem('deletados', JSON.stringify(deletados));
                    }
                } else {
                    const tx = db.transaction('transacoes', 'readwrite');
                    tx.objectStore('transacoes').delete(id);
                    let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
                    deletados['transacoes'].push(id);
                    localStorage.setItem('deletados', JSON.stringify(deletados));
                }
            } else {
                const tx = db.transaction('transacoes', 'readwrite');
                tx.objectStore('transacoes').delete(id);
                let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
                deletados['transacoes'].push(id);
                localStorage.setItem('deletados', JSON.stringify(deletados));
            }
        } else {
            const tx = db.transaction('transacoes', 'readwrite');
            tx.objectStore('transacoes').delete(id);
            let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
            deletados['transacoes'].push(id);
            localStorage.setItem('deletados', JSON.stringify(deletados));
        }
    } else {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
        deletados[store].push(id);
        localStorage.setItem('deletados', JSON.stringify(deletados));
    }
    
    fecharModais();
    carregarDadosLocais();
    scheduleSync();
}

// ============================================================
// SINCRONIZAÇÃO
// ============================================================
function scheduleSync(immediate = false) {
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    if (immediate) {
        if (!syncInProgress && navigator.onLine && authToken) {
            syncWithServer();
        }
    } else {
        syncDebounceTimer = setTimeout(() => {
            if (!syncInProgress && navigator.onLine && authToken) {
                syncWithServer();
            }
            syncDebounceTimer = null;
        }, SYNC_DEBOUNCE_MS);
    }
}

function clearRetry() {
    if (syncRetryTimer) {
        clearTimeout(syncRetryTimer);
        syncRetryTimer = null;
    }
    syncRetryCount = 0;
}

async function syncWithServer() {
    if (syncInProgress || !authToken) return;
    if (!navigator.onLine) {
        atualizarSyncStatus('offline');
        return;
    }
    
    const temPendencias = transacoes.some(t => !t.sinc) || contas.some(c => !c.sinc) || metas.some(m => !m.sinc);
    const deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
    const temDeletados = Object.values(deletados).some(arr => arr.length > 0);
    
    if (!temPendencias && !temDeletados) {
        if (syncRetryCount === 0) {
            await pullFromServer();
        }
        atualizarSyncStatus('sincronizado');
        return;
    }
    
    syncInProgress = true;
    atualizarSyncStatus('sincronizando');
    
    try {
        const unsynced = { transacoes: [], contas: [], metas: [], categorias: [] };
        for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
            const items = await getAllFromStore(store);
            unsynced[store] = items.filter(i => !i.sinc);
        }
        
        const payload = { ...unsynced, deletados, token: authToken };
        const response = await fetch(API_URL, { method: 'POST', body: JSON.stringify(payload) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const result = await response.json();
        if (result.error) {
            if (result.error.includes("Acesso negado") || result.error.includes("Senha incorreta")) {
                logout();
                return;
            }
            throw new Error(result.error);
        }
        
        localStorage.setItem('deletados', '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
        for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
            for (const item of unsynced[store]) {
                item.sinc = true;
                await putToStore(store, item);
            }
        }
        
        await pullFromServer();
        atualizarSyncStatus('sincronizado');
        carregarDadosLocais();
        clearRetry();
        
    } catch (error) {
        console.error('Sync error:', error);
        atualizarSyncStatus('erro');
        
        if (error.message.includes('fetch') || error.message.includes('Network') || error.message.includes('Failed to fetch')) {
            if (syncRetryCount < MAX_SYNC_RETRIES) {
                syncRetryCount++;
                const delay = 10000 * Math.pow(2, syncRetryCount - 1);
                syncRetryTimer = setTimeout(() => {
                    if (navigator.onLine && authToken) {
                        scheduleSync(true);
                    }
                    syncRetryTimer = null;
                }, delay);
            } else {
                atualizarSyncStatus('erro');
                setTimeout(() => { syncRetryCount = 0; }, 60000 * 5);
            }
        } else {
            atualizarSyncStatus('erro');
        }
    } finally {
        syncInProgress = false;
    }
}

async function pullFromServer() {
    try {
        const pullResponse = await fetch(`${API_URL}?action=getAll&token=${encodeURIComponent(authToken)}`);
        const remoteData = await pullResponse.json();
        if (remoteData && !remoteData.error) {
            for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
                const remoteItems = remoteData[store] || [];
                const deletadosAtuais = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
                for (const item of remoteItems) {
                    if (deletadosAtuais[store].includes(item.id)) continue;
                    if (item.valor !== undefined) item.valor = parseMoedaBR(item.valor);
                    if (item.saldo_inicial !== undefined) item.saldo_inicial = parseMoedaBR(item.saldo_inicial);
                    if (item.limite !== undefined) item.limite = parseMoedaBR(item.limite);
                    if (item.valor_objetivo !== undefined) item.valor_objetivo = parseMoedaBR(item.valor_objetivo);
                    if (item.valor_atual !== undefined) item.valor_atual = parseMoedaBR(item.valor_atual);
                    if (item.pago !== undefined) {
                        const pStr = String(item.pago).toUpperCase().trim();
                        item.pago = (item.pago === true || pStr === 'TRUE' || pStr === 'VERDADEIRO' || pStr === 'SIM' || pStr === '1');
                    }
                    if (item.data !== undefined) item.data = parseDataBR(item.data);
                    if (item.vencimento !== undefined) item.vencimento = parseDataBR(item.vencimento);
                    if (item.data_limite !== undefined) item.data_limite = parseDataBR(item.data_limite);
                    item.sinc = true;
                    await putToStore(store, item);
                }
            }
        } else if (remoteData.error === "Acesso negado.") {
            logout();
        }
    } catch (e) {
        console.warn('Pull falhou:', e);
    }
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
        setTimeout(() => { if (el.innerHTML === '✅ Sincronizado') el.innerHTML = '🔄 Sincronizado'; }, 2000);
    } else if (status === 'erro') {
        el.innerHTML = '⚠️ Erro de sincronia';
        el.className = 'sync-status status-pending';
    } else if (status === 'offline') {
        el.innerHTML = '📴 Offline';
        el.className = 'sync-status status-pending';
    } else {
        const unsyncedCount = transacoes.filter(t => !t.sinc).length + contas.filter(c => !c.sinc).length + metas.filter(m => !m.sinc).length;
        if (unsyncedCount > 0) {
            el.innerHTML = `⚠️ ${unsyncedCount} pendente(s)`;
            el.className = 'sync-status status-pending';
        } else {
            el.innerHTML = '✅ Sincronizado';
            el.className = 'sync-status status-synced';
        }
    }
}

async function forcarSincronizacao() {
    const el = document.getElementById('syncStatus');
    if (el) {
        el.style.pointerEvents = 'none';
        atualizarSyncStatus('sincronizando');
    }
    clearRetry();
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    await syncWithServer();
    if (el) el.style.pointerEvents = 'auto';
}

// ============================================================
// UI – SELECTS E CONTROLES
// ============================================================
function atualizarSelectContas() {
    const sel = document.getElementById('tConta');
    const selDestino = document.getElementById('tContaDestino');
    if (!sel) return;
    
    const tTipoEl = document.getElementById('tTipo');
    const tipoAtual = tTipoEl ? tTipoEl.value : 'despesa';
    
    if (tipoAtual === 'receita') {
        sel.innerHTML = '<option value="">Selecione a Conta de Destino...</option>';
    } else if (tipoAtual === 'transferencia') {
        sel.innerHTML = '<option value="">Selecione a Conta de Origem...</option>';
    } else {
        sel.innerHTML = '<option value="">Selecione a Conta/Cartão de Origem...</option>';
    }
    
    if (selDestino) selDestino.innerHTML = '<option value="">Selecione a Conta de Destino...</option>';
    
    contas.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
        if (selDestino) selDestino.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
    
    const selMeta = document.getElementById('mConta');
    if (selMeta) {
        selMeta.innerHTML = '<option value="">Nenhuma</option>';
        contas.forEach(c => { selMeta.innerHTML += `<option value="${c.id}">${c.nome}</option>`; });
    }
}

function atualizarSelectCategorias() {
    const sel = document.getElementById('tCategoria');
    if (!sel) return;
    sel.innerHTML = '';
    categorias.filter(c => c.id !== 'cat_transferencia').forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
}

function atualizarFiltroCategorias() {
    const sel = document.getElementById('categoryFilter');
    if (!sel) return;
    sel.innerHTML = '<option value="">📂 Todas categorias</option>';
    categorias.filter(c => c.id !== 'cat_transferencia').forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
}

function toggleTransferencia() {
    const tipo = document.getElementById('tTipo').value;
    const contaDestino = document.getElementById('tContaDestino');
    const categoria = document.getElementById('tCategoria');
    const parcelas = document.getElementById('tParcelas');
    const contaOrigem = document.getElementById('tConta');
    
    atualizarSelectContas();
    
    if (tipo === 'transferencia') {
        if (contaDestino) contaDestino.style.display = 'block';
        if (categoria) {
            categoria.disabled = true;
            categoria.value = 'cat_transferencia';
        }
        if (parcelas) {
            parcelas.disabled = true;
            parcelas.value = '1';
        }
    } else if (tipo === 'receita') {
        if (contaDestino) contaDestino.style.display = 'none';
        if (categoria) categoria.disabled = false;
        if (parcelas) {
            parcelas.disabled = true;
            parcelas.value = '1';
        }
        if (contaOrigem) contaOrigem.style.display = 'block';
    } else {
        if (contaDestino) contaDestino.style.display = 'none';
        if (categoria) categoria.disabled = false;
        if (parcelas) parcelas.disabled = false;
        if (contaOrigem) contaOrigem.style.display = 'block';
    }
}

// ============================================================
// DASHBOARD
// ============================================================
function getTransacoesPeriodoBase() {
    let dataInicio = filtroDataInicio;
    let dataFim = filtroDataFim;
    
    if (!dataInicio || !dataFim) {
        if (!mesAtual) return [];
        const [ano, mes] = mesAtual.split('-');
        dataInicio = `${ano}-${mes}-01`;
        const ultimoDia = new Date(parseInt(ano), parseInt(mes), 0).getDate();
        dataFim = `${ano}-${mes}-${String(ultimoDia).padStart(2,'0')}`;
    }
    return transacoes.filter(t => t.pago && t.data >= dataInicio && t.data <= dataFim);
}

function atualizarDashboard() {
    const searchTerm = document.getElementById('globalSearch').value.toLowerCase();
    const catFilter = document.getElementById('categoryFilter').value;
    
    let transacoesPeriodo = getTransacoesPeriodoBase();
    let transacoesFiltradas = transacoesPeriodo.filter(t => {
        if (searchTerm && !t.descricao.toLowerCase().includes(searchTerm)) return false;
        if (catFilter && t.categoria_id !== catFilter) return false;
        return true;
    });
    
    let receitasFiltradas = 0, despesasFiltradas = 0;
    transacoesFiltradas.forEach(t => {
        if (t.categoria_id === 'cat_transferencia') return;
        const val = Number(t.valor) || 0;
        if (t.tipo === 'receita') receitasFiltradas += val;
        else if (t.tipo === 'despesa') despesasFiltradas += val;
    });
    
    let montanteTotal = 0;
    let htmlContas = '';
    
    contas.forEach(conta => {
        let saldoConta = Number(conta.tipo === 'corrente' ? conta.saldo_inicial : conta.limite) || 0;
        
        transacoes.forEach(t => {
            if (t.conta_id === conta.id && t.pago) {
                let v = Number(t.valor) || 0;
                if (t.tipo === 'receita') saldoConta += v;
                if (t.tipo === 'despesa') saldoConta -= v;
            }
        });
        
        htmlContas += `<div class="card" style="margin-bottom:10px; text-align:left; display:flex; justify-content:space-between; align-items:center;">
            <div><strong>${conta.nome}</strong> (${conta.tipo})<br>
            ${conta.tipo === 'cartao' ? 'Limite Disp.' : 'Saldo'}: R$ ${saldoConta.toFixed(2)}</div>
            <button onclick="editarConta('${conta.id}')" style="width:auto; padding:5px; margin:0; background:none; border:none; font-size:18px; cursor:pointer;">✏️</button>
        </div>`;
        
        // Montante Total deve incluir apenas Contas Correntes
        if (conta.tipo === 'corrente') {
            montanteTotal += saldoConta;
        }
    });
    
    // Injeção de valores na interface com fallback de segurança
    const elSaldoTotal = document.getElementById('saldoTotal');
    const elTotalRec = document.getElementById('totalRec');
    const elTotalDes = document.getElementById('totalDes');

    if(elSaldoTotal) elSaldoTotal.innerText = `R$ ${(montanteTotal || 0).toFixed(2)}`;
    if(elTotalRec) elTotalRec.innerText = `R$ ${(receitasFiltradas || 0).toFixed(2)}`;
    if(elTotalDes) elTotalDes.innerText = `R$ ${(despesasFiltradas || 0).toFixed(2)}`;
    
    document.getElementById('listaContas').innerHTML = htmlContas;
    
    let htmlTransacoes = '';
    transacoesFiltradas.sort((a,b) => (a.data < b.data ? 1 : -1));
    transacoesFiltradas.forEach(t => {
        const categoriaNome = categorias.find(c => c.id === t.categoria_id)?.nome || 'Sem categoria';
        const dataFormatada = formatarDataBR(t.data);
        const isTransfer = t.categoria_id === 'cat_transferencia';
        const tipoIcon = isTransfer ? '🔄' : (t.tipo === 'receita' ? '💰' : '💸');
        const valorFormatado = (Number(t.valor) || 0).toFixed(2);
        
        htmlTransacoes += `<div style="padding:12px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
            <div style="flex:1;">
                <strong>${tipoIcon} ${t.descricao}</strong><br>
                <small style="opacity:0.7;">${dataFormatada} - ${categoriaNome} - ${t.pago ? '✅ Pago' : '⏳ Pendente'}</small>
                ${t.foto ? `<br><a href="#" onclick="abrirZoom('${t.foto}')" style="color:var(--p);font-size:12px;">📎 Ver comprovante</a>` : ''}
            </div>
            <div style="text-align:right; min-width: 90px;">
                <div style="color: ${t.tipo === 'receita' ? 'var(--s)' : 'var(--d)'}; font-weight:bold;">
                    R$ ${valorFormatado}
                </div>
                <button onclick="editarTransacao('${t.id}')" style="width:auto; padding:4px 8px; margin:4px 0 0; background:var(--p); font-size:12px;">✏️ Editar</button>
            </div>
        </div>`;
    });
    document.getElementById('listaTransacoes').innerHTML = htmlTransacoes || '<div class="card">Nenhuma transação no período com os filtros aplicados.</div>';
    
    let htmlMetas = '';
    metas.forEach(m => {
        let vAtual = Number(m.valor_atual) || 0;
        let vObjetivo = Number(m.valor_objetivo) || 1;
        let pct = Math.min((vAtual / vObjetivo) * 100, 100).toFixed(1);
        htmlMetas += `<div class="card" style="margin-bottom:10px; text-align:left; display:flex; justify-content:space-between; align-items:center;">
            <div style="width:80%;">
                <strong>${m.nome}</strong> - ${pct}%<br>
                <progress value="${vAtual}" max="${vObjetivo}" style="width:100%; height:8px; border-radius:10px;"></progress>
                <small>R$ ${vAtual.toFixed(2)} / R$ ${vObjetivo.toFixed(2)}</small>
            </div>
            <button onclick="editarMeta('${m.id}')" style="width:auto; padding:5px; margin:0; background:none; border:none; font-size:18px; cursor:pointer;">✏️</button>
        </div>`;
    });
    document.getElementById('listaMetas').innerHTML = htmlMetas;
}

function verificarPendencias() {
    const tzOffset = (new Date()).getTimezoneOffset() * 60000;
    const hoje = (new Date(Date.now() - tzOffset)).toISOString().slice(0, 10);
    const pendentes = transacoes.filter(t => !t.pago && t.data <= hoje);
    const alertasDiv = document.getElementById('alertasPendentes');
    if (pendentes.length > 0) {
        alertasDiv.innerText = `⚠️ Aviso: ${pendentes.length} transação(ões) pendente(s) ou vencida(s)!`;
        alertasDiv.style.display = 'block';
    } else {
        alertasDiv.innerText = '';
        alertasDiv.style.display = 'none';
    }
}

// ============================================================
// CRUD – TRANSAÇÕES, CONTAS, METAS
// ============================================================
let salvando = false;

async function salvarTransacao() {
    if (salvando) return;
    salvando = true;
    const btn = document.querySelector('#modalTransacao button[onclick="salvarTransacao()"]');
    if (btn) btn.disabled = true;
    try {
        const idEdit = document.getElementById('tId').value;
        const descricao = document.getElementById('tDescricao').value;
        const valorTotal = parseFloat(document.getElementById('tValor').value);
        const dataInput = document.getElementById('tData').value;
        const parcelas = parseInt(document.getElementById('tParcelas').value) || 1;
        const tipo = document.getElementById('tTipo').value;
        const contaId = document.getElementById('tConta').value;
        const categoriaId = document.getElementById('tCategoria').value;
        const pago = document.getElementById('tStatus').value === "true";
        const fotoFile = document.getElementById('tFoto').files[0];
        
        let fotoBase64 = null;
        if (fotoFile) fotoBase64 = await resizeImage(fotoFile);
        else if (idEdit) {
            const existente = transacoes.find(t => t.id === idEdit);
            if (existente) fotoBase64 = existente.foto;
        }
        
        if (tipo === 'transferencia') {
            const contaDestinoId = document.getElementById('tContaDestino').value;
            if (!contaDestinoId || contaId === contaDestinoId) {
                alert("Selecione uma conta de destino válida e diferente da origem.");
                return;
            }
            const dataInicial = new Date(dataInput + 'T00:00:00'); 
            const dataStr = dataInicial.toISOString().split('T')[0];
            const idOriginal = uuidv4();
            
            const saida = {
                id: uuidv4(), id_original: idOriginal,
                tipo: 'despesa', descricao: descricao || 'Pagamento Fatura / Transf.',
                valor: valorTotal, data: dataStr,
                conta_id: contaId, categoria_id: 'cat_transferencia',
                pago: pago, parcela_num: 1, parcela_total: 1,
                foto: fotoBase64, sinc: false, updated_at: new Date().toISOString()
            };
            const entrada = {
                id: uuidv4(), id_original: idOriginal,
                tipo: 'receita', descricao: descricao || 'Fatura Recebida',
                valor: valorTotal, data: dataStr,
                conta_id: contaDestinoId, categoria_id: 'cat_transferencia',
                pago: pago, parcela_num: 1, parcela_total: 1,
                foto: fotoBase64, sinc: false, updated_at: new Date().toISOString()
            };
            await salvarItemDB('transacoes', saida);
            await salvarItemDB('transacoes', entrada);
        } else {
            if (idEdit) {
                const index = transacoes.findIndex(t => t.id === idEdit);
                if (index !== -1) {
                    const t = transacoes[index];
                    t.descricao = descricao;
                    t.valor = valorTotal;
                    t.data = dataInput;
                    t.tipo = tipo;
                    t.conta_id = contaId;
                    t.categoria_id = categoriaId;
                    t.pago = pago;
                    t.foto = fotoBase64;
                    t.sinc = false;
                    t.updated_at = new Date().toISOString();
                    await salvarItemDB('transacoes', t);
                }
            } else {
                const dataInicial = new Date(dataInput + 'T00:00:00');
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
                    await salvarItemDB('transacoes', transacao);
                }
            }
        }
        fecharModais();
        scheduleSync();
    } catch (err) {
        console.error(err);
        alert('Erro ao salvar transação.');
    } finally {
        salvando = false;
        if (btn) btn.disabled = false;
    }
}

function salvarConta() {
    const idEdit = document.getElementById('cId').value;
    const nome = document.getElementById('cNome').value;
    const tipo = document.getElementById('cTipo').value;
    const saldoLimite = parseFloat(document.getElementById('cSaldoLimite').value) || 0;
    const vencimento = document.getElementById('cVencimento').value || null;
    
    if (idEdit) {
        const index = contas.findIndex(c => c.id === idEdit);
        if (index !== -1) {
            contas[index].nome = nome;
            contas[index].tipo = tipo;
            contas[index].saldo_inicial = saldoLimite;
            contas[index].limite = saldoLimite;
            contas[index].vencimento = vencimento;
            contas[index].sinc = false;
            contas[index].updated_at = new Date().toISOString();
            salvarItemDB('contas', contas[index]);
        }
    } else {
        const novaConta = {
            id: uuidv4(), nome, tipo, saldo_inicial: saldoLimite, limite: saldoLimite,
            vencimento, sinc: false, updated_at: new Date().toISOString()
        };
        novaContaId = novaConta.id;
        salvarItemDB('contas', novaConta);
    }
    
    if (adicionandoContaParaTransacao && !idEdit) {
        setTimeout(() => {
            atualizarSelectContas();
            document.getElementById('tConta').value = novaContaId;
            document.getElementById('modalConta').classList.remove('active');
            const modaisAtivos = document.querySelectorAll('.modal.active');
            if (modaisAtivos.length === 0) {
                document.getElementById('overlay').classList.remove('active');
            }
            adicionandoContaParaTransacao = false;
            novaContaId = null;
        }, 300);
    } else {
        fecharModais();
    }
    scheduleSync();
}

function salvarMeta() {
    const idEdit = document.getElementById('mId').value;
    const nome = document.getElementById('mNome').value;
    const objetivo = parseFloat(document.getElementById('mObjetivo').value);
    const atual = parseFloat(document.getElementById('mAtual').value) || 0;
    const dataLimite = document.getElementById('mData').value;
    const contaId = document.getElementById('mConta').value;
    if (idEdit) {
        const index = metas.findIndex(m => m.id === idEdit);
        if (index !== -1) {
            metas[index].nome = nome;
            metas[index].valor_objetivo = objetivo;
            metas[index].valor_atual = atual;
            metas[index].data_limite = dataLimite;
            metas[index].conta_id = contaId;
            metas[index].sinc = false;
            metas[index].updated_at = new Date().toISOString();
            salvarItemDB('metas', metas[index]);
        }
    } else {
        const novaMeta = {
            id: uuidv4(), nome, valor_objetivo: objetivo, valor_atual: atual,
            data_limite: dataLimite, conta_id: contaId, sinc: false, updated_at: new Date().toISOString()
        };
        salvarItemDB('metas', novaMeta);
    }
    fecharModais();
    scheduleSync();
}

function editarTransacao(id) {
    const t = transacoes.find(x => x.id === id);
    if (!t) return;
    const isTransfer = t.categoria_id === 'cat_transferencia';
    let related = [];
    if (isTransfer && t.id_original) {
        related = transacoes.filter(x => x.id_original === t.id_original);
    }
    document.getElementById('tId').value = t.id;
    if (isTransfer && related.length === 2) {
        document.getElementById('tTipo').value = 'transferencia';
        toggleTransferencia();
        const outra = related.find(x => x.id !== t.id);
        if (t.tipo === 'despesa') {
            document.getElementById('tConta').value = t.conta_id;
            document.getElementById('tContaDestino').value = outra.conta_id;
        } else {
            document.getElementById('tConta').value = outra.conta_id;
            document.getElementById('tContaDestino').value = t.conta_id;
        }
        document.getElementById('tDescricao').value = t.descricao.replace(' (Fatura Recebida)', '').replace(' (Pagamento Fatura / Transf.)', '');
        document.getElementById('tValor').value = t.valor;
        document.getElementById('tData').value = t.data;
        document.getElementById('tStatus').value = t.pago.toString();
        document.getElementById('tParcelas').value = 1;
        document.getElementById('tParcelas').disabled = true;
    } else {
        document.getElementById('tTipo').value = t.tipo;
        toggleTransferencia();
        document.getElementById('tDescricao').value = t.descricao;
        document.getElementById('tValor').value = t.valor;
        document.getElementById('tData').value = t.data;
        document.getElementById('tConta').value = t.conta_id;
        document.getElementById('tCategoria').value = t.categoria_id;
        document.getElementById('tStatus').value = t.pago.toString();
        document.getElementById('tParcelas').value = t.parcela_total || 1;
        document.getElementById('tParcelas').disabled = t.tipo === 'receita';
    }
    document.getElementById('tTituloModal').innerText = isTransfer ? 'Editar Transferência' : 'Editar Transação';
    document.getElementById('btnExcluirTransacao').style.display = 'block';
    abrirModal('modalTransacao');
}

function editarConta(id) {
    const c = contas.find(x => x.id === id);
    if (!c) return;
    document.getElementById('cId').value = c.id;
    document.getElementById('cNome').value = c.nome;
    document.getElementById('cTipo').value = c.tipo;
    document.getElementById('cSaldoLimite').value = c.tipo === 'cartao' ? c.limite : c.saldo_inicial;
    document.getElementById('cVencimento').value = c.vencimento || '';
    document.getElementById('cTituloModal').innerText = 'Editar Conta / Cartão';
    document.getElementById('btnExcluirConta').style.display = 'block';
    abrirModal('modalConta');
}

function editarMeta(id) {
    const m = metas.find(x => x.id === id);
    if (!m) return;
    document.getElementById('mId').value = m.id;
    document.getElementById('mNome').value = m.nome;
    document.getElementById('mObjetivo').value = m.valor_objetivo;
    document.getElementById('mAtual').value = m.valor_atual;
    document.getElementById('mData').value = m.data_limite || '';
    document.getElementById('mConta').value = m.conta_id || '';
    document.getElementById('mTituloModal').innerText = 'Editar Cofrinho';
    document.getElementById('btnExcluirMeta').style.display = 'block';
    abrirModal('modalMeta');
}

// ============================================================
// MODAIS E FILTROS
// ============================================================
function abrirModal(id) {
    document.getElementById(id).classList.add('active');
    document.getElementById('overlay').classList.add('active');
    if (id === 'modalTransacao' && !document.getElementById('tId').value) {
        document.getElementById('tFoto').value = '';
        document.getElementById('tTipo').value = 'despesa';
        toggleTransferencia();
        const tzOffset = (new Date()).getTimezoneOffset() * 60000;
        document.getElementById('tData').value = (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
    }
}

function fecharModais() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
    document.getElementById('overlay').classList.remove('active');
    
    // Reseta chat
    chatFluxo = { ativo: false, etapa: 0, dadosTemp: {} };
    const chatMsg = document.getElementById('chatMessages');
    if (chatMsg) chatMsg.innerHTML = '';
    const quick = document.getElementById('chatQuickReplies');
    if (quick) {
        quick.innerHTML = '';
        quick.style.display = 'none';
    }
    const input = document.getElementById('chatInput');
    if (input) input.value = '';
    
    // Reseta formulários
    document.getElementById('tId').value = '';
    if (document.getElementById('cId')) document.getElementById('cId').value = '';
    if (document.getElementById('mId')) document.getElementById('mId').value = '';
    document.getElementById('tTituloModal').innerText = 'Nova Transação';
    document.getElementById('cTituloModal').innerText = 'Nova Conta / Cartão';
    document.getElementById('mTituloModal').innerText = 'Novo Cofrinho';
    document.getElementById('tParcelas').disabled = false;
    document.getElementById('btnExcluirTransacao').style.display = 'none';
    document.getElementById('btnExcluirConta').style.display = 'none';
    document.getElementById('btnExcluirMeta').style.display = 'none';
    document.getElementById('tDescricao').value = '';
    document.getElementById('tValor').value = '';
    if (document.getElementById('cNome')) document.getElementById('cNome').value = '';
    if (document.getElementById('cSaldoLimite')) document.getElementById('cSaldoLimite').value = '';
    if (document.getElementById('mNome')) document.getElementById('mNome').value = '';
    if (document.getElementById('mObjetivo')) document.getElementById('mObjetivo').value = '';
    if (document.getElementById('mAtual')) document.getElementById('mAtual').value = '';
    if (document.getElementById('tFoto')) document.getElementById('tFoto').value = '';
    document.getElementById('tTipo').value = 'despesa';
    toggleTransferencia();
    document.getElementById('tContaDestino').value = '';
}

function adicionarContaDoModalTransacao() {
    adicionandoContaParaTransacao = true;
    abrirModal('modalConta');
}

function aplicarFiltroData() {
    const inicio = document.getElementById('dataInicioFiltro').value;
    const fim = document.getElementById('dataFimFiltro').value;
    filtroDataInicio = inicio;
    filtroDataFim = fim;
    atualizarDashboard();
}

function limparFiltroData() {
    document.getElementById('dataInicioFiltro').value = '';
    document.getElementById('dataFimFiltro').value = '';
    filtroDataInicio = '';
    filtroDataFim = '';
    atualizarDashboard();
}

function abrirZoom(base64) {
    const viewer = document.getElementById('imageViewer');
    const img = document.getElementById('zoomImg');
    img.src = base64;
    img.style.transform = 'scale(1)';
    viewer.style.display = 'flex';
    img.onclick = () => fecharZoom();
    viewer.onclick = (e) => {
        if (e.target === viewer) fecharZoom();
    };
}

function fecharZoom() {
    document.getElementById('imageViewer').style.display = 'none';
    const img = document.getElementById('zoomImg');
    img.onclick = null;
    document.getElementById('imageViewer').onclick = null;
}

function aplicarZoom(img) {
    img.style.transform = img.style.transform === 'scale(2)' ? 'scale(1)' : 'scale(2)';
}

function baixarRelatorio() {
    const ini = document.getElementById('eDataIni').value;
    const fim = document.getElementById('eDataFim').value;
    let filtrado = transacoes.filter(t => t.data >= ini && t.data <= fim);
    let csv = "Data,Tipo,Descrição,Valor,Status,Categoria\n";
    filtrado.forEach(t => {
        const catNome = categorias.find(c => c.id === t.categoria_id)?.nome || '';
        csv += `${t.data},${t.tipo},${t.descricao},${t.valor},${t.pago ? 'Pago' : 'Pendente'},${catNome}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relatorio_financas.csv';
    a.click();
    URL.revokeObjectURL(url);
}

function baixarPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const ini = document.getElementById('eDataIni').value;
    const fim = document.getElementById('eDataFim').value;
    let filtrado = transacoes.filter(t => t.data >= ini && t.data <= fim);
    const tableData = filtrado.map(t => [
        t.data, t.tipo, t.descricao, `R$ ${t.valor.toFixed(2)}`,
        t.pago ? 'Pago' : 'Pendente',
        categorias.find(c => c.id === t.categoria_id)?.nome || ''
    ]);
    doc.text('Relatório de Transações', 14, 16);
    doc.autoTable({ head: [['Data', 'Tipo', 'Descrição', 'Valor', 'Status', 'Categoria']], body: tableData, startY: 20 });
    doc.save('relatorio.pdf');
}

// ============================================================
// EVENTOS GLOBAIS
// ============================================================
document.getElementById('monthPicker').addEventListener('change', (e) => {
    mesAtual = e.target.value;
    document.getElementById('dataInicioFiltro').value = '';
    document.getElementById('dataFimFiltro').value = '';
    filtroDataInicio = '';
    filtroDataFim = '';
    atualizarDashboard();
});
document.getElementById('globalSearch').addEventListener('input', () => atualizarDashboard());
document.getElementById('categoryFilter').addEventListener('change', () => atualizarDashboard());
document.getElementById('dataInicioFiltro').addEventListener('change', aplicarFiltroData);
document.getElementById('dataFimFiltro').addEventListener('change', aplicarFiltroData);
document.getElementById('monthPicker').value = mesAtual;

if (document.getElementById('tTipo')) {
    document.getElementById('tTipo').addEventListener('change', toggleTransferencia);
}

window.addEventListener('online', () => {
    if (authToken) scheduleSync(true);
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && authToken && navigator.onLine) {
        const temPendencias = transacoes.some(t => !t.sinc) || contas.some(c => !c.sinc) || metas.some(m => !m.sinc);
        if (temPendencias) scheduleSync(true);
    }
});

window.addEventListener('load', () => { checkStoredToken(); });

// ============================================================
// CHAT – ASSISTENTE FINANCEIRO
// ============================================================
let chatFluxo = {
    ativo: false,
    etapa: 0,
    dadosTemp: {}
};

function iniciarChat() {
    chatFluxo = { ativo: true, etapa: 0, dadosTemp: { fotoBase64: null } };
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('chatQuickReplies').style.display = 'none';
    document.getElementById('chatInput').value = '';
    
    document.getElementById('modalChat').classList.add('active');
    document.getElementById('overlay').classList.add('active');
    
    setTimeout(() => {
        adicionarBalaoChat('bot', 'Olá! O que você quer registrar agora?');
        mostrarBotoesRapidos([
            { label: '💸 Despesa', valor: 'despesa' },
            { label: '💰 Receita', valor: 'receita' },
            { label: '🔄 Transferência', valor: 'transferencia' }
        ]);
    }, 300);
}

function adicionarBalaoChat(remetente, texto) {
    const chat = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-bubble chat-${remetente}`;
    div.innerText = texto;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function mostrarBotoesRapidos(opcoes) {
    const container = document.getElementById('chatQuickReplies');
    container.innerHTML = '';
    if (opcoes.length === 0) {
        container.style.display = 'none';
        return;
    }
    opcoes.forEach(op => {
        const btn = document.createElement('button');
        btn.className = 'chat-quick-btn';
        btn.innerText = op.label;
        btn.onclick = () => processarMensagemChat(op.valor, op.label);
        container.appendChild(btn);
    });
    container.style.display = 'flex';
}

function enviarMensagemChatInput() {
    const input = document.getElementById('chatInput');
    const texto = input.value.trim();
    if (!texto) return;
    input.value = '';
    processarMensagemChat(texto, texto);
}

function processarMensagemChat(valor, labelExibicao) {
    adicionarBalaoChat('user', labelExibicao);
    mostrarBotoesRapidos([]);
    
    const etapaAtual = chatFluxo.etapa;
    
    // Etapa 0: tipo
    if (etapaAtual === 0) {
        chatFluxo.dadosTemp.tipo = valor.toLowerCase().trim();
        chatFluxo.etapa = 1;
        setTimeout(() => adicionarBalaoChat('bot', 'Qual é o valor? (ex: 150,50 ou 200)'), 500);
    }
    // Etapa 1: valor
    else if (etapaAtual === 1) {
        let v = parseFloat(valor.replace('R$', '').replace(',', '.').trim());
        if (isNaN(v) || v <= 0) {
            setTimeout(() => adicionarBalaoChat('bot', 'Isso não parece um valor válido. Por favor, digite apenas o número (ex: 45,90).'), 500);
            return;
        }
        chatFluxo.dadosTemp.valor = v;
        chatFluxo.etapa = 2;
        setTimeout(() => adicionarBalaoChat('bot', 'Qual é a descrição? (ex: Mercado, Gasolina, Salário)'), 500);
    }
    // Etapa 2: descrição
    else if (etapaAtual === 2) {
        chatFluxo.dadosTemp.descricao = valor;
        chatFluxo.etapa = 3;
        setTimeout(() => {
            let msg = 'Em qual conta/cartão?';
            if (chatFluxo.dadosTemp.tipo === 'transferencia') {
                msg = 'De qual conta/cartão vai SAIR o dinheiro?';
            } else if (chatFluxo.dadosTemp.tipo === 'receita') {
                msg = 'Em qual conta o dinheiro vai ENTRAR?';
            }
            adicionarBalaoChat('bot', msg);
            let opsContas = contas.map(c => ({ label: c.nome, valor: c.id }));
            mostrarBotoesRapidos(opsContas);
        }, 500);
    }
    // Etapa 3: conta de origem
    else if (etapaAtual === 3) {
        chatFluxo.dadosTemp.conta_id = valor;
        const contaSelecionada = contas.find(c => c.id === valor);
        
        if (chatFluxo.dadosTemp.tipo === 'transferencia') {
            chatFluxo.etapa = 3.5;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Para qual conta o dinheiro vai ENTRAR?');
                let opsContasDestino = contas.filter(c => c.id !== valor).map(c => ({ label: c.nome, valor: c.id }));
                mostrarBotoesRapidos(opsContasDestino);
            }, 500);
        }
        else if (chatFluxo.dadosTemp.tipo === 'despesa' && contaSelecionada && contaSelecionada.tipo === 'cartao') {
            chatFluxo.etapa = 3.1;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Em quantas vezes deseja parcelar? (digite o número, ex: 3)');
            }, 500);
        } else {
            chatFluxo.etapa = 4;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Qual é a categoria?');
                let opsCat = categorias.filter(c => c.id !== 'cat_transferencia').map(c => ({ label: c.nome, valor: c.id }));
                mostrarBotoesRapidos(opsCat);
            }, 500);
        }
    }
    // Etapa 3.1: parcelas (somente despesa com cartão)
    else if (etapaAtual === 3.1) {
        let parcelas = parseInt(valor);
        if (isNaN(parcelas) || parcelas < 1) {
            setTimeout(() => adicionarBalaoChat('bot', 'Por favor, digite um número válido de parcelas (mínimo 1).'), 500);
            return;
        }
        chatFluxo.dadosTemp.parcelas = parcelas;
        chatFluxo.etapa = 4;
        setTimeout(() => {
            adicionarBalaoChat('bot', 'Qual é a categoria?');
            let opsCat = categorias.filter(c => c.id !== 'cat_transferencia').map(c => ({ label: c.nome, valor: c.id }));
            mostrarBotoesRapidos(opsCat);
        }, 500);
    }
    // Etapa 3.5: conta destino (transferência)
    else if (etapaAtual === 3.5) {
        chatFluxo.dadosTemp.conta_destino_id = valor;
        chatFluxo.etapa = 4.5;
        setTimeout(() => {
            adicionarBalaoChat('bot', 'Quando ocorreu essa transferência?');
            mostrarBotoesRapidos([
                {label: '📅 Hoje', valor: 'hoje'},
                {label: '📅 Ontem', valor: 'ontem'},
                {label: '🗓️ Outra data', valor: 'outra'}
            ]);
        }, 500);
    }
    // Etapa 4: categoria
    else if (etapaAtual === 4) {
        chatFluxo.dadosTemp.categoria_id = valor;
        chatFluxo.etapa = 4.5;
        setTimeout(() => {
            adicionarBalaoChat('bot', 'Quando ocorreu essa transação?');
            mostrarBotoesRapidos([
                {label: '📅 Hoje', valor: 'hoje'},
                {label: '📅 Ontem', valor: 'ontem'},
                {label: '🗓️ Outra data', valor: 'outra'}
            ]);
        }, 500);
    }
    // Etapa 4.5: Escolha da Data
    else if (etapaAtual === 4.5) {
        const tzOffset = (new Date()).getTimezoneOffset() * 60000;
        let hoje = new Date(Date.now() - tzOffset);
        
        if (valor === 'hoje') {
            chatFluxo.dadosTemp.data = hoje.toISOString().split('T')[0];
            avancarParaConfirmacaoChat();
        } else if (valor === 'ontem') {
            let ontem = new Date(hoje);
            ontem.setDate(ontem.getDate() - 1);
            chatFluxo.dadosTemp.data = ontem.toISOString().split('T')[0];
            avancarParaConfirmacaoChat();
        } else if (valor === 'outra') {
            chatFluxo.etapa = 4.6;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Digite a data no formato DD/MM (ex: 25/12):');
            }, 500);
        } else {
            // Caso o usuário tenha digitado a data diretamente
            if (/^\d{2}\/\d{2}$/.test(valor) || /^\d{2}\/\d{2}\/\d{4}$/.test(valor)) {
                let partes = valor.split('/');
                let dia = partes[0].padStart(2, '0');
                let mes = partes[1].padStart(2, '0');
                let ano = partes.length === 3 ? partes[2] : hoje.getFullYear();
                chatFluxo.dadosTemp.data = `${ano}-${mes}-${dia}`;
                avancarParaConfirmacaoChat();
            } else {
                adicionarBalaoChat('bot', 'Data não reconhecida. Por favor, escolha um botão ou digite no formato DD/MM.');
                mostrarBotoesRapidos([
                    {label: '📅 Hoje', valor: 'hoje'},
                    {label: '📅 Ontem', valor: 'ontem'},
                    {label: '🗓️ Outra data', valor: 'outra'}
                ]);
            }
        }
    }
    // Etapa 4.6: Digitar Outra Data
    else if (etapaAtual === 4.6) {
        if (/^\d{2}\/\d{2}$/.test(valor) || /^\d{2}\/\d{2}\/\d{4}$/.test(valor)) {
            const tzOffset = (new Date()).getTimezoneOffset() * 60000;
            let hoje = new Date(Date.now() - tzOffset);
            let partes = valor.split('/');
            let dia = partes[0].padStart(2, '0');
            let mes = partes[1].padStart(2, '0');
            let ano = partes.length === 3 ? partes[2] : hoje.getFullYear();
            chatFluxo.dadosTemp.data = `${ano}-${mes}-${dia}`;
            avancarParaConfirmacaoChat();
        } else {
            adicionarBalaoChat('bot', 'Formato inválido. Digite no formato DD/MM (ex: 25/12):');
        }
    }
    // Etapa 5: confirmação
    else if (etapaAtual === 5) {
        if (valor === 'sim') {
            chatFluxo.etapa = 6;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Deseja anexar uma foto do comprovante?');
                mostrarBotoesRapidos([
                    {label: '📷 Sim, anexar', valor: 'foto_sim'},
                    {label: '⏭️ Pular', valor: 'foto_nao'}
                ]);
            }, 500);
        } else {
            adicionarBalaoChat('bot', 'Certo, lançamento cancelado! 🧹');
            setTimeout(() => fecharModais(), 1500);
        }
    }
    // Etapa 6: foto
    else if (etapaAtual === 6) {
        if (valor === 'foto_sim') {
            document.getElementById('chatFotoInput').click();
        } else if (valor === 'foto_nao') {
            finalizarSalvamentoChat(null);
        }
    }
    // Etapa 7: após salvar, pergunta sobre resumo
    else if (etapaAtual === 7) {
        if (valor === 'resumo_sim') {
            mostrarResumoMes();
            chatFluxo.etapa = 8;
            setTimeout(() => {
                mostrarBotoesRapidos([
                    {label: '➕ Nova Transação', valor: 'nova'},
                    {label: '🚪 Sair', valor: 'sair'}
                ]);
            }, 500);
        } else if (valor === 'resumo_nao') {
            adicionarBalaoChat('bot', 'Ok! Até a próxima 👋');
            setTimeout(() => fecharModais(), 1500);
        }
    }
    // Etapa 8: pós resumo, escolher ação
    else if (etapaAtual === 8) {
        if (valor === 'nova') {
            chatFluxo = { ativo: true, etapa: 0, dadosTemp: { fotoBase64: null } };
            document.getElementById('chatMessages').innerHTML = '';
            document.getElementById('chatQuickReplies').innerHTML = '';
            document.getElementById('chatQuickReplies').style.display = 'none';
            setTimeout(() => {
                adicionarBalaoChat('bot', 'O que você quer registrar agora?');
                mostrarBotoesRapidos([
                    { label: '💸 Despesa', valor: 'despesa' },
                    { label: '💰 Receita', valor: 'receita' },
                    { label: '🔄 Transferência', valor: 'transferencia' }
                ]);
            }, 300);
        } else if (valor === 'sair') {
            fecharModais();
        }
    }
}

function avancarParaConfirmacaoChat() {
    chatFluxo.etapa = 5;
    setTimeout(() => {
        const conta = contas.find(c => c.id === chatFluxo.dadosTemp.conta_id)?.nome;
        const cat = categorias.find(c => c.id === chatFluxo.dadosTemp.categoria_id)?.nome;
        const dataStr = formatarDataBR(chatFluxo.dadosTemp.data);
        const icone = chatFluxo.dadosTemp.tipo === 'despesa' ? '💸' : '💰';
        
        let resumo = '';
        if (chatFluxo.dadosTemp.tipo === 'transferencia') {
            const destino = contas.find(c => c.id === chatFluxo.dadosTemp.conta_destino_id)?.nome;
            resumo = `Resumo:\n🔄 Transf. de R$ ${chatFluxo.dadosTemp.valor.toFixed(2)}\nDe: ${conta}\nPara: ${destino}\nDesc: ${chatFluxo.dadosTemp.descricao}\nData: ${dataStr}\n\nPosso salvar?`;
        } else {
            resumo = `${icone} ${chatFluxo.dadosTemp.tipo.toUpperCase()} - R$ ${chatFluxo.dadosTemp.valor.toFixed(2)}\nDesc: ${chatFluxo.dadosTemp.descricao}\nConta: ${conta}\nCat: ${cat}\nData: ${dataStr}`;
            if (chatFluxo.dadosTemp.parcelas && chatFluxo.dadosTemp.parcelas > 1) {
                resumo += `\n📆 Parcelas: ${chatFluxo.dadosTemp.parcelas}x`;
            }
            resumo += '\n\nPosso salvar?';
        }
        
        adicionarBalaoChat('bot', resumo);
        mostrarBotoesRapidos([{label: '✅ Sim, salvar', valor: 'sim'}, {label: '❌ Cancelar', valor: 'nao'}]);
    }, 500);
}

async function handleChatPhoto() {
    const fileInput = document.getElementById('chatFotoInput');
    const file = fileInput.files[0];
    if (!file) {
        chatFluxo.etapa = 6;
        adicionarBalaoChat('bot', 'Nenhuma foto selecionada. Deseja anexar uma foto?');
        mostrarBotoesRapidos([
            {label: '📷 Sim, anexar', valor: 'foto_sim'},
            {label: '⏭️ Pular', valor: 'foto_nao'}
        ]);
        return;
    }
    try {
        const base64 = await resizeImage(file);
        chatFluxo.dadosTemp.fotoBase64 = base64;
        adicionarBalaoChat('bot', '📸 Foto anexada! Salvando...');
        setTimeout(() => {
            finalizarSalvamentoChat(base64);
        }, 600);
    } catch (err) {
        console.error(err);
        adicionarBalaoChat('bot', '❌ Erro ao processar a foto. Salvando sem foto.');
        setTimeout(() => {
            finalizarSalvamentoChat(null);
        }, 600);
    }
    fileInput.value = '';
}

async function finalizarSalvamentoChat(fotoBase64) {
    adicionarBalaoChat('bot', '⏳ Salvando e sincronizando...');
    const dataStr = chatFluxo.dadosTemp.data;
    const parcelas = chatFluxo.dadosTemp.parcelas || 1;
    
    try {
        if (chatFluxo.dadosTemp.tipo === 'transferencia') {
            const idOriginal = uuidv4();
            const saida = {
                id: uuidv4(), id_original: idOriginal,
                tipo: 'despesa', descricao: chatFluxo.dadosTemp.descricao,
                valor: chatFluxo.dadosTemp.valor, data: dataStr,
                conta_id: chatFluxo.dadosTemp.conta_id, categoria_id: 'cat_transferencia',
                pago: true, parcela_num: 1, parcela_total: 1,
                foto: fotoBase64 || null, sinc: false, updated_at: new Date().toISOString()
            };
            const entrada = {
                id: uuidv4(), id_original: idOriginal,
                tipo: 'receita', descricao: chatFluxo.dadosTemp.descricao,
                valor: chatFluxo.dadosTemp.valor, data: dataStr,
                conta_id: chatFluxo.dadosTemp.conta_destino_id, categoria_id: 'cat_transferencia',
                pago: true, parcela_num: 1, parcela_total: 1,
                foto: fotoBase64 || null, sinc: false, updated_at: new Date().toISOString()
            };
            await salvarItemDB('transacoes', saida);
            await salvarItemDB('transacoes', entrada);
        } else {
            const idOriginal = uuidv4();
            const dataInicial = new Date(dataStr + 'T00:00:00');
            const valorParcela = chatFluxo.dadosTemp.valor / parcelas;
            for (let i = 0; i < parcelas; i++) {
                let dataParcela = new Date(dataInicial);
                dataParcela.setMonth(dataParcela.getMonth() + i);
                const transacao = {
                    id: uuidv4(),
                    id_original: idOriginal,
                    tipo: chatFluxo.dadosTemp.tipo,
                    descricao: parcelas > 1 ? `${chatFluxo.dadosTemp.descricao} (${i+1}/${parcelas})` : chatFluxo.dadosTemp.descricao,
                    valor: valorParcela,
                    data: dataParcela.toISOString().split('T')[0],
                    conta_id: chatFluxo.dadosTemp.conta_id,
                    categoria_id: chatFluxo.dadosTemp.categoria_id,
                    pago: true,
                    parcela_num: i + 1,
                    parcela_total: parcelas,
                    foto: fotoBase64 || null,
                    sinc: false,
                    updated_at: new Date().toISOString()
                };
                await salvarItemDB('transacoes', transacao);
            }
        }
        adicionarBalaoChat('bot', '✅ Transação registrada com sucesso!');
        scheduleSync();
        chatFluxo.etapa = 7;
        setTimeout(() => {
            adicionarBalaoChat('bot', 'Quer ver o resumo do mês atual?');
            mostrarBotoesRapidos([
                {label: '📊 Sim, mostrar', valor: 'resumo_sim'},
                {label: '❌ Não, sair', valor: 'resumo_nao'}
            ]);
        }, 800);
    } catch (err) {
        console.error(err);
        adicionarBalaoChat('bot', '❌ Erro ao salvar. Tente novamente.');
        setTimeout(() => fecharModais(), 2000);
    }
}

function mostrarResumoMes() {
    const [ano, mes] = mesAtual.split('-');
    const inicio = `${ano}-${mes}-01`;
    const ultimoDia = new Date(parseInt(ano), parseInt(mes), 0).getDate();
    const fim = `${ano}-${mes}-${String(ultimoDia).padStart(2,'0')}`;
    let totalRec = 0, totalDes = 0;
    transacoes.forEach(t => {
        if (t.pago && t.data >= inicio && t.data <= fim && t.categoria_id !== 'cat_transferencia') {
            let v = Number(t.valor) || 0;
            if (t.tipo === 'receita') totalRec += v;
            else if (t.tipo === 'despesa') totalDes += v;
        }
    });
    const saldo = totalRec - totalDes;
    adicionarBalaoChat('bot', `📊 Resumo do mês:\n💰 Receitas: R$ ${totalRec.toFixed(2)}\n💸 Despesas: R$ ${totalDes.toFixed(2)}\n📌 Saldo: R$ ${saldo.toFixed(2)}`);
}
