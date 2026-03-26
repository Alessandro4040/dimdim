// Configurações
const API_URL = 'https://script.google.com/macros/s/AKfycbznPvhHLdMUEfl2Vbb3BPDqwKmlQaQZxHISujSjeLgPzbwLPSkLqIlnayyvZh-M_p1e/exec'; // substitua
const DB_NAME = 'financas_v5';
let db;
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

async function excluirItem(store, inputId) {
    const id = document.getElementById(inputId).value;
    if (!id || !confirm('Tem certeza que deseja excluir este item?')) return;
    
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => {
        let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
        deletados[store].push(id);
        localStorage.setItem('deletados', JSON.stringify(deletados));
        
        fecharModais();
        carregarDadosLocais();
        syncWithServer();
    };
}

// ==========================================
// FUNÇÕES DE LIMPEZA DE DADOS DA PLANILHA
// ==========================================
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

// Sincronização com servidor (incluindo token e conversão de dados)
async function syncWithServer() {
    if (syncInProgress) return;
    if (!authToken) return;
    syncInProgress = true;
    atualizarSyncStatus('sincronizando');
    try {
        let deletados = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
        const unsynced = { transacoes: [], contas: [], metas: [], categorias: [] };
        let temDadosParaEnviar = false;

        for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
            const items = await getAllFromStore(store);
            unsynced[store] = items.filter(i => !i.sinc);
            if (unsynced[store].length > 0 || deletados[store].length > 0) temDadosParaEnviar = true;
        }

        if (temDadosParaEnviar) {
            const payload = { ...unsynced, deletados, token: authToken };
            const response = await fetch(API_URL, {
                method: 'POST',
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                const result = await response.json();
                if (result.error) throw new Error(result.error);
                
                localStorage.setItem('deletados', '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
                
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

        const pullResponse = await fetch(`${API_URL}?action=getAll&token=${encodeURIComponent(authToken)}`);
        const remoteData = await pullResponse.json();
        
        if (remoteData && !remoteData.error) {
            for (const store of ['transacoes', 'contas', 'metas', 'categorias']) {
                const remoteItems = remoteData[store] || [];
                let deletadosAtuais = JSON.parse(localStorage.getItem('deletados') || '{"transacoes":[], "contas":[], "metas":[], "categorias":[]}');
                
                for (const item of remoteItems) {
                    if (deletadosAtuais[store].includes(item.id)) continue; 

                    // Conversão crítica BLINDADA! Garante que o frontend entenda números e datas da planilha
                    if (item.valor !== undefined) item.valor = parseMoedaBR(item.valor);
                    if (item.saldo_inicial !== undefined) item.saldo_inicial = parseMoedaBR(item.saldo_inicial);
                    if (item.limite !== undefined) item.limite = parseMoedaBR(item.limite);
                    if (item.valor_objetivo !== undefined) item.valor_objetivo = parseMoedaBR(item.valor_objetivo);
                    if (item.valor_atual !== undefined) item.valor_atual = parseMoedaBR(item.valor_atual);
                    
                    if (item.pago !== undefined) item.pago = (item.pago === true || item.pago === 'true' || String(item.pago).toUpperCase() === 'VERDADEIRO');
                    
                    if (item.data !== undefined) item.data = parseDataBR(item.data);
                    if (item.vencimento !== undefined) item.vencimento = parseDataBR(item.vencimento);
                    if (item.data_limite !== undefined) item.data_limite = parseDataBR(item.data_limite);
                    
                    item.sinc = true;
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
        
        // Adicionando o valor do saldo inicial em dinheiro ou carro à Receita Total do mês
        if (c.saldo_inicial > 0) {
            recMes += c.saldo_inicial;
        }

        transacoes.forEach(t => {
            if (t.conta_id === c.id && t.pago) {
                if (t.tipo === 'receita') saldoConta += t.valor;
                if (t.tipo === 'despesa') saldoConta -= t.valor;
            }
        });
        if (c.tipo === 'corrente') saldoGeral += saldoConta;
        htmlContas += `<div class="card" style="margin-bottom:10px; text-align:left; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <strong>${c.nome}</strong> (${c.tipo})<br>
                ${c.tipo === 'cartao' ? 'Limite Disp.' : 'Saldo'}: R$ ${saldoConta.toFixed(2)}
            </div>
            <button onclick="editarConta('${c.id}')" style="width:auto; padding:5px; margin:0; background:none; border:none; font-size:18px; cursor:pointer;">✏️</button>
        </div>`;
    });
    document.getElementById('listaContas').innerHTML = htmlContas;

    // Transações filtradas
    let htmlTransacoes = '';
    let transacoesFiltradas = transacoes.filter(t => {
        if (t.data.startsWith(mes) === false) return false;
        if (searchTerm && !t.descricao.toLowerCase().includes(searchTerm)) return false;
        if (catFilter && t.categoria_id !== catFilter) return false;
        return true;
    });
    transacoesFiltradas.forEach(t => {
        if (t.tipo === 'receita') recMes += t.valor;
        if (t.tipo === 'despesa') desMes += t.valor;
        
        const categoriaNome = categorias.find(c => c.id === t.categoria_id)?.nome || 'Sem categoria';
        htmlTransacoes += `<div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <div>
                <strong>${t.descricao}</strong><br>
                <small>${t.data} - ${categoriaNome} - ${t.pago ? '✅' : '⏳'}</small>
                ${t.foto ? `<br><a href="#" onclick="abrirZoom('${t.foto}')" style="color:var(--p);font-size:12px;">Ver Comprovante</a>` : ''}
            </div>
            <div style="text-align:right;">
                <div style="color: ${t.tipo === 'receita' ? 'var(--s)' : 'var(--d)'}; margin-bottom: 5px;">
                    R$ ${t.valor.toFixed(2)}
                </div>
                <button onclick="editarTransacao('${t.id}')" style="width:auto; padding:2px 5px; margin:0; background:none; border:none; font-size:16px; cursor:pointer;">✏️</button>
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
        htmlMetas += `<div class="card" style="margin-bottom:10px; text-align:left; display:flex; justify-content:space-between; align-items:center;">
            <div style="width: 85%;">
                <strong>${m.nome}</strong> - ${pct}% concluído<br>
                <progress value="${m.valor_atual}" max="${m.valor_objetivo}" style="width:100%;"></progress>
            </div>
            <button onclick="editarMeta('${m.id}')" style="width:auto; padding:5px; margin:0; background:none; border:none; font-size:18px; cursor:pointer;">✏️</button>
        </div>`;
    });
    document.getElementById('listaMetas').innerHTML = htmlMetas;
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


async function salvarTransacao() {
    const idEdit = document.getElementById('tId') ? document.getElementById('tId').value : '';
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
    if (fotoFile) {
        fotoBase64 = await resizeImage(fotoFile);
    } else if (idEdit) {
        const txExistente = transacoes.find(t => t.id === idEdit);
        if (txExistente) fotoBase64 = txExistente.foto;
    }

    if (idEdit) {
        const transacaoExistente = transacoes.find(t => t.id === idEdit);
        if (transacaoExistente) {
            transacaoExistente.descricao = descricao;
            transacaoExistente.valor = valorTotal;
            transacaoExistente.data = dataInput;
            transacaoExistente.tipo = tipo;
            transacaoExistente.conta_id = contaId;
            transacaoExistente.categoria_id = categoriaId;
            transacaoExistente.pago = pago;
            transacaoExistente.foto = fotoBase64;
            transacaoExistente.sinc = false;
            transacaoExistente.updated_at = new Date().toISOString();
            salvarItemDB('transacoes', transacaoExistente);
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
            salvarItemDB('transacoes', transacao);
        }
    }
    fecharModais();
}

function salvarConta() {
    const idEdit = document.getElementById('cId') ? document.getElementById('cId').value : '';
    const nome = document.getElementById('cNome').value;
    const tipo = document.getElementById('cTipo').value;
    const saldoLimite = parseFloat(document.getElementById('cSaldoLimite').value) || 0;
    const vencimento = document.getElementById('cVencimento').value || null;

    if (idEdit) {
        const contaExistente = contas.find(c => c.id === idEdit);
        if (contaExistente) {
            contaExistente.nome = nome;
            contaExistente.tipo = tipo;
            contaExistente.saldo_inicial = saldoLimite;
            contaExistente.limite = saldoLimite;
            contaExistente.vencimento = vencimento;
            contaExistente.sinc = false;
            contaExistente.updated_at = new Date().toISOString();
            salvarItemDB('contas', contaExistente);
        }
    } else {
        const novaConta = {
            id: uuidv4(),
            nome: nome,
            tipo: tipo,
            saldo_inicial: saldoLimite,
            limite: saldoLimite,
            vencimento: vencimento,
            sinc: false,
            updated_at: new Date().toISOString()
        };
        salvarItemDB('contas', novaConta);
    }
    fecharModais();
}

function salvarMeta() {
    const idEdit = document.getElementById('mId') ? document.getElementById('mId').value : '';
    const nome = document.getElementById('mNome').value;
    const objetivo = parseFloat(document.getElementById('mObjetivo').value);
    const atual = parseFloat(document.getElementById('mAtual').value) || 0;
    const dataLimite = document.getElementById('mData').value;
    const contaId = document.getElementById('mConta').value;

    if (idEdit) {
        const metaExistente = metas.find(m => m.id === idEdit);
        if (metaExistente) {
            metaExistente.nome = nome;
            metaExistente.valor_objetivo = objetivo;
            metaExistente.valor_atual = atual;
            metaExistente.data_limite = dataLimite;
            metaExistente.conta_id = contaId;
            metaExistente.sinc = false;
            metaExistente.updated_at = new Date().toISOString();
            salvarItemDB('metas', metaExistente);
        }
    } else {
        const novaMeta = {
            id: uuidv4(),
            nome: nome,
            valor_objetivo: objetivo,
            valor_atual: atual,
            data_limite: dataLimite,
            conta_id: contaId,
            sinc: false,
            updated_at: new Date().toISOString()
        };
        salvarItemDB('metas', novaMeta);
    }
    fecharModais();
}

function editarTransacao(id) {
    const t = transacoes.find(x => x.id === id);
    if (!t) return;
    document.getElementById('tId').value = t.id;
    document.getElementById('tTipo').value = t.tipo;
    document.getElementById('tDescricao').value = t.descricao;
    document.getElementById('tValor').value = t.valor;
    document.getElementById('tData').value = t.data;
    document.getElementById('tConta').value = t.conta_id;
    document.getElementById('tCategoria').value = t.categoria_id;
    document.getElementById('tStatus').value = t.pago.toString();
    document.getElementById('tParcelas').value = 1;
    document.getElementById('tParcelas').disabled = true;
    document.getElementById('tTituloModal').innerText = 'Editar Transação';
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

// Utilitários de UI
function abrirModal(id) { document.getElementById(id).classList.add('active'); document.getElementById('overlay').classList.add('active'); }
function fecharModais() { 
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); 
    document.getElementById('overlay').classList.remove('active'); 
    
    if (document.getElementById('tId')) {
        document.getElementById('tId').value = '';
        document.getElementById('cId').value = '';
        document.getElementById('mId').value = '';
        document.getElementById('tTituloModal').innerText = 'Nova Transação';
        document.getElementById('cTituloModal').innerText = 'Nova Conta / Cartão';
        document.getElementById('mTituloModal').innerText = 'Novo Cofrinho';
        document.getElementById('tParcelas').disabled = false;
        
        // Esconder botões de exclusão
        document.getElementById('btnExcluirTransacao').style.display = 'none';
        document.getElementById('btnExcluirConta').style.display = 'none';
        document.getElementById('btnExcluirMeta').style.display = 'none';

        // Limpar dados
        document.getElementById('tDescricao').value = '';
        document.getElementById('tValor').value = '';
        document.getElementById('cNome').value = '';
        document.getElementById('cSaldoLimite').value = '';
        document.getElementById('mNome').value = '';
        document.getElementById('mObjetivo').value = '';
        document.getElementById('mAtual').value = '';
    }
}

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

// Auto-sync ao voltar a conexão
window.addEventListener('online', () => {
    if (authToken) syncWithServer();
});

// Ao carregar a página, verificar se já há token salvo
window.addEventListener('load', () => {
    checkStoredToken();
});

// Função visual para forçar a sincronização e dar feedback
async function forcarSincronizacao() {
    const btn = document.getElementById('btnNuvem');
    if(btn) {
        btn.innerText = '⏳';
        btn.disabled = true;
    }
    
    await syncWithServer(); 
    
    if(btn) {
        btn.innerText = '🔄';
        btn.disabled = false;
    }
    alert("Dados sincronizados com a planilha!");
}
