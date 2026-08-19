const { Client, LocalAuth } = require('@juzi/whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let API_URL = process.env.API_URL || 'http://localhost:3000'; 

let botStatus = 'DISCONNECTED';
let currentQrCodeUrl = '';

let textos = {
    welcome: '?? Olá! Sou o assistente de TI.\nPara abrir um chamado, por favor escolha a opção do *NOME DO LOCAL*.',
    location: '? Certo, local anotado.\n\nAgora me *escreva detalhadamente o problema* que está ocorrendo:',
    success: '?? *Chamado Aberto com Sucesso!*\nNossa equipe de TI já foi notificada e resolverá em breve.',
    locations: [] 
};

async function fetchFromAPI(endpoint, options = {}) {
    const portsToTry = [3000, 3002, 3003, 3004, 3005];
    
    for (let port of portsToTry) {
        try {
            const res = await fetch('http://localhost:' + port + endpoint, options);
            if (res.ok) {
                const contentType = res.headers.get('content-type');
                // IMPORTANTE: Só aceita se for JSON. Se for HTML, ignora e tenta a próxima porta!
                if (contentType && contentType.includes('application/json')) {
                    API_URL = 'http://localhost:' + port;
                    return res;
                }
            }
        } catch(e) {}
    }
    
    throw new Error("Painel Offline em todas as portas testadas");
}

async function atualizarTextos() {
    try {
        const res = await fetchFromAPI('/api/webhook/whatsapp/config');
        const data = await res.json();
        if (data.whatsapp_welcome_msg) textos.welcome = data.whatsapp_welcome_msg;
        if (data.whatsapp_location_msg) textos.location = data.whatsapp_location_msg;
        if (data.whatsapp_success_msg) textos.success = data.whatsapp_success_msg;
        if (data.locations) textos.locations = data.locations;
        console.log('Configs e Locais atualizados com sucesso via ' + API_URL);
    } catch (e) {
        console.log('Painel offline ou URL incorreta. Usando dados em cache/padrão.');
    }
}

setInterval(atualizarTextos, 60000);
atualizarTextos();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', async (qr) => {
    botStatus = 'QR_READY';
    try {
        currentQrCodeUrl = await qrcode.toDataURL(qr);
        console.log('QR Code gerado com sucesso.');
    } catch (err) { }
});

client.on('ready', () => {
    botStatus = 'CONNECTED';
    currentQrCodeUrl = '';
    console.log('Bot conectado!');
});

client.on('disconnected', () => {
    botStatus = 'DISCONNECTED';
    currentQrCodeUrl = '';
});

const conversas = {};

const getChildren = (parentId) => textos.locations.filter(l => l.parentId === parentId);

async function enviarChamado(dados, numeroUser, msg) {
    if (!dados.base64Image) {
        await client.sendMessage(numeroUser, '? Aguarde um instante, estou registrando seu chamado no sistema...');
    }
    try {
        const contact = await msg.getContact();
        const nomeReal = contact.pushname || contact.name || 'Desconhecido';
        const telefoneReal = contact.number || numeroUser.split('@')[0];
        
        const resposta = await fetchFromAPI('/api/webhook/whatsapp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telefone: telefoneReal,
                nomeContato: nomeReal, 
                locationId: dados.locationId,
                local: dados.locationName, 
                problema: dados.problema,
                base64Image: dados.base64Image || undefined
            })
        });

        const json = await resposta.json();
        await client.sendMessage(numeroUser, textos.success);
        
        // Encaminhar para os administradores
        if (json.alertNumbers && json.alertNumbers.length > 0) {
            const msgAdmin = `?? *Novo Chamado #${json.ticketNumber || json.ticketId}*\n\n*De:* ${nomeReal} (${telefoneReal})\n*Local:* ${dados.locationName}\n*Problema:* ${dados.problema}`;
            for (const num of json.alertNumbers) {
                try {
                    let cleanNum = num.replace(/\D/g, ''); 
                    if (!cleanNum.startsWith('55') && cleanNum.length <= 11) { 
                        cleanNum = '55' + cleanNum; 
                    } 
                    
                    const numberId = await client.getNumberId(cleanNum);
                    if (numberId) {
                        await client.sendMessage(numberId._serialized, msgAdmin);
                    } else {
                        // Tenta fallback caso o getNumberId falhe
                        const fallbackId = cleanNum.includes('@c.us') ? cleanNum : `${cleanNum}@c.us`;
                        await client.sendMessage(fallbackId, msgAdmin);
                    }
                } catch (sendErr) {
                    console.error('Erro ao enviar alerta para administrador:', num, sendErr.message);
                }
            }
        }
        
    } catch (erro) {
        console.error('Erro em enviarChamado:', erro);
        await client.sendMessage(numeroUser, '? Servidor da TI parece estar offline.');
    }
    delete conversas[numeroUser];
}

client.on('message', async (msg) => {
    const numeroUser = msg.from;
    const texto = msg.body ? msg.body.toLowerCase().trim() : '';

    if (texto === 'sair' || texto === 'cancelar' || texto === 'encerrar') {
        if (conversas[numeroUser]) {
            delete conversas[numeroUser];
            await client.sendMessage(numeroUser, '?? Atendimento encerrado. Se precisar de algo, é só mandar uma mensagem novamente.');
        }
        return;
    }

    if (!conversas[numeroUser]) {
        if (msg.type !== 'chat') return;
        
        // QUALQUER mensagem inicia o bot!
        conversas[numeroUser] = { passo: 1, dados: { currentNodeId: null } };
        
        const rootLocations = getChildren(null);
        
        let menu = textos.welcome + '\n\n*Digite o NÚMERO do local abaixo:*\n\n';
        if (rootLocations.length > 0) {
            rootLocations.forEach((loc, index) => {
                menu += (index + 1) + ' - ' + loc.name + '\n';
            });
            conversas[numeroUser].dados.menuOptions = rootLocations;
        } else {
            menu += '?? O sistema não conseguiu carregar a lista de locais do servidor. Tente novamente mais tarde ou contate o TI.';
        }
        
        menu += '\n*(Ou digite "Sair" para cancelar)*';
        await client.sendMessage(numeroUser, menu);
        return;
    }

    const estado = conversas[numeroUser];

    if (estado.passo < 4 && msg.type !== 'chat') {
        await client.sendMessage(numeroUser, '? *Por favor, digite sua resposta em texto.*\nNão consigo entender áudios, vídeos ou imagens nesta etapa.');
        return;
    }

    if (estado.passo === 1) {
        const ehZero = texto === '0';
        const indexEscolhido = parseInt(texto) - 1;
        const opcoesAtuais = estado.dados.menuOptions;

        if (ehZero && estado.dados.currentNodeId !== null) {
            estado.passo = 2;
            await client.sendMessage(numeroUser, textos.location + '\n*(Ou digite "Sair" para cancelar)*');
            return;
        }
        
        if (isNaN(indexEscolhido) || indexEscolhido < 0 || !opcoesAtuais[indexEscolhido]) {
            await client.sendMessage(numeroUser, '? Opção inválida.\nPor favor, digite apenas o *NÚMERO* correspondente ao local, ou "Sair" para cancelar.');
            return;
        }

        const localSelecionado = opcoesAtuais[indexEscolhido];
        const filhos = getChildren(localSelecionado.id);
        
        if (filhos.length > 0) {
            estado.dados.currentNodeId = localSelecionado.id;
            estado.dados.locationName = estado.dados.locationName ? estado.dados.locationName + ' > ' + localSelecionado.name : localSelecionado.name;
            estado.dados.locationId = localSelecionado.id;
            estado.dados.menuOptions = filhos;
            
            let submenu = '? *' + localSelecionado.name + '*\n\n';
            submenu += 'O problema é no local inteiro ou em um sub-local específico?\n\n';
            submenu += '0 - Geral (O local inteiro)\n';
            
            filhos.forEach((filho, i) => {
                submenu += (i + 1) + ' - ' + filho.name + '\n';
            });
            
            submenu += '\n*(Ou digite "Sair" para cancelar)*';
            
            await client.sendMessage(numeroUser, submenu);
        } else {
            estado.dados.locationId = localSelecionado.id;
            estado.dados.locationName = estado.dados.locationName ? estado.dados.locationName + ' > ' + localSelecionado.name : localSelecionado.name;
            estado.passo = 2;
            await client.sendMessage(numeroUser, textos.location + '\n*(Ou digite "Sair" para cancelar)*');
        }
        return;
    }

    if (estado.passo === 2) {
        estado.dados.problema = msg.body;
        estado.passo = 3;
        await client.sendMessage(numeroUser, '?? Deseja anexar uma foto do problema?\n\n1 - Sim\n2 - Não\n\n*(Ou digite "Sair" para cancelar)*');
        return;
    }

    if (estado.passo === 3) {
        if (texto === '2') {
            await enviarChamado(estado.dados, numeroUser, msg);
            return;
        } else if (texto === '1') {
            estado.passo = 4;
            await client.sendMessage(numeroUser, 'Envie a foto agora! (Estou aguardando...)');
            return;
        } else {
            await client.sendMessage(numeroUser, '? Opção inválida. Digite 1 para Sim ou 2 para Não.');
            return;
        }
    }

    if (estado.passo === 4) {
        if (msg.hasMedia) {
            await client.sendMessage(numeroUser, '? Aguarde um instante, estou baixando sua foto e registrando o chamado...');
            try {
                try {
                    const chat = await msg.getChat();
                    await chat.fetchMessages({ limit: 5 });
                } catch(e) {}
                const media = await msg.downloadMedia();
                if (media && media.data) {
                    try {
                        const sharp = require('sharp');
                        const buffer = Buffer.from(media.data, 'base64');
                        const compressedBuffer = await sharp(buffer)
                            .resize({ width: 800, withoutEnlargement: true })
                            .jpeg({ quality: 60 })
                            .toBuffer();
                        estado.dados.base64Image = compressedBuffer.toString('base64');
                        console.log('Imagem comprimida com sucesso!');
                    } catch (sharpErr) {
                        console.log('Erro ao comprimir imagem com sharp:', sharpErr);
                        estado.dados.base64Image = media.data;
                    }
                } else {
                    console.log('DownloadMedia nao retornou data.');
                }
                await enviarChamado(estado.dados, numeroUser, msg);
            } catch (err) {
                console.error('Erro no downloadMedia:', err);
                await client.sendMessage(numeroUser, '? Ocorreu um erro ao baixar sua foto. Vamos abrir o chamado sem foto mesmo...');
                await enviarChamado(estado.dados, numeroUser, msg);
            }
        } else {
            if (texto === '2') {
                await enviarChamado(estado.dados, numeroUser, msg);
            } else {
                await client.sendMessage(numeroUser, '? Eu esperava uma foto! Se nao quiser mais enviar a foto, digite "2".');
            }
        }
        return;
    }
});

client.initialize();

app.get('/status', (req, res) => res.json({ status: botStatus, qrCode: currentQrCodeUrl }));
app.post('/logout', async (req, res) => {
    try {
        await client.logout();
        botStatus = 'DISCONNECTED';
        currentQrCodeUrl = '';
        res.json({ success: true });
        setTimeout(() => client.initialize(), 3000); 
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.listen(3001, () => console.log('Mini-API rodando na porta 3001'));
