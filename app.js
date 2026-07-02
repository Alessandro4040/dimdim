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
    if (!authToken) return false;
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
        document.getElementById('lockScreen').classList.add('hidden');
        document.getElementById('appContent').style.display = 'block';
        iniciarApp();
    } catch (e) {
        alert("Erro na autenticação.");
    }
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
            el.innerHTML = `⚠️ ${unsyncedCount} item(s) pendente(s)`;
            el.className = 'sync-status status-pending';
        } else {
            el.innerHTML = '🔄 Tudo certo';
            el.className = 'sync-status status-synced';
        }
    }
}

function forcarSincronizacao() {
    clearRetry();
    scheduleSync(true);
    fecharModais();
}

// ============================================================
// UI & MODAIS
// ============================================================
function abrirModal(id, itemId = null) {
    document.getElementById('overlay').classList.add('active');
    const modal = document.getElementById(id);
    modal.classList.add('active');
    
    if (id === 'modalTransacao') {
        const h3 = document.getElementById('tTituloModal');
        const btnExcluir = document.getElementById('btnExcluirTransacao');
        if (itemId) {
            h3.textContent = 'Editar Transação';
            btnExcluir.style.display = 'block';
            preencherModalTransacao(itemId);
        } else {
            h3.textContent = 'Nova Transação';
            btnExcluir.style.display = 'none';
            document.getElementById('tId').value = '';
            const tData = document.getElementById('tData');
            if (filtroDataInicio && filtroDataInicio.startsWith(mesAtual)) {
                tData.value = filtroDataInicio;
            } else if (filtroDataFim && filtroDataFim.startsWith(mesAtual)) {
                tData.value = filtroDataFim;
            } else {
                const tzOffset = (new Date()).getTimezoneOffset() * 60000;
                tData.value = (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
            }
            document.getElementById('tDescricao').value = '';
            document.getElementById('tValor').value = '';
            document.getElementById('tConta').value = '';
            document.getElementById('tCategoria').value = '';
            document.getElementById('tParcelas').value = '1';
            document.getElementById('tStatus').value = 'true';
            document.getElementById('tFoto').value = '';
            document.getElementById('tContaDestino').style.display = 'none';
        }
    } else if (id === 'modalConta') {
        const h3 = document.getElementById('cTituloModal');
        const btnExcluir = document.getElementById('btnExcluirConta');
        if (itemId) {
            h3.textContent = 'Editar Conta/Cartão';
            btnExcluir.style.display = 'block';
            preencherModalConta(itemId);
        } else {
            h3.textContent = 'Nova Conta/Cartão';
            btnExcluir.style.display = 'none';
            document.getElementById('cId').value = '';
            document.getElementById('cNome').value = '';
            document.getElementById('cTipo').value = 'corrente';
            document.getElementById('cSaldoLimite').value = '';
            document.getElementById('cVencimento').value = '';
        }
    } else if (id === 'modalMeta') {
        const h3 = document.getElementById('mTituloModal');
        const btnExcluir = document.getElementById('btnExcluirMeta');
        if (itemId) {
            h3.textContent = 'Editar Objetivo';
            btnExcluir.style.display = 'block';
            preencherModalMeta(itemId);
        } else {
            h3.textContent = 'Novo Objetivo';
            btnExcluir.style.display = 'none';
            document.getElementById('mId').value = '';
            document.getElementById('mNome').value = '';
            document.getElementById('mObjetivo').value = '';
            document.getElementById('mAtual').value = '';
            document.getElementById('mData').value = '';
            const selMConta = document.getElementById('mConta');
            selMConta.innerHTML = '<option value="">Vincular à conta específica (Opcional)</option>';
            contas.forEach(c => {
                selMConta.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
            });
            selMConta.value = '';
        }
    } else if (id === 'modalExportar') {
        const d1 = new Date(); d1.setDate(1);
        const d2 = new Date(); d2.setMonth(d2.getMonth() + 1, 0);
        document.getElementById('eDataIni').value = d1.toISOString().split('T')[0];
        document.getElementById('eDataFim').value = d2.toISOString().split('T')[0];
    }
}

function fecharModais() {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    document.getElementById('overlay').classList.remove('active');
    if (adicionandoContaParaTransacao) {
        adicionandoContaParaTransacao = false;
        novaContaId = null;
    }
}

function toggleTransferencia() {
    const tipo = document.getElementById('tTipo').value;
    const desc = document.getElementById('tDescricao');
    const parcelas = document.getElementById('tParcelas');
    const dest = document.getElementById('tContaDestino');
    const cat = document.getElementById('tCategoria');
    const contaOrigem = document.getElementById('tConta');

    if (tipo === 'transferencia') {
        desc.value = 'Pagamento/Transferência';
        parcelas.value = '1';
        parcelas.style.display = 'none';
        dest.style.display = 'block';
        cat.value = 'cat_transferencia';
        cat.style.display = 'none';
        
        let origemNome = 'Origem';
        if (contaOrigem.options[contaOrigem.selectedIndex]) {
             origemNome = contaOrigem.options[contaOrigem.selectedIndex].text;
        }
        contaOrigem.options[0].text = 'Selecione a ' + origemNome;
    } else {
        parcelas.style.display = 'block';
        dest.style.display = 'none';
        cat.style.display = 'block';
        if(desc.value === 'Pagamento/Transferência') desc.value = '';
        contaOrigem.options[0].text = 'Selecione a Origem (Conta/Cartão)';
    }
}

function aplicarZoom(img) {
    const viewer = document.getElementById('imageViewer');
    const zoomImg = document.getElementById('zoomImg');
    zoomImg.src = img.src;
    viewer.style.display = 'flex';
}

function fecharZoom() {
    document.getElementById('imageViewer').style.display = 'none';
}

// ============================================================
// ATUALIZAÇÃO DA INTERFACE
// ============================================================
function getTransacoesFiltradas() {
    let tFilt = transacoes;
    const txtFiltro = document.getElementById('globalSearch') ? document.getElementById('globalSearch').value.toLowerCase() : '';
    const catFiltro = document.getElementById('categoryFilter') ? document.getElementById('categoryFilter').value : '';

    if (txtFiltro || catFiltro || filtroDataInicio || filtroDataFim) {
        tFilt = transacoes.filter(t => {
            let pass = true;
            if (txtFiltro) pass = pass && (t.descricao.toLowerCase().includes(txtFiltro) || (t.valor && t.valor.toString().includes(txtFiltro)));
            if (catFiltro) pass = pass && t.categoria_id === catFiltro;
            if (filtroDataInicio) pass = pass && t.data >= filtroDataInicio;
            if (filtroDataFim) pass = pass && t.data <= filtroDataFim;
            return pass;
        });
    } else {
        const picker = document.getElementById('monthPicker');
        if (picker && picker.value) mesAtual = picker.value;
        tFilt = transacoes.filter(t => t.data && t.data.startsWith(mesAtual));
    }
    return tFilt;
}

function calcularDashboard() {
    let rec = 0, des = 0, saldo = 0;
    
    // Contas
    contas.forEach(c => {
        if (c.tipo === 'corrente') {
            saldo += c.saldo_inicial || 0;
            const tConta = transacoes.filter(t => t.conta_id === c.id && t.pago && !t.excluido);
            tConta.forEach(t => {
                if (t.tipo === 'receita') saldo += t.valor;
                if (t.tipo === 'despesa') saldo -= t.valor;
            });
        }
    });

    // Metas
    metas.forEach(m => {
        if (!m.conta_id) saldo -= (m.valor_atual || 0);
    });

    // Filtros
    const tFilt = getTransacoesFiltradas();
    tFilt.forEach(t => {
        if (t.tipo === 'transferencia' || !t.pago || t.excluido) return;
        if (t.tipo === 'receita') rec += t.valor;
        if (t.tipo === 'despesa') des += t.valor;
    });

    return { rec, des, saldo };
}

function atualizarDashboard() {
    const dash = calcularDashboard();
    document.getElementById('saldoTotal').textContent = dash.saldo.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('totalDes').textContent = dash.des.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('totalRec').textContent = dash.rec.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    
    renderizarContas();
    renderizarMetas();
    renderizarTransacoes();
}

function atualizarFiltroCategorias() {
    const s = document.getElementById('categoryFilter');
    if (!s) return;
    s.innerHTML = '<option value="">📂 Todas as categorias</option>';
    const catDesp = categorias.filter(c => c.tipo === 'despesa');
    const catRec = categorias.filter(c => c.tipo === 'receita');
    const catOut = categorias.filter(c => c.tipo === 'outros');

    if(catDesp.length > 0){
        let g = document.createElement('optgroup'); g.label = "Despesas";
        catDesp.forEach(c => g.innerHTML += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
        s.appendChild(g);
    }
    if(catRec.length > 0){
        let g = document.createElement('optgroup'); g.label = "Receitas";
        catRec.forEach(c => g.innerHTML += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
        s.appendChild(g);
    }
    if(catOut.length > 0){
        let g = document.createElement('optgroup'); g.label = "Outros";
        catOut.forEach(c => g.innerHTML += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
        s.appendChild(g);
    }
}

function verificarPendencias() {
    const el = document.getElementById('alertasPendentes');
    if (!el) return;
    const tzOffset = (new Date()).getTimezoneOffset() * 60000;
    const hojeIso = (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
    const tPendentes = transacoes.filter(t => !t.pago && t.data <= hojeIso && !t.excluido).length;
    
    let faturaVencida = 0;
    const diaHoje = new Date().getDate();
    contas.filter(c => c.tipo === 'cartao' && c.vencimento).forEach(c => {
        if (diaHoje >= c.vencimento) faturaVencida++;
    });

    let msg = '';
    if (tPendentes > 0) msg += `⏳ Você tem ${tPendentes} transação(ões) pendente(s) ou atrasada(s).<br>`;
    if (faturaVencida > 0) msg += `⚠️ Atenção: ${faturaVencida} cartão(ões) com fatura próxima ou vencida.`;
    
    el.innerHTML = msg;
}

// ============================================================
// RENDERIZAÇÃO
// ============================================================
function renderizarContas() {
    const lista = document.getElementById('listaContas');
    lista.innerHTML = '';
    contas.forEach(c => {
        let saldoCalc = c.saldo_inicial || 0;
        let gastosCartao = 0;

        const tConta = transacoes.filter(t => t.conta_id === c.id && !t.excluido);
        tConta.forEach(t => {
            if (c.tipo === 'corrente') {
                if (t.pago) {
                    if (t.tipo === 'receita') saldoCalc += t.valor;
                    if (t.tipo === 'despesa') saldoCalc -= t.valor;
                }
            } else if (c.tipo === 'cartao') {
                if (t.tipo === 'despesa') gastosCartao += t.valor;
                if (t.tipo === 'receita') gastosCartao -= t.valor;
            }
        });

        const icon = c.tipo === 'corrente' ? '🏦' : '💳';
        const color = (c.tipo === 'corrente' && saldoCalc < 0) ? 'var(--d)' : (c.tipo === 'cartao' ? 'var(--w)' : 'var(--p)');
        const valorDisp = c.tipo === 'corrente' ? saldoCalc : (c.limite || 0) - gastosCartao;
        const txtDisp = c.tipo === 'corrente' ? 'Saldo Atual' : 'Limite Disponível';

        lista.innerHTML += `
            <div class="item-row" onclick="abrirModal('modalConta', '${c.id}')" style="cursor: pointer;">
                <div>
                    <h4 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">${icon} ${c.nome}</h4>
                    <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--txt-muted);">${txtDisp}</p>
                </div>
                <div style="text-align: right; font-weight: 700; font-size: 1.1rem; color: ${color};">
                    R$ ${valorDisp.toFixed(2)}
                </div>
            </div>`;
    });
}

function renderizarMetas() {
    const lista = document.getElementById('listaMetas');
    lista.innerHTML = '';
    metas.forEach(m => {
        const perc = m.valor_objetivo > 0 ? ((m.valor_atual || 0) / m.valor_objetivo) * 100 : 0;
        lista.innerHTML += `
            <div class="item-row" onclick="abrirModal('modalMeta', '${m.id}')" style="cursor: pointer; flex-direction: column; align-items: stretch; gap: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <h4 style="margin: 0; font-size: 1rem;">🎯 ${m.nome}</h4>
                    <span style="font-weight: 700; font-size: 0.95rem; color: var(--s);">R$ ${(m.valor_atual || 0).toFixed(2)} / R$ ${(m.valor_objetivo || 0).toFixed(2)}</span>
                </div>
                <div style="background: var(--bg); border-radius: 6px; height: 10px; overflow: hidden; width: 100%;">
                    <div style="background: var(--s); width: ${Math.min(perc, 100)}%; height: 100%; border-radius: 6px; transition: width 0.5s;"></div>
                </div>
            </div>`;
    });
}

function renderizarTransacoes() {
    const lista = document.getElementById('listaTransacoes');
    lista.innerHTML = '';
    const tFilt = getTransacoesFiltradas().sort((a, b) => new Date(b.data) - new Date(a.data));
    
    if (tFilt.length === 0) {
        lista.innerHTML = '<p style="text-align: center; color: var(--txt-muted); padding: 20px;">Nenhuma transação encontrada no período.</p>';
        return;
    }
    
    let ultData = null;
    tFilt.forEach(t => {
        if (!t.data) return;
        if (t.data !== ultData) {
            lista.innerHTML += `<div style="padding: 16px 8px 6px; font-weight: 600; font-size: 0.9rem; color: var(--txt-muted); border-bottom: 1px solid var(--border);">${formatarDataBR(t.data)}</div>`;
            ultData = t.data;
        }
        
        let color, txtValor, icone = '🔄';
        if (t.tipo === 'receita') { color = 'var(--s)'; txtValor = `+R$ ${t.valor.toFixed(2)}`; }
        else if (t.tipo === 'despesa') { color = 'var(--d)'; txtValor = `-R$ ${t.valor.toFixed(2)}`; }
        else { color = 'var(--w)'; txtValor = `R$ ${t.valor.toFixed(2)}`; }
        
        const cat = categorias.find(c => c.id === t.categoria_id);
        if (cat) icone = cat.icone;
        
        const styleImg = t.comprovante ? 'border-left: 4px solid var(--p);' : '';
        const opacidade = t.pago ? '1' : '0.6';
        const pendenteLabel = t.pago ? '' : '<span style="font-size: 0.7rem; background: var(--w-light); color: var(--w); padding: 2px 6px; border-radius: 10px; margin-left: 6px;">Pendente</span>';

        lista.innerHTML += `
            <div class="item-row" onclick="abrirModal('modalTransacao', '${t.id}')" style="cursor: pointer; margin-top: 6px; ${styleImg} opacity: ${opacidade};">
                <div style="display: flex; align-items: center; gap: 12px; flex: 1; overflow: hidden;">
                    <div style="font-size: 1.5rem; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; background: var(--bg); border-radius: 50%;">${icone}</div>
                    <div style="flex: 1; overflow: hidden;">
                        <h4 style="margin: 0; font-size: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${t.descricao} ${pendenteLabel}</h4>
                        <p style="margin: 2px 0 0; font-size: 0.8rem; color: var(--txt-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${cat ? cat.nome : ''} ${t.parcela_atual ? `(Parc. ${t.parcela_atual})` : ''}</p>
                    </div>
                </div>
                <div style="text-align: right; font-weight: 700; font-size: 1rem; color: ${color}; white-space: nowrap; padding-left: 10px;">
                    ${txtValor}
                </div>
            </div>`;
    });
}

// ============================================================
// MODAIS PREENCHIMENTO & SALVAR
// ============================================================
function atualizarSelectContas() {
    const selContaT = document.getElementById('tConta');
    const selContaD = document.getElementById('tContaDestino');
    if (selContaT) selContaT.innerHTML = '<option value="">Selecione a Origem (Conta/Cartão)</option><option value="nova_conta">+ Adicionar Conta</option>';
    if (selContaD) selContaD.innerHTML = '<option value="">Selecione a Conta/Cartão de Destino</option>';
    
    contas.forEach(c => {
        const icone = c.tipo === 'corrente' ? '🏦' : '💳';
        if (selContaT) selContaT.innerHTML += `<option value="${c.id}">${icone} ${c.nome}</option>`;
        if (selContaD) selContaD.innerHTML += `<option value="${c.id}">${icone} ${c.nome}</option>`;
    });

    if (selContaT) {
        selContaT.addEventListener('change', function() {
            if (this.value === 'nova_conta') {
                adicionandoContaParaTransacao = true;
                this.value = '';
                abrirModal('modalConta');
            }
        });
    }
}

function atualizarSelectCategorias() {
    const selCatT = document.getElementById('tCategoria');
    if (!selCatT) return;
    selCatT.innerHTML = '<option value="">Selecione a Categoria</option>';
    const catDesp = categorias.filter(c => c.tipo === 'despesa');
    const catRec = categorias.filter(c => c.tipo === 'receita');
    const catOut = categorias.filter(c => c.tipo === 'outros');

    if(catDesp.length > 0){
        let g = document.createElement('optgroup'); g.label = "Despesas";
        catDesp.forEach(c => g.innerHTML += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
        selCatT.appendChild(g);
    }
    if(catRec.length > 0){
        let g = document.createElement('optgroup'); g.label = "Receitas";
        catRec.forEach(c => g.innerHTML += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
        selCatT.appendChild(g);
    }
    if(catOut.length > 0){
        let g = document.createElement('optgroup'); g.label = "Outros";
        catOut.forEach(c => g.innerHTML += `<option value="${c.id}">${c.icone} ${c.nome}</option>`);
        selCatT.appendChild(g);
    }
}

function preencherModalTransacao(id) {
    const t = transacoes.find(x => x.id === id);
    if (!t) return;
    document.getElementById('tId').value = t.id;
    document.getElementById('tTipo').value = t.tipo;
    document.getElementById('tDescricao').value = t.descricao;
    document.getElementById('tValor').value = t.valor;
    document.getElementById('tData').value = t.data;
    document.getElementById('tConta').value = t.conta_id;
    document.getElementById('tCategoria').value = t.categoria_id;
    document.getElementById('tStatus').value = t.pago ? 'true' : 'false';
    document.getElementById('tParcelas').value = '1';
    toggleTransferencia();
}

async function salvarTransacao() {
    const id = document.getElementById('tId').value || uuidv4();
    const tipo = document.getElementById('tTipo').value;
    let desc = document.getElementById('tDescricao').value;
    const valor = parseFloat(document.getElementById('tValor').value);
    const dataStr = document.getElementById('tData').value;
    const conta = document.getElementById('tConta').value;
    let cat = document.getElementById('tCategoria').value;
    const destino = document.getElementById('tContaDestino').value;
    const qtdParcelas = parseInt(document.getElementById('tParcelas').value) || 1;
    const file = document.getElementById('tFoto').files[0];
    const statusPago = document.getElementById('tStatus').value === 'true';

    if (!valor || !dataStr || !conta) { alert('Preencha os campos obrigatórios!'); return; }
    if (tipo === 'transferencia' && !destino) { alert('Selecione a conta de destino!'); return; }
    if (tipo !== 'transferencia' && !cat) { alert('Selecione a categoria!'); return; }

    let base64 = null;
    if (file) base64 = await resizeImage(file);

    const gerarBaseTransacao = (idx) => {
        let d = new Date(dataStr + 'T12:00:00');
        if (idx > 0) d.setMonth(d.getMonth() + idx);
        const dataFormatada = d.toISOString().split('T')[0];

        let descFormatada = desc;
        if (qtdParcelas > 1) descFormatada = `${desc} (${idx + 1}/${qtdParcelas})`;

        return {
            id: uuidv4(),
            tipo: tipo === 'transferencia' ? 'despesa' : tipo,
            descricao: descFormatada,
            valor: valor / qtdParcelas,
            data: dataFormatada,
            conta_id: conta,
            categoria_id: cat,
            pago: statusPago,
            sinc: false,
            updated_at: new Date().toISOString()
        };
    };

    if (document.getElementById('tId').value) {
        let tExist = transacoes.find(x => x.id === id);
        if(tExist) {
            tExist.tipo = tipo;
            tExist.descricao = desc;
            tExist.valor = valor;
            tExist.data = dataStr;
            tExist.conta_id = conta;
            tExist.categoria_id = cat;
            tExist.pago = statusPago;
            tExist.sinc = false;
            tExist.updated_at = new Date().toISOString();
            if (base64) tExist.comprovante = base64;
            await salvarItemDB('transacoes', tExist);
        }
    } else {
        if (tipo === 'transferencia') {
            const idGroup = uuidv4();
            let saida = gerarBaseTransacao(0);
            saida.id_original = idGroup;
            saida.tipo = 'despesa';
            saida.categoria_id = 'cat_transferencia';
            if(base64) saida.comprovante = base64;
            
            let entrada = gerarBaseTransacao(0);
            entrada.id_original = idGroup;
            entrada.tipo = 'receita';
            entrada.conta_id = destino;
            entrada.categoria_id = 'cat_transferencia';
            if(base64) entrada.comprovante = base64;
            
            await salvarItemDB('transacoes', saida);
            await salvarItemDB('transacoes', entrada);
        } else {
            for (let i = 0; i < qtdParcelas; i++) {
                let t = gerarBaseTransacao(i);
                if (qtdParcelas > 1) {
                    t.parcela_atual = i + 1;
                    t.parcela_total = qtdParcelas;
                    t.id_original = id;
                } else {
                    t.id = id;
                }
                if (base64) t.comprovante = base64;
                await salvarItemDB('transacoes', t);
            }
        }
    }

    fecharModais();
    scheduleSync();
}

function preencherModalConta(id) {
    const c = contas.find(x => x.id === id);
    if (!c) return;
    document.getElementById('cId').value = c.id;
    document.getElementById('cNome').value = c.nome;
    document.getElementById('cTipo').value = c.tipo;
    document.getElementById('cSaldoLimite').value = c.tipo === 'corrente' ? (c.saldo_inicial || 0) : (c.limite || 0);
    document.getElementById('cVencimento').value = c.vencimento || '';
}

async function salvarConta() {
    const id = document.getElementById('cId').value || uuidv4();
    const nome = document.getElementById('cNome').value;
    const tipo = document.getElementById('cTipo').value;
    const valor = parseFloat(document.getElementById('cSaldoLimite').value) || 0;
    const venc = parseInt(document.getElementById('cVencimento').value) || null;

    if (!nome) { alert('Nome obrigatório!'); return; }

    const c = { id, nome, tipo, sinc: false, updated_at: new Date().toISOString() };
    if (tipo === 'corrente') c.saldo_inicial = valor;
    else { c.limite = valor; c.vencimento = venc; }

    await salvarItemDB('contas', c);
    
    if (adicionandoContaParaTransacao) {
        novaContaId = id;
        document.getElementById('tConta').value = id;
        document.getElementById('modalTransacao').classList.add('active');
        document.getElementById('modalConta').classList.remove('active');
    } else {
        fecharModais();
    }
    scheduleSync();
}

function preencherModalMeta(id) {
    const m = metas.find(x => x.id === id);
    if (!m) return;
    document.getElementById('mId').value = m.id;
    document.getElementById('mNome').value = m.nome;
    document.getElementById('mObjetivo').value = m.valor_objetivo;
    document.getElementById('mAtual').value = m.valor_atual;
    document.getElementById('mData').value = m.data_limite;
    document.getElementById('mConta').value = m.conta_id || '';
}

async function salvarMeta() {
    const id = document.getElementById('mId').value || uuidv4();
    const nome = document.getElementById('mNome').value;
    const obj = parseFloat(document.getElementById('mObjetivo').value) || 0;
    const atual = parseFloat(document.getElementById('mAtual').value) || 0;
    const dataStr = document.getElementById('mData').value;
    const conta = document.getElementById('mConta').value;

    if (!nome || !obj) { alert('Nome e Objetivo obrigatórios!'); return; }

    await salvarItemDB('metas', {
        id, nome, valor_objetivo: obj, valor_atual: atual, data_limite: dataStr, conta_id: conta,
        sinc: false, updated_at: new Date().toISOString()
    });
    fecharModais();
    scheduleSync();
}

// ============================================================
// ASSISTENTE DE CHAT (BOT)
// ============================================================
let chatFluxo = { ativo: false, etapa: 0, dadosTemp: {} };

function iniciarChat() {
    abrirModal('modalChat');
    const msgDiv = document.getElementById('chatMessages');
    msgDiv.innerHTML = '';
    document.getElementById('chatInput').value = '';
    
    chatFluxo = { ativo: true, etapa: 0, dadosTemp: {} };
    
    setTimeout(() => {
        adicionarBalaoChat('bot', 'Olá! Como posso ajudar hoje?');
        mostrarBotoesRapidos([
            {label: '💸 Despesa', valor: 'despesa'},
            {label: '💰 Receita', valor: 'receita'},
            {label: '🔄 Transferência', valor: 'transferencia'}
        ]);
    }, 400);
}

function adicionarBalaoChat(remetente, texto, isHtml = false) {
    const div = document.createElement('div');
    div.className = `chat-bubble ${remetente === 'bot' ? 'chat-bot' : 'chat-user'}`;
    if (isHtml) div.innerHTML = texto;
    else div.textContent = texto;
    
    const msgDiv = document.getElementById('chatMessages');
    msgDiv.appendChild(div);
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

function mostrarBotoesRapidos(opcoes) {
    const container = document.getElementById('chatQuickReplies');
    container.innerHTML = '';
    if (!opcoes || opcoes.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    opcoes.forEach(op => {
        const btn = document.createElement('button');
        btn.className = 'chat-quick-btn';
        btn.textContent = op.label;
        btn.onclick = () => processarMensagemChat(op.valor, op.label);
        container.appendChild(btn);
    });
    container.style.display = 'flex';
    container.scrollLeft = 0;
}

function enviarMensagemChatInput() {
    const input = document.getElementById('chatInput');
    const txt = input.value.trim();
    if (!txt) return;
    input.value = '';
    adicionarBalaoChat('user', txt);
    processarMensagemChat(txt, txt);
}

async function processarMensagemChat(valor, textoOriginal) {
    if (textoOriginal && valor !== textoOriginal) {
        adicionarBalaoChat('user', textoOriginal);
    }
    mostrarBotoesRapidos([]); 
    document.getElementById('chatInput').focus();

    const etapaAtual = chatFluxo.etapa;

    if (etapaAtual === 0) {
        const t = valor.toLowerCase();
        if (t.includes('despesa') || t.includes('receita') || t.includes('transfer')) {
            let tipo = 'despesa';
            if (t.includes('receita')) tipo = 'receita';
            if (t.includes('transfer')) tipo = 'transferencia';
            
            chatFluxo.dadosTemp.tipo = tipo;
            chatFluxo.etapa = 1;
            setTimeout(() => adicionarBalaoChat('bot', 'Qual o valor? (ex: 150,00 ou 150)'), 500);
        } else {
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Não entendi. Escolha uma das opções abaixo:');
                mostrarBotoesRapidos([{label: '💸 Despesa', valor: 'despesa'},{label: '💰 Receita', valor: 'receita'},{label: '🔄 Transferência', valor: 'transferencia'}]);
            }, 500);
        }
    } 
    else if (etapaAtual === 1) {
        const valFinal = parseMoedaBR(valor);
        if (valFinal > 0) {
            chatFluxo.dadosTemp.valor = valFinal;
            chatFluxo.etapa = 2;
            setTimeout(() => adicionarBalaoChat('bot', 'Qual a descrição? (ex: Supermercado)'), 500);
        } else {
            setTimeout(() => adicionarBalaoChat('bot', 'Valor inválido. Digite um número positivo (ex: 50,00)'), 500);
        }
    }
    else if (etapaAtual === 2) {
        chatFluxo.dadosTemp.descricao = valor;
        chatFluxo.etapa = 2.5;
        setTimeout(() => {
            adicionarBalaoChat('bot', 'Qual a data da transação? (Digite DD/MM/AAAA ou escolha abaixo)');
            mostrarBotoesRapidos([
                {label: '📅 Hoje', valor: 'hoje'},
                {label: '🔙 Ontem', valor: 'ontem'}
            ]);
        }, 500);
    }
    else if (etapaAtual === 2.5) {
        let dataStr = '';
        const tzOffset = (new Date()).getTimezoneOffset() * 60000;
        const dataHoje = new Date(Date.now() - tzOffset);

        if (valor.toLowerCase() === 'hoje') {
            dataStr = dataHoje.toISOString().split('T')[0];
        } else if (valor.toLowerCase() === 'ontem') {
            const dataOntem = new Date(dataHoje.getTime() - (24 * 60 * 60 * 1000));
            dataStr = dataOntem.toISOString().split('T')[0];
        } else {
            const partes = valor.split('/');
            if (partes.length === 2 || partes.length === 3) {
                const dia = partes[0].padStart(2, '0');
                const mes = partes[1].padStart(2, '0');
                const ano = partes.length === 3 ? partes[2] : dataHoje.getFullYear();
                if(!isNaN(dia) && !isNaN(mes) && !isNaN(ano) && dia > 0 && dia <= 31 && mes > 0 && mes <= 12) {
                    dataStr = `${ano}-${mes}-${dia}`;
                }
            }
        }

        if (!dataStr) {
            setTimeout(() => adicionarBalaoChat('bot', 'Data inválida. Por favor, digite no formato DD/MM/AAAA, "hoje" ou "ontem".'), 500);
            return;
        }

        chatFluxo.dadosTemp.data = dataStr;
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
    else if (etapaAtual === 3) {
        const c = contas.find(x => x.id === valor || x.nome.toLowerCase() === valor.toLowerCase());
        if (c) {
            chatFluxo.dadosTemp.conta_id = c.id;
            if (chatFluxo.dadosTemp.tipo === 'transferencia') {
                chatFluxo.etapa = 3.5;
                setTimeout(() => {
                    adicionarBalaoChat('bot', 'Para qual conta vai ENTRAR o dinheiro?');
                    let opsDestino = contas.filter(x => x.id !== c.id).map(x => ({ label: x.nome, valor: x.id }));
                    mostrarBotoesRapidos(opsDestino);
                }, 500);
            } else {
                if (chatFluxo.dadosTemp.tipo === 'despesa' && c.tipo === 'cartao') {
                    chatFluxo.etapa = 3.1;
                    setTimeout(() => {
                        adicionarBalaoChat('bot', 'Em quantas vezes? (Digite o número de parcelas ou "1" para à vista)');
                        mostrarBotoesRapidos([
                            {label: 'À vista', valor: '1'},
                            {label: '2x', valor: '2'},
                            {label: '3x', valor: '3'}
                        ]);
                    }, 500);
                } else {
                    chatFluxo.etapa = 4;
                    setTimeout(() => {
                        adicionarBalaoChat('bot', 'Em qual categoria se encaixa?');
                        let tipoFiltro = chatFluxo.dadosTemp.tipo;
                        let opsCat = categorias.filter(x => x.tipo === tipoFiltro || x.tipo === 'outros').map(x => ({ label: `${x.icone} ${x.nome}`, valor: x.id }));
                        mostrarBotoesRapidos(opsCat);
                    }, 500);
                }
            }
        } else {
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Conta não encontrada. Escolha uma válida:');
                mostrarBotoesRapidos(contas.map(c => ({ label: c.nome, valor: c.id })));
            }, 500);
        }
    }
    else if (etapaAtual === 3.1) {
        const parcs = parseInt(valor) || 1;
        chatFluxo.dadosTemp.parcelas = parcs;
        chatFluxo.etapa = 4;
        setTimeout(() => {
            adicionarBalaoChat('bot', 'Em qual categoria se encaixa?');
            let opsCat = categorias.filter(x => x.tipo === 'despesa' || x.tipo === 'outros').map(x => ({ label: `${x.icone} ${x.nome}`, valor: x.id }));
            mostrarBotoesRapidos(opsCat);
        }, 500);
    }
    else if (etapaAtual === 3.5) {
        const c = contas.find(x => x.id === valor || x.nome.toLowerCase() === valor.toLowerCase());
        if (c) {
            chatFluxo.dadosTemp.destino_id = c.id;
            chatFluxo.etapa = 5;
            setTimeout(() => {
                const origem = contas.find(x => x.id === chatFluxo.dadosTemp.conta_id)?.nome;
                const destino = c.nome;
                adicionarBalaoChat('bot', `Resumo:\n🔄 Transf. de R$ ${chatFluxo.dadosTemp.valor.toFixed(2)}\nDe: ${origem}\nPara: ${destino}\nDesc: ${chatFluxo.dadosTemp.descricao}\n📅 Data: ${formatarDataBR(chatFluxo.dadosTemp.data)}\n\nPosso salvar?`);
                mostrarBotoesRapidos([{label: '✅ Sim, salvar', valor: 'sim'}, {label: '❌ Cancelar', valor: 'nao'}]);
            }, 500);
        } else {
            setTimeout(() => adicionarBalaoChat('bot', 'Conta de destino inválida.'), 500);
        }
    }
    else if (etapaAtual === 4) {
        let cat = categorias.find(x => x.id === valor || x.nome.toLowerCase() === valor.toLowerCase());
        if (!cat) cat = categorias.find(x => x.nome.toLowerCase().includes(valor.toLowerCase()));
        
        if (cat) {
            chatFluxo.dadosTemp.categoria_id = cat.id;
            chatFluxo.etapa = 5;
            setTimeout(() => {
                const conta = contas.find(x => x.id === chatFluxo.dadosTemp.conta_id)?.nome;
                const icone = chatFluxo.dadosTemp.tipo === 'despesa' ? '💸' : '💰';
                let resumo = `${icone} ${chatFluxo.dadosTemp.tipo.toUpperCase()} - R$ ${chatFluxo.dadosTemp.valor.toFixed(2)}\nDesc: ${chatFluxo.dadosTemp.descricao}\nConta: ${conta}\nCat: ${cat.nome}\n📅 Data: ${formatarDataBR(chatFluxo.dadosTemp.data)}`;
                if (chatFluxo.dadosTemp.parcelas && chatFluxo.dadosTemp.parcelas > 1) {
                    resumo += `\n📆 Parcelas: ${chatFluxo.dadosTemp.parcelas}x`;
                }
                resumo += '\n\nPosso salvar?';
                
                adicionarBalaoChat('bot', resumo);
                mostrarBotoesRapidos([{label: '✅ Sim, salvar', valor: 'sim'}, {label: '❌ Cancelar', valor: 'nao'}]);
            }, 500);
        } else {
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Categoria não encontrada. Escolha:');
                let opsCat = categorias.filter(x => x.tipo === chatFluxo.dadosTemp.tipo || x.tipo === 'outros').map(x => ({ label: `${x.icone} ${x.nome}`, valor: x.id }));
                mostrarBotoesRapidos(opsCat);
            }, 500);
        }
    }
    else if (etapaAtual === 5) {
        if (valor.toLowerCase() === 'sim') {
            chatFluxo.etapa = 6;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Gostaria de anexar um comprovante agora? (Opcional)');
                mostrarBotoesRapidos([{label: '📷 Anexar Foto', valor: 'foto'}, {label: 'Não, finalizar', valor: 'nao'}]);
            }, 500);
        } else {
            adicionarBalaoChat('bot', 'Operação cancelada. Como mais posso ajudar?');
            iniciarChat();
        }
    }
    else if (etapaAtual === 6) {
        if (valor.toLowerCase() === 'foto') {
            document.getElementById('chatFotoInput').click();
        } else {
            finalizarSalvamentoChat();
        }
    }
}

async function handleChatPhoto() {
    const file = document.getElementById('chatFotoInput').files[0];
    if (file && chatFluxo.etapa === 6) {
        adicionarBalaoChat('user', '📷 Foto anexada', true);
        chatFluxo.dadosTemp.comprovanteBase64 = await resizeImage(file);
        finalizarSalvamentoChat();
    }
}

async function finalizarSalvamentoChat() {
    const d = chatFluxo.dadosTemp;
    const dataStr = chatFluxo.dadosTemp.data;
    
    if (d.tipo === 'transferencia') {
        const idGroup = uuidv4();
        await salvarItemDB('transacoes', {
            id: uuidv4(), id_original: idGroup, tipo: 'despesa', descricao: d.descricao, valor: d.valor,
            data: dataStr, conta_id: d.conta_id, categoria_id: 'cat_transferencia', pago: true,
            sinc: false, updated_at: new Date().toISOString(), comprovante: d.comprovanteBase64 || null
        });
        await salvarItemDB('transacoes', {
            id: uuidv4(), id_original: idGroup, tipo: 'receita', descricao: d.descricao, valor: d.valor,
            data: dataStr, conta_id: d.destino_id, categoria_id: 'cat_transferencia', pago: true,
            sinc: false, updated_at: new Date().toISOString(), comprovante: d.comprovanteBase64 || null
        });
    } else {
        const parcelas = d.parcelas || 1;
        const baseId = uuidv4();
        for (let i = 0; i < parcelas; i++) {
            let dataParc = new Date(dataStr + 'T12:00:00');
            dataParc.setMonth(dataParc.getMonth() + i);
            let descFinal = d.descricao;
            if (parcelas > 1) descFinal += ` (${i+1}/${parcelas})`;
            
            let t = {
                id: (parcelas > 1) ? uuidv4() : baseId,
                tipo: d.tipo, descricao: descFinal, valor: d.valor / parcelas,
                data: dataParc.toISOString().split('T')[0],
                conta_id: d.conta_id, categoria_id: d.categoria_id, pago: true,
                sinc: false, updated_at: new Date().toISOString(), comprovante: d.comprovanteBase64 || null
            };
            if (parcelas > 1) {
                t.id_original = baseId;
                t.parcela_atual = i + 1;
                t.parcela_total = parcelas;
            }
            await salvarItemDB('transacoes', t);
        }
    }
    
    scheduleSync();
    setTimeout(() => {
        adicionarBalaoChat('bot', 'Tudo salvo com sucesso! ✅ Posso ajudar em mais algo?');
        mostrarBotoesRapidos([
            {label: '💸 Nova Despesa', valor: 'despesa'},
            {label: '💰 Nova Receita', valor: 'receita'}
        ]);
        chatFluxo.etapa = 0;
        chatFluxo.dadosTemp = {};
    }, 500);
}

// ============================================================
// EXPORTAÇÃO (PDF e CSV)
// ============================================================
function baixarRelatorio() {
    const tFilt = getTransacoesFiltradas();
    if (tFilt.length === 0) { alert('Sem dados no período.'); return; }

    let csv = "Data;Tipo;Descrição;Categoria;Conta;Valor;Status\n";
    tFilt.forEach(t => {
        const d = formatarDataBR(t.data);
        const cat = (categorias.find(c => c.id === t.categoria_id) || {nome: ''}).nome;
        const cnt = (contas.find(c => c.id === t.conta_id) || {nome: ''}).nome;
        const val = t.valor.toFixed(2).replace('.', ',');
        const st = t.pago ? 'Pago' : 'Pendente';
        csv += `${d};${t.tipo};${t.descricao};${cat};${cnt};${val};${st}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `financas_${mesAtual}.csv`; a.click();
    URL.revokeObjectURL(url);
}

function baixarPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const tFilt = getTransacoesFiltradas();
    if (tFilt.length === 0) { alert('Sem dados para PDF.'); return; }

    doc.setFontSize(18);
    doc.text("Relatório Financeiro Familiar", 14, 20);
    doc.setFontSize(12);
    doc.text(`Gerado em: ${new Date().toLocaleDateString()}`, 14, 28);

    const data = tFilt.map(t => {
        const cat = (categorias.find(c => c.id === t.categoria_id) || {nome: ''}).nome;
        return [
            formatarDataBR(t.data),
            t.tipo.toUpperCase(),
            t.descricao,
            cat,
            `R$ ${t.valor.toFixed(2)}`,
            t.pago ? 'OK' : 'Pendente'
        ];
    });

    doc.autoTable({
        head: [['Data', 'Tipo', 'Descrição', 'Categoria', 'Valor', 'Status']],
        body: data,
        startY: 35,
        theme: 'striped'
    });

    doc.save(`relatorio_${mesAtual}.pdf`);
}

// ============================================================
// EVENT LISTENERS E INICIALIZAÇÃO
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const tzOffset = (new Date()).getTimezoneOffset() * 60000;
    const dHoje = new Date(Date.now() - tzOffset);
    mesAtual = dHoje.toISOString().slice(0, 7);
    
    const pMes = document.getElementById('monthPicker');
    if (pMes) {
        pMes.value = mesAtual;
        pMes.addEventListener('change', (e) => {
            filtroDataInicio = ''; filtroDataFim = '';
            document.getElementById('dataInicioFiltro').value = '';
            document.getElementById('dataFimFiltro').value = '';
            mesAtual = e.target.value;
            atualizarDashboard();
        });
    }

    const din = document.getElementById('dataInicioFiltro');
    const dfim = document.getElementById('dataFimFiltro');
    const handleDateFilter = () => {
        filtroDataInicio = din.value;
        filtroDataFim = dfim.value;
        if(filtroDataInicio || filtroDataFim) {
            pMes.value = ''; mesAtual = '';
        }
        atualizarDashboard();
    };
    if (din) din.addEventListener('change', handleDateFilter);
    if (dfim) dfim.addEventListener('change', handleDateFilter);

    const btnLimpar = document.querySelector('button[title="Limpar período"]');
    if (btnLimpar) {
        btnLimpar.addEventListener('click', () => {
            filtroDataInicio = ''; filtroDataFim = '';
            if (din) din.value = '';
            if (dfim) dfim.value = '';
            mesAtual = dHoje.toISOString().slice(0, 7);
            if (pMes) pMes.value = mesAtual;
            atualizarDashboard();
        });
    }

    if (document.getElementById('globalSearch')) document.getElementById('globalSearch').addEventListener('input', atualizarDashboard);
    if (document.getElementById('categoryFilter')) document.getElementById('categoryFilter').addEventListener('change', atualizarDashboard);

    window.addEventListener('online', () => scheduleSync(true));
    window.addEventListener('offline', () => atualizarSyncStatus('offline'));

    checkStoredToken();
});
