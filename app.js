// Configurações
const API_URL = 'https://script.google.com/macros/s/AKfycbznPvhHLdMUEfl2Vbb3BPDqwKmlQaQZxHISujSjeLgPzbwLPSkLqIlnayyvZh-M_p1e/exec';
const DB_NAME = 'financas_v5';
let db;
let transacoes = [], contas = [], metas = [], categorias = [];
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';
let syncInProgress = false;
let authToken = localStorage.getItem('authToken');

// Controle de debounce e retry
let syncDebounceTimer = null;
let syncRetryTimer = null;
let syncRetryCount = 0;
const MAX_SYNC_RETRIES = 3;
const SYNC_DEBOUNCE_MS = 2000;

// Filtros de data personalizados
let filtroDataInicio = '';
let filtroDataFim = '';

// UUID v4
function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

// Formatar data ISO (YYYY-MM-DD) para DD/MM/YYYY
function formatarDataBR(dataISO) {
    if (!dataISO) return '';
    const partes = dataISO.split('-');
    if (partes.length !== 3) return dataISO;
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

// Redimensionar imagem
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

// Tema
document.documentElement.setAttribute('data-theme', temaAtual);
function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}

// ========== AUTENTICAÇÃO ==========
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

// ========== INDEXEDDB ==========
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
        if (navigator.onLine) {
            scheduleSync(true);
        }
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
    tx.objectStore('contas').getAll().onsuccess = e => { contas = e.target.result; atualizarSelectContas(); };
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

// Deleção em cascata para transferências
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

// ========== FUNÇÕES DE CONVERSÃO ==========
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

// ========== AGENDAMENTO DE SINCRONIZAÇÃO ==========
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

// ========== SINCRONIZAÇÃO (COM RETRY CONTROLADO) ==========
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
                const locais = await getAllFromStore(store);
                const idsLocais = new Set(locais.map(i => i.id));
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

// ========== FUNÇÕES DE UI ==========
function atualizarSelectContas() {
    const sel = document.getElementById('tConta');
    const selDestino = document.getElementById('tContaDestino');
    sel.innerHTML = '<option value="">Selecione a Origem...</option>';
    if (selDestino) selDestino.innerHTML = '<option value="">Selecione o Destino...</option>';
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
    sel.innerHTML = '';
    categorias.filter(c => c.id !== 'cat_transferencia').forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
}

function atualizarFiltroCategorias() {
    const sel = document.getElementById('categoryFilter');
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
    
    if (tipo === 'transferencia') {
        contaDestino.style.display = 'block';
        categoria.disabled = true;
        parcelas.disabled = true;
        parcelas.value = '1';
    } else {
        contaDestino.style.display = 'none';
        categoria.disabled = false;
        parcelas.disabled = false;
    }
}

function getTransacoesPeriodoBase() {
    let dataInicio = filtroDataInicio;
    let dataFim = filtroDataFim;

    if (!dataInicio || !dataFim) {
        if (!mesAtual) return [];
        const [ano, mes] = mesAtual.split('-');
        dataInicio = `${ano}-${mes}-01`;
        const ultimoDia = new Date(parseInt(ano), parseInt(mes), 0).getDate();
        dataFim = `${ano}-${mes}-${ultimoDia}`;
    }
    return transacoes.filter(t => t.pago && t.data >= dataInicio && t.data <= dataFim);
}

// ========== DASHBOARD ==========
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
        if (t.tipo === 'receita') receitasFiltradas += t.valor;
        else if (t.tipo === 'despesa') despesasFiltradas += t.valor;
    });

    let montanteTotal = 0;
    contas.forEach(conta => {
        let saldoConta = conta.tipo === 'corrente' ? conta.saldo_inicial : conta.limite;
        transacoes.forEach(t => {
            if (t.conta_id === conta.id && t.pago) {
                if (t.tipo === 'receita') saldoConta += t.valor;
                if (t.tipo === 'despesa') saldoConta -= t.valor;
            }
        });
        montanteTotal += saldoConta;
    });

    document.getElementById('saldoTotal').innerText = `R$ ${montanteTotal.toFixed(2)}`;
    document.getElementById('totalRec').innerText = `R$ ${receitasFiltradas.toFixed(2)}`;
    document.getElementById('totalDes').innerText = `R$ ${despesasFiltradas.toFixed(2)}`;

    let htmlContas = '';
    contas.forEach(c => {
        let saldoConta = c.tipo === 'corrente' ? c.saldo_inicial : c.limite;
        transacoes.forEach(t => {
            if (t.conta_id === c.id && t.pago) {
                if (t.tipo === 'receita') saldoConta += t.valor;
                if (t.tipo === 'despesa') saldoConta -= t.valor;
            }
        });
        htmlContas += `<div class="card" style="margin-bottom:10px; text-align:left; display:flex; justify-content:space-between; align-items:center;">
            <div><strong>${c.nome}</strong> (${c.tipo})<br>
            ${c.tipo === 'cartao' ? 'Limite Disp.' : 'Saldo'}: R$ ${saldoConta.toFixed(2)}</div>
            <button onclick="editarConta('${c.id}')" style="width:auto; padding:5px; margin:0; background:none; border:none; font-size:18px; cursor:pointer;">✏️</button>
        </div>`;
    });
    document.getElementById('listaContas').innerHTML = htmlContas;

    let htmlTransacoes = '';
    transacoesFiltradas.sort((a,b) => (a.data < b.data ? 1 : -1));
    transacoesFiltradas.forEach(t => {
        const categoriaNome = categorias.find(c => c.id === t.categoria_id)?.nome || 'Sem categoria';
        const dataFormatada = formatarDataBR(t.data);
        const isTransfer = t.categoria_id === 'cat_transferencia';
        const tipoIcon = isTransfer ? '🔄' : (t.tipo === 'receita' ? '💰' : '💸');
        htmlTransacoes += `<div style="padding:12px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
            <div style="flex:1;">
                <strong>${tipoIcon} ${t.descricao}</strong><br>
                <small style="opacity:0.7;">${dataFormatada} - ${categoriaNome} - ${t.pago ? '✅ Pago' : '⏳ Pendente'}</small>
                ${t.foto ? `<br><a href="#" onclick="abrirZoom('${t.foto}')" style="color:var(--p);font-size:12px;">📎 Ver comprovante</a>` : ''}
            </div>
            <div style="text-align:right; min-width: 90px;">
                <div style="color: ${t.tipo === 'receita' ? 'var(--s)' : 'var(--d)'}; font-weight:bold;">
                    R$ ${t.valor.toFixed(2)}
                </div>
                <button onclick="editarTransacao('${t.id}')" style="width:auto; padding:4px 8px; margin:4px 0 0; background:var(--p); font-size:12px;">✏️ Editar</button>
            </div>
        </div>`;
    });
    document.getElementById('listaTransacoes').innerHTML = htmlTransacoes || '<div class="card">Nenhuma transação no período com os filtros aplicados.</div>';

    let htmlMetas = '';
    metas.forEach(m => {
        let pct = Math.min((m.valor_atual / m.valor_objetivo) * 100, 100).toFixed(1);
        htmlMetas += `<div class="card" style="margin-bottom:10px; text-align:left; display:flex; justify-content:space-between; align-items:center;">
            <div style="width:80%;">
                <strong>${m.nome}</strong> - ${pct}%<br>
                <progress value="${m.valor_atual}" max="${m.valor_objetivo}" style="width:100%; height:8px; border-radius:10px;"></progress>
                <small>R$ ${m.valor_atual.toFixed(2)} / R$ ${m.valor_objetivo.toFixed(2)}</small>
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

// ========== SALVAR TRANSAÇÃO ==========
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
                salvando = false;
                if (btn) btn.disabled = false;
                return;
            }

            const dataInicial = new Date(dataInput);
            dataInicial.setMinutes(dataInicial.getMinutes() + dataInicial.getTimezoneOffset());
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

            fecharModais();
            salvando = false;
            if (btn) btn.disabled = false;
            scheduleSync();
            return;
        }

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
            const dataInicial = new Date(dataInput);
            dataInicial.setMinutes(dataInicial.getMinutes() + dataInicial.getTimezoneOffset());
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
        salvarItemDB('contas', novaConta);
    }
    fecharModais();
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

// … (demais funções de edição, modais, zoom, exportação, etc. permanecem idênticas às da versão anterior)

// ========== EVENTOS ==========
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

// … (chat, sincronização forçada, etc. – tudo como antes)

// ==========================================
// CHATBOT (mantido na íntegra, com parcelamento e resumo)
// ==========================================
// ... (código do chat permanece o mesmo)
