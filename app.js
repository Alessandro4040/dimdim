// Configurações
const API_URL = 'https://script.google.com/macros/s/AKfycbytKn8WB5K74pfgxK-XI6JWnQf-t-foFxUWEcMnIpCWFJxsKV9TVjZmE05RDePkBelu/exec'; // substitua
const DB_NAME = 'financas_v5';
let db, chartInstance;
let transacoes = [], contas = [], metas = [], categorias = [];
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';
let syncInProgress = false;
let authToken = localStorage.getItem('authToken'); // token (senha) armazenado

// Geração de UUID v4
function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

// Redimensionar imagem (Canvas)
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
            // Esconde tela de senha e mostra a de biometria
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
        // Nenhum token salvo, pedir senha
        return false;
    }
    // Verificar se o token é válido no servidor (se online)
    try {
        const response = await fetch(`${API_URL}?action=login&token=${encodeURIComponent(authToken)}`);
        const data = await response.json();
        if (data.success) {
            // Token válido, pular tela de senha e ir direto para biometria
            document.getElementById('passwordScreen').classList.add('hidden');
            document.getElementById('lockScreen').classList.remove('hidden');
            return true;
        } else {
            // Token inválido, remover e pedir senha
            localStorage.removeItem('authToken');
            authToken = null;
            return false;
        }
    } catch (err) {
        // Offline: assume token é válido e prossegue (mas a senha já foi validada antes)
        // Neste caso, podemos prosseguir com o token armazenado
        document.getElementById('passwordScreen').classList.add('hidden');
        document.getElementById('lockScreen').classList.remove('hidden');
        return true;
    }
}

function logout() {
    localStorage.removeItem('authToken');
    authToken = null;
    // Recarregar a página para mostrar tela de senha novamente
    window.location.reload();
}

// Biometria (mantida)
async function autenticarBiometria() {
    try {
        // Simulação de WebAuthn / FaceID
        if (window.PublicKeyCredential) {
            // Simulação para PWA
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

// IndexedDB (mantido)
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
        syncWithServer(); // primeira sincronização
        setInterval(syncWithServer, 300000); // a cada 5 minutos
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
            // seed de categorias padrão
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
    };
    tx.oncomplete = () => {
        atualizarDashboard();
        verificarPendencias();
        atualizarSyncStatus();
    };
}

function salvarItemDB(store, item) {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => carregarDadosLocais();
}

// Sincronização com servidor (incluindo token)
async function syncWithServer() {
    if (syncInProgress) return;
    if (!authToken) return; // sem token, não sincroniza
    syncInProgress = true;
    atualizarSyncStatus('sincronizando');
    try {
        // Obter todos os registros não sincronizados
        const unsynced = { transacoes: [], contas: [], metas: [], categorias: [] };
        for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
            const items = await getAllFromStore(store);
            unsynced[store] = items.filter(i => !i.sinc);
        }
        // Enviar ao servidor
        if (Object.values(unsynced).some(arr => arr.length)) {
            const payload = { ...unsynced, token: authToken };
            const response = await fetch(API_URL, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                const result = await response.json();
                if (result.error) throw new Error(result.error);
                // Marcar como sincronizados localmente
                for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
                    for (const item of unsynced[store]) {
                        item.sinc = true;
                        await putToStore(store, item);
                    }
                }
            } else {
                throw new Error('Sync failed');
            }
        }
        // Obter dados mais recentes do servidor (pull)
        const pullResponse = await fetch(`${API_URL}?action=getAll&token=${encodeURIComponent(authToken)}`);
        const remoteData = await pullResponse.json();
        if (remoteData && !remoteData.error) {
            // Substituir dados locais pelos remotos (merge)
            for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
                const remoteItems = remoteData[store] || [];
                for (const item of remoteItems) {
                    await putToStore(store, item);
                }
                // Opcional: remover itens locais que não estão no remoto (exclusão)
                // Aqui optamos por não excluir, apenas adicionar/atualizar
            }
        } else if (remoteData.error === "Acesso negado.") {
            // Token inválido, forçar logout
            logout();
            return;
        }
        atualizarSyncStatus('sincronizado');
        carregarDadosLocais(); // recarregar UI
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
        req.onsuccess = () => resolve(req.result);
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
    } else {
        // atualiza ícone pendente
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

// Funções de UI (atualizarSelectContas, atualizarSelectCategorias, atualizarFiltroCategorias, etc.)
// Mantidas exatamente como antes, sem alterações
function atualizarSelectContas() {
    const sel = document.getElementById('tConta');
    sel.innerHTML = '<option value="">Selecione...</option>';
    contas.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
    const selMeta = document.getElementById('mConta');
    if (selMeta) {
        selMeta.innerHTML = '<option value="">Nenhuma</option>';
        contas.forEach(c => {
            selMeta.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
        });
    }
}

function atualizarSelectCategorias() {
    const sel = document.getElementById('tCategoria');
    sel.innerHTML = '';
    categorias.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
}

function atualizarFiltroCategorias() {
    const sel = document.getElementById('categoryFilter');
    sel.innerHTML = '<option value="">Todas categorias</option>';
    categorias.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
}

function atualizarDashboard() {
    const mes = mesAtual;
    const searchTerm = document.getElementById('globalSearch').value.toLowerCase();
    const catFilter = document.getElementById('categoryFilter').value;

    let recMes = 0, desMes = 0, saldoGeral = 0;

    // Contas
    let htmlContas = '';
    contas.forEach(c => {
        let saldoConta = c.tipo === 'corrente' ? c.saldo_inicial : c.limite;
        transacoes.forEach(t => {
            if (t.conta_id === c.id && t.pago) {
                if (t.tipo === 'receita') saldoConta += t.valor;
                if (t.tipo === 'despesa') saldoConta -= t.valor;
            }
        });
        if (c.tipo === 'corrente') saldoGeral += saldoConta;
        htmlContas += `<div class="card" style="margin-bottom:10px; text-align:left;">
            <strong>${c.nome}</strong> (${c.tipo})<br>
            ${c.tipo === 'cartao' ? 'Limite Disp.' : 'Saldo'}: R$ ${saldoConta.toFixed(2)}
        </div>`;
    });
    document.getElementById('listaContas').innerHTML = htmlContas;

    // Transações filtradas
    let categoriasTotais = {};
    let htmlTransacoes = '';
    let transacoesFiltradas = transacoes.filter(t => {
        if (t.data.startsWith(mes) === false) return false;
        if (searchTerm && !t.descricao.toLowerCase().includes(searchTerm)) return false;
        if (catFilter && t.categoria_id !== catFilter) return false;
        return true;
    });
    transacoesFiltradas.forEach(t => {
        if (t.tipo === 'receita') recMes += t.valor;
        if (t.tipo === 'despesa') {
            desMes += t.valor;
            categoriasTotais[t.categoria_id] = (categoriasTotais[t.categoria_id] || 0) + t.valor;
        }
        const categoriaNome = categorias.find(c => c.id === t.categoria_id)?.nome || 'Sem categoria';
        htmlTransacoes += `<div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <div>
                <strong>${t.descricao}</strong><br>
                <small>${t.data} - ${categoriaNome} - ${t.pago ? '✅' : '⏳'}</small>
                ${t.foto ? `<br><a href="#" onclick="abrirZoom('${t.foto}')" style="color:var(--p);font-size:12px;">Ver Comprovante</a>` : ''}
            </div>
            <div style="color: ${t.tipo === 'receita' ? 'var(--s)' : 'var(--d)'};">
                R$ ${t.valor.toFixed(2)}
            </div>
        </div>`;
    });

    document.getElementById('saldoTotal').innerText = `R$ ${saldoGeral.toFixed(2)}`;
    document.getElementById('totalRec').innerText = `R$ ${recMes.toFixed(2)}`;
    document.getElementById('totalDes').innerText = `R$ ${desMes.toFixed(2)}`;
    document.getElementById('listaTransacoes').innerHTML = htmlTransacoes || '<div>Nenhuma transação neste mês.</div>';

    // Metas
    let htmlMetas = '';
    metas.forEach(m => {
        let pct = Math.min((m.valor_atual / m.valor_objetivo) * 100, 100).toFixed(1);
        htmlMetas += `<div class="card" style="margin-bottom:10px; text-align:left;">
            <strong>${m.nome}</strong> - ${pct}% concluído<br>
            <progress value="${m.valor_atual}" max="${m.valor_objetivo}" style="width:100%;"></progress>
        </div>`;
    });
    document.getElementById('listaMetas').innerHTML = htmlMetas;

    renderizarGrafico(categoriasTotais);
}

function verificarPendencias() {
    const hoje = new Date().toISOString().slice(0, 10);
    const pendentes = transacoes.filter(t => !t.pago && t.data <= hoje);
    if (pendentes.length > 0) {
        document.getElementById('alertasPendentes').innerText = `Aviso: ${pendentes.length} transação(ões) pendente(s) ou vencida(s)!`;
    } else {
        document.getElementById('alertasPendentes').innerText = '';
    }
}

function renderizarGrafico(dados) {
    const ctx = document.getElementById('graficoDespesas').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    const labels = Object.keys(dados).map(id => categorias.find(c => c.id === id)?.nome || id);
    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: Object.values(dados),
                backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom', labels:{color: 'var(--txt)'} } } }
    });
}

async function salvarTransacao() {
    const descricao = document.getElementById('tDescricao').value;
    const valorTotal = parseFloat(document.getElementById('tValor').value);
    const dataInicial = new Date(document.getElementById('tData').value);
    const parcelas = parseInt(document.getElementById('tParcelas').value) || 1;
    const tipo = document.getElementById('tTipo').value;
    const contaId = document.getElementById('tConta').value;
    const categoriaId = document.getElementById('tCategoria').value;
    const pago = document.getElementById('tStatus').value === "true";
    const fotoFile = document.getElementById('tFoto').files[0];

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
}

function salvarConta() {
    const novaConta = {
        id: uuidv4(),
        nome: document.getElementById('cNome').value,
        tipo: document.getElementById('cTipo').value,
        saldo_inicial: parseFloat(document.getElementById('cSaldoLimite').value) || 0,
        limite: parseFloat(document.getElementById('cSaldoLimite').value) || 0,
        vencimento: document.getElementById('cVencimento').value || null,
        sinc: false,
        updated_at: new Date().toISOString()
    };
    salvarItemDB('contas', novaConta);
    fecharModais();
}

function salvarMeta() {
    const novaMeta = {
        id: uuidv4(),
        nome: document.getElementById('mNome').value,
        valor_objetivo: parseFloat(document.getElementById('mObjetivo').value),
        valor_atual: parseFloat(document.getElementById('mAtual').value) || 0,
        data_limite: document.getElementById('mData').value,
        conta_id: document.getElementById('mConta').value,
        sinc: false,
        updated_at: new Date().toISOString()
    };
    salvarItemDB('metas', novaMeta);
    fecharModais();
}

// Utilitários de UI
function abrirModal(id) { document.getElementById(id).classList.add('active'); document.getElementById('overlay').classList.add('active'); }
function fecharModais() { document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); document.getElementById('overlay').classList.remove('active'); }

function abrirZoom(base64) {
    document.getElementById('zoomImg').src = base64;
    document.getElementById('zoomImg').style.transform = 'scale(1)';
    document.getElementById('imageViewer').style.display = 'flex';
}
function fecharZoom() { document.getElementById('imageViewer').style.display = 'none'; }
function aplicarZoom(img) { img.style.transform = img.style.transform === 'scale(2)' ? 'scale(1)' : 'scale(2)'; }

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
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relatorio_financas.csv';
    a.click();
    window.URL.revokeObjectURL(url);
}

function baixarPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const ini = document.getElementById('eDataIni').value;
    const fim = document.getElementById('eDataFim').value;
    let filtrado = transacoes.filter(t => t.data >= ini && t.data <= fim);
    const tableData = filtrado.map(t => [
        t.data,
        t.tipo,
        t.descricao,
        `R$ ${t.valor.toFixed(2)}`,
        t.pago ? 'Pago' : 'Pendente',
        categorias.find(c => c.id === t.categoria_id)?.nome || ''
    ]);
    doc.text('Relatório de Transações', 14, 16);
    doc.autoTable({
        head: [['Data', 'Tipo', 'Descrição', 'Valor', 'Status', 'Categoria']],
        body: tableData,
        startY: 20,
    });
    doc.save('relatorio.pdf');
}

// Navegação por mês
document.getElementById('monthPicker').addEventListener('change', (e) => {
    mesAtual = e.target.value;
    atualizarDashboard();
});
document.getElementById('globalSearch').addEventListener('input', () => atualizarDashboard());
document.getElementById('categoryFilter').addEventListener('change', () => atualizarDashboard());

// Inicialização
document.getElementById('monthPicker').value = mesAtual;

// Ao carregar a página, verificar se já há token salvo
window.addEventListener('load', () => {
    checkStoredToken();
});
