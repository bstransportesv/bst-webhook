/*
  BST Tracking — Webhook Server v3
  Busca telefone diretamente no localStorage via Firebase
*/

const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use(function(req, res, next){
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,apikey,Authorization");
  if(req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

let db;
try {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(sa) });
  db = getFirestore();
  console.log("Firebase conectado OK");
} catch(e) {
  console.error("Firebase erro:", e.message);
}

const EVO_URL        = process.env.EVO_URL        || "https://evolution-api-production-4f04.up.railway.app";
const EVO_INST       = process.env.EVO_INST       || "bst-tracking";
const EVO_INST_TOKEN = process.env.EVO_INST_TOKEN || "C77DA501-AB7A-4A8F-A0D7-97B0837D21DB";

function normPhone(tel) {
  if(!tel) return "";
  let d = String(tel).replace(/\D/g, "");
  if(d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if(d.length === 12 && d.startsWith("55")) d = d.slice(2);
  return d;
}

function phoneMatch(a, b) {
  const da = normPhone(a);
  const db2 = normPhone(b);
  if(!da || !db2) return false;
  // compara últimos 8 dígitos
  return da.slice(-8) === db2.slice(-8);
}

const flowStates = {};

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "BST Webhook Server v3", ts: new Date().toISOString() });
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body  = req.body;
    const event = body.event || "";
    console.log("=== WEBHOOK ===", event);

    if(!event.includes("MESSAGES_UPSERT") && !event.includes("message")) return;

    const data = body.data || {};
    const key  = data.key || {};
    if(key.fromMe) return;

    const jid   = key.remoteJid || "";
    const phone = normPhone(jid.replace("@s.whatsapp.net","").replace("@c.us",""));

    const msg  = data.message || {};
    const text = msg.conversation
      || (msg.extendedTextMessage && msg.extendedTextMessage.text)
      || (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText)
      || (msg.listResponseMessage && msg.listResponseMessage.title)
      || "";

    if(!text || !phone) {
      console.log("Ignorado - sem texto ou phone. jid:", jid);
      return;
    }

    console.log(`Mensagem de ${phone}: "${text}"`);

    /* Busca deliveries e config do Firebase */
    const [delSnap, cfgSnap] = await Promise.all([
      db.collection("sistema").doc("deliveries").get(),
      db.collection("sistema").doc("config").get()
    ]);

    if(!delSnap.exists) { console.log("Sem deliveries"); return; }

    let deliveries = delSnap.data().items || [];
    
    /* Busca waPhones - tanto do config quanto do campo waPhones nas entregas */
    const cfgData  = cfgSnap.exists ? cfgSnap.data() : {};
    const waPhones = cfgData.waPhones || {};
    
    console.log("waPhones no Firebase:", JSON.stringify(waPhones));

    /* Tenta encontrar motorista pelo waPhones */
    let matchMotorista = null;
    for(const [nome, tel] of Object.entries(waPhones)) {
      if(phoneMatch(tel, phone)) {
        matchMotorista = nome;
        console.log("Match via waPhones:", nome, "tel:", tel, "phone:", phone);
        break;
      }
    }

    /* Se não encontrou, tenta pelo campo phone nas próprias entregas */
    if(!matchMotorista) {
      const delComPhone = deliveries.find(d => d.waPhone && phoneMatch(d.waPhone, phone) && !d.dtEntrega);
      if(delComPhone) {
        matchMotorista = delComPhone.motorista;
        console.log("Match via delivery.waPhone:", matchMotorista);
      }
    }

    if(!matchMotorista) {
      console.log("Motorista não encontrado. phone:", phone);
      console.log("waPhones disponíveis:", JSON.stringify(waPhones));
      
      /* Salva mensagem não identificada para diagnóstico */
      await db.collection("sistema").doc("inbox_unknown").set({
        messages: require("firebase-admin/firestore").FieldValue
          ? [] 
          : []
      }, { merge: true }).catch(()=>{});
      
      /* Tenta responder pedindo identificação */
      await sendWhatsApp(jid, "Olá! Não consegui identificar sua entrega. Por favor entre em contato com a equipe BST Transportes.");
      return;
    }

    /* Encontra NF pendente */
    const matchDel = deliveries.find(d => d.motorista === matchMotorista && !d.dtEntrega);
    if(!matchDel) {
      console.log("Nenhuma NF pendente para:", matchMotorista);
      await sendWhatsApp(jid, `Olá ${matchMotorista.split(" ")[0]}! Não encontrei entregas pendentes para você no momento.`);
      return;
    }

    console.log("NF encontrada:", matchDel.nota, "motorista:", matchMotorista);

    const now   = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const inMsg = { dir:"in", txt:text, autor:matchMotorista, ts:now, auto:true };

    const { reply, updates } = processReply(matchDel, text);
    console.log("Reply:", reply ? reply.substring(0,80) : "(nenhum)");

    deliveries = deliveries.map(d => {
      if(d.id !== matchDel.id) return d;
      const chatMsgs = [...(d.chatMsgs || []), inMsg];
      if(reply) chatMsgs.push({ dir:"out", txt:reply, autor:"Sistema BST", ts:now, auto:true });
      return Object.assign({}, d, { chatMsgs }, updates || {});
    });

    await db.collection("sistema").doc("deliveries").set(
      { items: deliveries, nextId: delSnap.data().nextId },
      { merge: true }
    );
    console.log("Firebase atualizado OK");

    if(reply) await sendWhatsApp(jid, reply);

  } catch(e) {
    console.error("Webhook error:", e.message);
  }
});

function processReply(d, text) {
  const lower = text.toLowerCase().trim();
  const state = flowStates[d.id] || null;
  let reply = "";
  let updates = {};
  const nome = d.motorista ? d.motorista.split(" ")[0] : "motorista";

  if(text === "1" || lower.includes("sim") || lower.includes("entregue") || lower.includes("foi")) {
    if(!d.dtEntrega) {
      reply = `✅ Ótimo ${nome}! Por favor informe a *data de entrega* da NF ${d.nota} no formato DD/MM/AAAA:`;
      flowStates[d.id] = "aguardando_data";
    } else {
      reply = `ℹ️ A NF ${d.nota} já foi registrada como entregue em ${d.dtEntrega}.`;
    }
  } else if(text === "2" || lower.includes("não") || lower.includes("nao") || lower.includes("ainda")) {
    reply = `📅 Qual é a *data prevista* para a entrega da NF ${d.nota} com destino ${d.cidade}/${d.estado}? (DD/MM/AAAA)`;
    flowStates[d.id] = "aguardando_data_prevista";
  } else if(text === "3" || lower.includes("problem") || lower.includes("imprevisto")) {
    reply = `⚠️ Entendido! Descreva brevemente o problema com a NF ${d.nota}:`;
    flowStates[d.id] = "aguardando_problema";
  } else if(state === "aguardando_data") {
    const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if(m) {
      const iso = `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
      updates.dtEntrega = iso;
      reply = `📋 Data ${text} registrada! Agora informe o *nome completo e CPF* de quem recebeu a mercadoria:`;
      flowStates[d.id] = "aguardando_recebedor";
    } else {
      reply = `❌ Formato não reconhecido. Informe como *DD/MM/AAAA* (ex: 28/06/2026):`;
    }
  } else if(state === "aguardando_data_prevista") {
    reply = `📌 Anotado! Aguardaremos a entrega. Obrigado ${nome}! 👍`;
    flowStates[d.id] = null;
  } else if(state === "aguardando_recebedor") {
    updates.recebedor = text;
    reply = `✅ Entrega da NF ${d.nota} registrada com sucesso! Muito obrigado ${nome}! 🎉`;
    flowStates[d.id] = null;
  } else if(state === "aguardando_problema") {
    reply = `📋 Ocorrência registrada! Nossa equipe entrará em contato em breve. Obrigado ${nome}!`;
    flowStates[d.id] = null;
  } else {
    reply = `Olá ${nome}! 👋\n\nSobre a *NF ${d.nota}* com destino *${d.cidade}/${d.estado}*:\n\nResponda:\n*1* — Sim, já foi entregue ✅\n*2* — Ainda não foi entregue 📅\n*3* — Houve algum problema ⚠️`;
  }

  return { reply, updates };
}

async function sendWhatsApp(jid, text) {
  try {
    const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": EVO_INST_TOKEN },
      body: JSON.stringify({ number: jid, text })
    });
    const data = await res.json();
    console.log("WA enviado status:", res.status);
    if(!res.ok) console.error("WA erro:", JSON.stringify(data).substring(0,200));
  } catch(e) {
    console.error("sendWhatsApp error:", e.message);
  }
}

/* Salva waPhones do sistema web */
app.post("/save-phones", async (req, res) => {
  try {
    const { waPhones } = req.body;
    if(!waPhones) return res.status(400).json({ error: "waPhones required" });
    console.log("Salvando phones:", JSON.stringify(waPhones));
    await db.collection("sistema").doc("config").set({ waPhones }, { merge: true });
    res.json({ ok: true, saved: Object.keys(waPhones).length });
  } catch(e) {
    console.error("save-phones:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Salva waPhone diretamente na entrega — chamado quando cadastra telefone no chat */
app.post("/save-delivery-phone", async (req, res) => {
  try {
    const { nfId, motorista, phone } = req.body;
    if(!motorista || !phone) return res.status(400).json({ error: "motorista e phone obrigatorios" });
    
    const delSnap = await db.collection("sistema").doc("deliveries").get();
    if(!delSnap.exists) return res.status(404).json({ error: "sem deliveries" });
    
    let items = delSnap.data().items || [];
    items = items.map(d => {
      if(d.motorista === motorista) return Object.assign({}, d, { waPhone: phone });
      return d;
    });
    
    await db.collection("sistema").doc("deliveries").set(
      { items, nextId: delSnap.data().nextId },
      { merge: true }
    );
    
    /* Salva também no waPhones do config */
    const update = {};
    update[`waPhones.${motorista}`] = phone;
    await db.collection("sistema").doc("config").set(update, { merge: true });
    
    console.log("Phone salvo para motorista:", motorista, phone);
    res.json({ ok: true });
  } catch(e) {
    console.error("save-delivery-phone:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BST Webhook Server v3 rodando na porta ${PORT}`));
