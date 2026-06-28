/*
  BST Tracking — Webhook Server
  Recebe mensagens da Evolution API e salva no Firebase
*/

const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ── CORS ── */
app.use(function(req, res, next){
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,apikey,Authorization");
  if(req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ── Firebase ── */
let db;
try {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(sa) });
  db = getFirestore();
  console.log("Firebase conectado OK");
} catch(e) {
  console.error("Firebase erro:", e.message);
}

const EVO_URL   = process.env.EVO_URL   || "https://evolution-api-production-4f04.up.railway.app";
const EVO_KEY   = process.env.EVO_KEY   || "e33b722cda8840b081914391ef5e55bc7ee16d72f85e6559d4ab180073c10d27";
const EVO_INST  = process.env.EVO_INST  || "bst-tracking";
const EVO_INST_TOKEN = process.env.EVO_INST_TOKEN || "C77DA501-AB7A-4A8F-A0D7-97B0837D21DB";

/* ── Health check ── */
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "BST Webhook Server", ts: new Date().toISOString() });
});

/* ── Normaliza telefone: retorna apenas dígitos sem código país ── */
function normPhone(tel) {
  if(!tel) return "";
  let d = tel.replace(/\D/g, "");
  // Remove 55 do início se tiver 13 ou 12 dígitos
  if(d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if(d.length === 12 && d.startsWith("55")) d = d.slice(2);
  return d;
}

/* ── Compara telefones: últimos 8 dígitos ── */
function phoneMatch(a, b) {
  const da = normPhone(a);
  const db2 = normPhone(b);
  if(!da || !db2) return false;
  return da.slice(-8) === db2.slice(-8);
}

/* ── Flow states ── */
const flowStates = {};

/* ── Webhook principal ── */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    const event = body.event || "";
    console.log("=== WEBHOOK ===", event);

    /* Só processa eventos de mensagem */
    if(!event.includes("MESSAGES_UPSERT") && !event.includes("message")) {
      return;
    }

    const data = body.data || {};
    const key  = data.key || {};

    /* Ignora mensagens enviadas por nós */
    if(key.fromMe) return;

    /* Extrai telefone */
    const jid   = key.remoteJid || "";
    const phone = normPhone(jid.replace("@s.whatsapp.net","").replace("@c.us",""));

    /* Extrai texto */
    const msg  = data.message || {};
    const text = msg.conversation
      || (msg.extendedTextMessage && msg.extendedTextMessage.text)
      || (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText)
      || (msg.listResponseMessage && msg.listResponseMessage.title)
      || "";

    if(!text || !phone) {
      console.log("Ignorado - sem texto ou phone. jid:", jid, "text:", text);
      return;
    }

    console.log(`Mensagem de ${phone}: "${text}"`);

    /* Busca dados do Firebase */
    const [delSnap, cfgSnap] = await Promise.all([
      db.collection("sistema").doc("deliveries").get(),
      db.collection("sistema").doc("config").get()
    ]);

    if(!delSnap.exists) { console.log("Sem deliveries no Firebase"); return; }

    let deliveries = delSnap.data().items || [];
    const waPhones = (cfgSnap.exists && cfgSnap.data().waPhones) || {};

    console.log("waPhones cadastrados:", JSON.stringify(waPhones));
    console.log("Phone recebido:", phone);

    /* Encontra motorista pelo telefone */
    let matchMotorista = null;

    /* 1. Busca no mapa waPhones */
    for(const [nome, tel] of Object.entries(waPhones)) {
      if(phoneMatch(tel, phone)) {
        matchMotorista = nome;
        console.log("Match via waPhones:", nome, tel);
        break;
      }
    }

    if(!matchMotorista) {
      console.log("Motorista não encontrado para telefone:", phone);
      console.log("waPhones disponíveis:", JSON.stringify(waPhones));
      return;
    }

    /* Encontra NF pendente do motorista */
    const matchDel = deliveries.find(d =>
      d.motorista === matchMotorista && !d.dtEntrega
    );

    if(!matchDel) {
      console.log("Nenhuma NF pendente para:", matchMotorista);
      return;
    }

    console.log("NF encontrada:", matchDel.nota, "motorista:", matchMotorista);

    /* Registra mensagem recebida */
    const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const inMsg = { dir:"in", txt:text, autor:matchMotorista, ts:now, auto:true };

    /* Processa resposta e gera reply */
    const { reply, updates } = processReply(matchDel, text);
    console.log("Reply gerado:", reply);

    /* Atualiza entrega no array */
    deliveries = deliveries.map(d => {
      if(d.id !== matchDel.id) return d;
      const chatMsgs = [...(d.chatMsgs || []), inMsg];
      if(reply) chatMsgs.push({ dir:"out", txt:reply, autor:"Sistema BST", ts:now, auto:true });
      return Object.assign({}, d, { chatMsgs }, updates || {});
    });

    /* Salva no Firebase */
    await db.collection("sistema").doc("deliveries").set(
      { items: deliveries, nextId: delSnap.data().nextId },
      { merge: true }
    );
    console.log("Firebase atualizado OK");

    /* Envia reply pelo WhatsApp */
    if(reply) {
      await sendWhatsApp(jid, reply);
    }

  } catch(e) {
    console.error("Webhook error:", e.message, e.stack);
  }
});

/* ── Processa resposta do motorista ── */
function processReply(d, text) {
  const lower = text.toLowerCase().trim();
  const state = flowStates[d.id] || null;
  let reply = "";
  let updates = {};

  if(text === "1" || lower.includes("sim") || lower.includes("entregue") || lower.includes("foi entregue")) {
    if(!d.dtEntrega) {
      reply = `✅ Ótimo ${d.motorista.split(" ")[0]}! Por favor informe a *data de entrega* no formato DD/MM/AAAA:`;
      flowStates[d.id] = "aguardando_data";
    } else {
      reply = `ℹ️ A NF ${d.nota} já está registrada como entregue em ${d.dtEntrega}.`;
    }
  } else if(text === "2" || lower.includes("não") || lower.includes("nao") || lower.includes("ainda não")) {
    reply = `📅 Qual é a *data prevista* para a entrega da NF ${d.nota}? (DD/MM/AAAA)`;
    flowStates[d.id] = "aguardando_data_prevista";
  } else if(text === "3" || lower.includes("problem") || lower.includes("imprevisto") || lower.includes("acidente")) {
    reply = `⚠️ Entendido! Descreva brevemente o problema para registrarmos:`;
    flowStates[d.id] = "aguardando_problema";
  } else if(state === "aguardando_data") {
    const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if(m) {
      const iso = `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
      updates.dtEntrega = iso;
      reply = `📋 Data registrada! Agora informe o *nome completo e CPF* de quem recebeu a mercadoria:`;
      flowStates[d.id] = "aguardando_recebedor";
    } else {
      reply = `❌ Formato não reconhecido. Informe a data como *DD/MM/AAAA*:`;
    }
  } else if(state === "aguardando_data_prevista") {
    reply = `📌 Anotado! Entrega prevista para ${text}. Obrigado ${d.motorista.split(" ")[0]}! 👍`;
    flowStates[d.id] = null;
  } else if(state === "aguardando_recebedor") {
    updates.recebedor = text;
    reply = `✅ Perfeito! Entrega da NF ${d.nota} registrada com sucesso! Obrigado ${d.motorista.split(" ")[0]}! 🎉`;
    flowStates[d.id] = null;
  } else if(state === "aguardando_problema") {
    reply = `📋 Ocorrência registrada! Nossa equipe entrará em contato em breve. Obrigado por informar!`;
    flowStates[d.id] = null;
  } else {
    reply = `Olá ${d.motorista.split(" ")[0]}! Sobre a NF ${d.nota} com destino ${d.cidade}/${d.estado}, responda:\n\n*1* — Sim, já foi entregue\n*2* — Ainda não foi entregue\n*3* — Houve algum problema`;
  }

  return { reply, updates };
}

/* ── Envia mensagem pelo WhatsApp ── */
async function sendWhatsApp(jid, text) {
  try {
    const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": EVO_INST_TOKEN },
      body: JSON.stringify({ number: jid, text })
    });
    const data = await res.json();
    console.log("WhatsApp enviado:", res.status, JSON.stringify(data).substring(0,100));
  } catch(e) {
    console.error("sendWhatsApp error:", e.message);
  }
}

/* ── Salva telefones vindos do sistema ── */
app.post("/save-phones", async (req, res) => {
  try {
    const { waPhones } = req.body;
    if(!waPhones) return res.status(400).json({ error: "waPhones required" });
    console.log("Salvando phones:", JSON.stringify(waPhones));
    await db.collection("sistema").doc("config").set({ waPhones }, { merge: true });
    res.json({ ok: true, saved: Object.keys(waPhones).length });
  } catch(e) {
    console.error("save-phones error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BST Webhook Server rodando na porta ${PORT}`));
