// Configurações
const API_URL = 'https://script.google.com/macros/s/AKfycbzc_sJCFXUHPfVC2fETbRvSAM_8AJh7iZauWxq6hS7cU47idsaDS0WS3Q2J3bVdF3xc/exec';
const DB_NAME = 'financas_v4'; // Atualizado para v4 devido ao novo schema
let db, chartInstance;
let transacoes = [], contas = [], metas = [];
let mesAtual = new Date().toISOString().slice(0, 7);
let temaAtual = localStorage.getItem('tema') || 'claro';

// Inicializa Tema
document.documentElement.setAttribute('data-theme', temaAtual);
function alternarTema() {
    temaAtual = temaAtual === 'claro' ? 'escuro' : 'claro';
    document.documentElement.setAttribute('data-theme', temaAtual);
    localStorage.setItem('tema', temaAtual);
}

// ---------------------------------------------------
// 1. Biometria / Ecrã de Bloqueio
// ---------------------------------------------------
async function autenticarBiometria() {
    try {
        // Simulação de WebAuthn / FaceID
        if (window.PublicKeyCredential) {
            // Em ambiente real, configuraria a API de credenciais. Aqui simulamos o sucesso rápido para PWA
            document.getElementById('lockScreen').classList.add('hidden');
            document.getElementById('appContent').style.display = 'block';
            iniciarApp();
        } else {
            alert("Biometria não suportada neste browser. Acesso libertado.");
            document.getElementById('lockScreen').classList.add('hidden');
            document.getElementById('appContent').style.display = 'block';
            iniciarApp();
        }
    } catch (e) {
        alert("Erro na autenticação.");
    }
}

// ---------------------------------------------------
// 2. Base de Dados Local (IndexedDB)
// ---------------------------------------------------
function iniciarApp() {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
        let db = e.target.result;
        if (!db.objectStoreNames.contains('transacoes')) db.createObjectStore('transacoes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('contas')) db.createObjectStore('contas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('metas')) db.createObjectStore('metas', { keyPath: 'id' });
    };
    req.onsuccess = (e) => {
        db = e.target.result;
        carregarDados();
    };
}

function carregarDados() {
    const tx = db.transaction(['transacoes', 'contas', 'metas'], 'readonly');
    
    tx.objectStore('transacoes').getAll().onsuccess = e => { transacoes = e.target.result; };
    tx.objectStore('contas').getAll().onsuccess = e => { 
        contas = e.target.result; 
        atualizarSelectContas();
    };
    tx.objectStore('metas').getAll().onsuccess = e => { metas = e.target.result; };
    
    tx.oncomplete = () => {
        atualizarDashboard();
        verificarPendencias();
    };
}

function salvarItemDB(store, item) {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => carregarDados();
}

// ---------------------------------------------------
// 3. Lógica de Negócio (Parcelas e Salvar)
// ---------------------------------------------------
function salvarTransacao() {
    const descricao = document.getElementById('tDescricao').value;
    const valorTotal = parseFloat(document.getElementById('tValor').value);
    const dataInicial = new Date(document.getElementById('tData').value);
    const parcelas = parseInt(document.getElementById('tParcelas').value) || 1;
    const tipo = document.getElementById('tTipo').value;
    const fotoFile = document.getElementById('tFoto').files[0];
    
    // Converte foto para Base64
    if (fotoFile) {
        const reader = new FileReader();
        reader.onload = function(e) {
            processarSalvamentoTransacao(descricao, valorTotal, dataInicial, parcelas, tipo, e.target.result);
        };
        reader.readAsDataURL(fotoFile);
    } else {
        processarSalvamentoTransacao(descricao, valorTotal, dataInicial, parcelas, tipo, null);
    }
}

function processarSalvamentoTransacao(descricao, valorTotal, dataIni, parcelas, tipo, fotoBase64) {
    const idOriginal = Date.now().toString();
    const valorParcela = valorTotal / parcelas;

    for (let i = 0; i < parcelas; i++) {
        let dataParcela = new Date(dataIni);
        dataParcela.setMonth(dataParcela.getMonth() + i);
        
        let novaTransacao = {
            id: idOriginal + '_' + i,
            id_original: idOriginal,
            tipo: tipo,
            descricao: parcelas > 1 ? `${descricao} (${i+1}/${parcelas})` : descricao,
            valor: valorParcela,
            data: dataParcela.toISOString().split('T')[0],
            conta_id: document.getElementById('tConta').value,
            categoria_id: document.getElementById('tCategoria').value,
            pago: document.getElementById('tStatus').value === "true",
            parcela_num: i + 1,
            parcela_total: parcelas,
            foto: fotoBase64,
            sinc: false
        };
        salvarItemDB('transacoes', novaTransacao);
    }
    fecharModais();
}

function salvarConta() {
    let novaConta = {
        id: Date.now().toString(),
        nome: document.getElementById('cNome').value,
        tipo: document.getElementById('cTipo').value,
        saldo_inicial: parseFloat(document.getElementById('cSaldoLimite').value) || 0,
        limite: parseFloat(document.getElementById('cSaldoLimite').value) || 0,
        vencimento: document.getElementById('cVencimento').value || null,
        sinc: false
    };
    salvarItemDB('contas', novaConta);
    fecharModais();
}

function salvarMeta() {
    let novaMeta = {
        id: Date.now().toString(),
        nome: document.getElementById('mNome').value,
        valor_objetivo: parseFloat(document.getElementById('mObjetivo').value),
        valor_atual: parseFloat(document.getElementById('mAtual').value) || 0,
        data_limite: document.getElementById('mData').value,
        sinc: false
    };
    salvarItemDB('metas', novaMeta);
    fecharModais();
}

// ---------------------------------------------------
// 4. Interface, Atualizações e Alertas
// ---------------------------------------------------
function atualizarDashboard() {
    let recMes = 0, desMes = 0, saldoGeral = 0;
    
    // Contas e Saldo
    let htmlContas = '';
    contas.forEach(c => {
        let saldoConta = c.tipo === 'corrente' ? c.saldo_inicial : c.limite;
        // Subtrair despesas da conta específica
        transacoes.forEach(t => {
            if(t.conta_id === c.id && t.pago) {
                if(t.tipo === 'receita') saldoConta += t.valor;
                if(t.tipo === 'despesa') saldoConta -= t.valor;
            }
        });
        
        if (c.tipo === 'corrente') saldoGeral += saldoConta;
        
        htmlContas += `<div class="card" style="margin-bottom:10px; text-align:left;">
            <strong>${c.nome}</strong> (${c.tipo})<br>
            ${c.tipo === 'cartao' ? 'Limite Disp.' : 'Saldo'}: R$ ${saldoConta.toFixed(2)}
        </div>`;
    });
    document.getElementById('listaContas').innerHTML = htmlContas;

    // Transações do Mês
    let categoriasTotais = {};
    let htmlTransacoes = '';
    transacoes.filter(t => t.data.startsWith(mesAtual)).forEach(t => {
        if (t.tipo === 'receita') recMes += t.valor;
        if (t.tipo === 'despesa') {
            desMes += t.valor;
            categoriasTotais[t.categoria_id] = (categoriasTotais[t.categoria_id] || 0) + t.valor;
        }
        
        htmlTransacoes += `<div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <div>
                <strong>${t.descricao}</strong> <br>
                <small>${t.data} - ${t.pago ? '✅' : '⏳'}</small>
                ${t.foto ? `<br><a href="#" onclick="abrirZoom('${t.foto}')" style="color:var(--p);font-size:12px;">Ver Fatura</a>` : ''}
            </div>
            <div style="color: ${t.tipo === 'receita' ? 'var(--s)' : 'var(--d)'};">
                R$ ${t.valor.toFixed(2)}
            </div>
        </div>`;
    });

    document.getElementById('saldoTotal').innerText = `R$ ${saldoGeral.toFixed(2)}`;
    document.getElementById('totalRec').innerText = `R$ ${recMes.toFixed(2)}`;
    document.getElementById('totalDes').innerText = `R$ ${desMes.toFixed(2)}`;
    document.getElementById('listaTransacoes').innerHTML = htmlTransacoes;

    // Metas (Cofrinhos)
    let htmlMetas = '';
    metas.forEach(m => {
        let pct = Math.min((m.valor_atual / m.valor_objetivo) * 100, 100).toFixed(1);
        htmlMetas += `<div class="card" style="margin-bottom:10px; text-align:left;">
            <strong>${m.nome}</strong> - ${pct}% concluído <br>
            <progress value="${m.valor_atual}" max="${m.valor_objetivo}" style="width:100%;"></progress>
        </div>`;
    });
    document.getElementById('listaMetas').innerHTML = htmlMetas;

    renderizarGrafico(categoriasTotais);
}

function verificarPendencias() {
    const hoje = new Date().toISOString().split('T')[0];
    const pendentes = transacoes.filter(t => !t.pago && t.data <= hoje);
    if (pendentes.length > 0) {
        document.getElementById('alertasPendentes').innerText = `Aviso: Tem ${pendentes.length} transações pendentes/vencidas!`;
    } else {
        document.getElementById('alertasPendentes').innerText = "";
    }
}

function atualizarSelectContas() {
    const sel = document.getElementById('tConta');
    sel.innerHTML = '<option value="">Selecione...</option>';
    contas.forEach(c => {
        sel.innerHTML += `<option value="${c.id}">${c.nome}</option>`;
    });
}

function renderizarGrafico(dados) {
    const ctx = document.getElementById('graficoDespesas').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    
    // Mapeamento simplificado das categorias fixas
    const labelsMap = { "1": "Alimentação", "2": "Transporte", "3": "Lazer", "4": "Outros" };
    
    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(dados).map(k => labelsMap[k] || "Outros"),
            datasets: [{
                data: Object.values(dados),
                backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom', labels:{color: 'var(--txt)'} } } }
    });
}

// ---------------------------------------------------
// 5. Utilitários (Modais, Zoom, Relatório)
// ---------------------------------------------------
function abrirModal(id) { document.getElementById(id).classList.add('active'); document.getElementById('overlay').classList.add('active'); }
function fecharModais() { 
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active')); 
    document.getElementById('overlay').classList.remove('active'); 
}

function abrirZoom(base64) {
    document.getElementById('zoomImg').src = base64;
    document.getElementById('zoomImg').style.transform = 'scale(1)';
    document.getElementById('imageViewer').style.display = 'flex';
}
function fecharZoom() { document.getElementById('imageViewer').style.display = 'none'; }
function aplicarZoom(img) {
    let scale = img.style.transform === 'scale(2)' ? 'scale(1)' : 'scale(2)';
    img.style.transform = scale;
}

function baixarRelatorio() {
    const ini = document.getElementById('eDataIni').value;
    const fim = document.getElementById('eDataFim').value;
    let filtrado = transacoes.filter(t => t.data >= ini && t.data <= fim);
    
    let csv = "Data,Tipo,Descricao,Valor,Status\n";
    filtrado.forEach(t => {
        csv += `${t.data},${t.tipo},${t.descricao},${t.valor},${t.pago ? 'Pago' : 'Pendente'}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('hidden', '');
    a.setAttribute('href', url);
    a.setAttribute('download', 'relatorio_financas.csv');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    fecharModais();
}

// Sincronização em Background (Registada no Service Worker)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js');
    });
}
