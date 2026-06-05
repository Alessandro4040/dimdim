// ==========================================
// MÁQUINA DE ESTADOS DO CHATBOT FINANCEIRO
// ==========================================

let chatFluxo = {
    ativo: false,
    etapa: 0,
    dadosTemp: {}
};

function iniciarChat() {
    chatFluxo = { ativo: true, etapa: 0, dadosTemp: {} };
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('chatQuickReplies').style.display = 'none';
    document.getElementById('chatInput').value = '';
    
    // Abre a tela do chat
    document.getElementById('modalChat').classList.add('active');
    document.getElementById('overlay').classList.add('active');
    
    // Animação inicial mais rápida
    setTimeout(() => {
        adicionarBalaoChat('bot', 'Olá! O que você quer registrar agora?');
        mostrarBotoesRapidos([
            { label: '💸 Despesa', valor: 'despesa' },
            { label: '💰 Receita', valor: 'receita' },
            { label: '🔄 Transferência', valor: 'transferencia' }
        ]);
    }, 200);
}

// NOVA FUNÇÃO: Garante o fechamento instantâneo e limpa o status
function fecharChat() {
    chatFluxo.ativo = false;
    document.getElementById('modalChat').classList.remove('active');
    document.getElementById('overlay').classList.remove('active');
}

function adicionarBalaoChat(remetente, texto) {
    const chat = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `chat-bubble chat-${remetente}`;
    div.innerText = texto;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight; // Mantém a rolagem sempre no final
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
    if (!chatFluxo.ativo) return;

    adicionarBalaoChat('user', labelExibicao);
    mostrarBotoesRapidos([]);
    
    const etapaAtual = chatFluxo.etapa;
    
    if (etapaAtual === 0) {
        chatFluxo.dadosTemp.tipo = valor.toLowerCase().trim();
        chatFluxo.etapa = 1;
        setTimeout(() => adicionarBalaoChat('bot', 'Qual é o valor? (ex: 150,50)'), 300);
        
    } else if (etapaAtual === 1) {
        let valStr = valor.toString().replace('R$', '').replace(',', '.').trim();
        let v = parseFloat(valStr);
        if (isNaN(v)) {
            setTimeout(() => adicionarBalaoChat('bot', 'Isso não parece um número. Por favor, digite apenas o valor.'), 300);
            return;
        }
        chatFluxo.dadosTemp.valor = v;
        chatFluxo.etapa = 2;
        setTimeout(() => adicionarBalaoChat('bot', 'Qual é a descrição? (ex: Mercado, Gasolina)'), 300);
        
    } else if (etapaAtual === 2) {
        chatFluxo.dadosTemp.descricao = valor;
        chatFluxo.etapa = 3;
        setTimeout(() => {
            let msg = chatFluxo.dadosTemp.tipo === 'transferencia' ? 'De qual conta vai SAIR o dinheiro?' : 'Em qual conta/cartão?';
            adicionarBalaoChat('bot', msg);
            let opsContas = contas.map(c => ({ label: c.nome, valor: c.id }));
            mostrarBotoesRapidos(opsContas);
        }, 300);
        
    } else if (etapaAtual === 3) {
        chatFluxo.dadosTemp.conta_id = valor;
        
        if (chatFluxo.dadosTemp.tipo === 'transferencia') {
            chatFluxo.etapa = 3.5;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Para qual conta o dinheiro vai ENTRAR?');
                let opsContasDestino = contas.filter(c => c.id !== valor).map(c => ({ label: c.nome, valor: c.id }));
                mostrarBotoesRapidos(opsContasDestino);
            }, 300);
        } else {
            chatFluxo.etapa = 4;
            setTimeout(() => {
                adicionarBalaoChat('bot', 'Qual é a categoria?');
                let opsCat = categorias.filter(c => c.id !== 'cat_transferencia').map(c => ({ label: c.nome, valor: c.id }));
                mostrarBotoesRapidos(opsCat);
            }, 300);
        }
        
    } else if (etapaAtual === 3.5) {
        chatFluxo.dadosTemp.conta_destino_id = valor;
        chatFluxo.etapa = 5;
        setTimeout(() => {
            const origem = contas.find(c => c.id === chatFluxo.dadosTemp.conta_id)?.nome;
            const destino = contas.find(c => c.id === valor)?.nome;
            adicionarBalaoChat('bot', `Resumo:\n🔄 Transf. de R$ ${chatFluxo.dadosTemp.valor.toFixed(2)}\nDe: ${origem}\nPara: ${destino}\nDesc: ${chatFluxo.dadosTemp.descricao}\n\nPosso salvar?`);
            mostrarBotoesRapidos([{label: '✅ Sim, salvar', valor: 'sim'}, {label: '❌ Cancelar', valor: 'nao'}]);
        }, 300);

    } else if (etapaAtual === 4) {
        chatFluxo.dadosTemp.categoria_id = valor;
        chatFluxo.etapa = 5;
        setTimeout(() => {
            const conta = contas.find(c => c.id === chatFluxo.dadosTemp.conta_id)?.nome;
            const cat = categorias.find(c => c.id === valor)?.nome || 'Sem categoria';
            const icone = chatFluxo.dadosTemp.tipo === 'despesa' ? '💸' : '💰';
            adicionarBalaoChat('bot', `Resumo:\n${icone} ${chatFluxo.dadosTemp.tipo.toUpperCase()} - R$ ${chatFluxo.dadosTemp.valor.toFixed(2)}\nDesc: ${chatFluxo.dadosTemp.descricao}\nConta: ${conta}\nCat: ${cat}\n\nPosso salvar?`);
            mostrarBotoesRapidos([{label: '✅ Sim, salvar', valor: 'sim'}, {label: '❌ Cancelar', valor: 'nao'}]);
        }, 300);
        
    } else if (etapaAtual === 5) {
        let conf = valor.toString().toLowerCase().trim();
        if (conf === 'sim' || conf === '✅ sim, salvar') {
            finalizarSalvamentoChat();
        } else {
            fecharChat(); // Fecha imediatamente se o usuário clicar em Cancelar
        }
    }
}

async function finalizarSalvamentoChat() {
    // Pegamos a data atual ajustando o fuso horário
    const tzOffset = (new Date()).getTimezoneOffset() * 60000;
    const dataStr = (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
    
    try {
        if (chatFluxo.dadosTemp.tipo === 'transferencia') {
            const idOriginal = uuidv4();
            const saida = {
                id: uuidv4(), id_original: idOriginal,
                tipo: 'despesa', descricao: chatFluxo.dadosTemp.descricao,
                valor: chatFluxo.dadosTemp.valor, data: dataStr,
                conta_id: chatFluxo.dadosTemp.conta_id, categoria_id: 'cat_transferencia',
                pago: true, parcela_num: 1, parcela_total: 1,
                foto: null, sinc: false, updated_at: new Date().toISOString()
            };
            const entrada = {
                id: uuidv4(), id_original: idOriginal,
                tipo: 'receita', descricao: chatFluxo.dadosTemp.descricao,
                valor: chatFluxo.dadosTemp.valor, data: dataStr,
                conta_id: chatFluxo.dadosTemp.conta_destino_id, categoria_id: 'cat_transferencia',
                pago: true, parcela_num: 1, parcela_total: 1,
                foto: null, sinc: false, updated_at: new Date().toISOString()
            };
            await salvarItemDB('transacoes', saida);
            await salvarItemDB('transacoes', entrada);
        } else {
            const transacao = {
                id: uuidv4(),
                id_original: uuidv4(),
                tipo: chatFluxo.dadosTemp.tipo,
                descricao: chatFluxo.dadosTemp.descricao,
                valor: chatFluxo.dadosTemp.valor,
                data: dataStr,
                conta_id: chatFluxo.dadosTemp.conta_id,
                categoria_id: chatFluxo.dadosTemp.categoria_id,
                pago: true,
                parcela_num: 1,
                parcela_total: 1,
                foto: null,
                sinc: false,
                updated_at: new Date().toISOString()
            };
            await salvarItemDB('transacoes', transacao);
        }
        
        scheduleSync();
        
        // FECHAMENTO INSTANTÂNEO: Atualiza o painel de fundo e fecha o balão imediatamente
        setTimeout(() => {
            atualizarDashboard(); 
            fecharChat();
        }, 50); // Apenas 50 milissegundos para garantir que a UI não pisque
        
    } catch (err) {
        console.error(err);
        adicionarBalaoChat('bot', '❌ Erro ao salvar.');
    }
}
