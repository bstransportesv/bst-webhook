/*
  BST Tracking — Webhook Server
  Recebe mensagens da Evolution API e salva no Firebase
  para que o sistema web exiba as respostas dos motoristas.
*/

const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const app = express();
app.use(express.json({ limit: "10mb" }));

/* ── CORS — allow Netlify and any origin ── */
app.use(function(req, res, next){
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,apikey,Authorization");
  if(req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ── Firebase Admin (usa variável de ambiente) ── */
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
let db;
try {
  initializeApp({ credential: cert(firebaseConfig) });
  db = getFirestore();
  console.log("Firebase conectado OK");
} catch (e) {
  console.error("Firebase erro:", e.message);
}

const REF_DEL = () => db.collection("sistema").doc("deliveries");

/* ── Health check ── */
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "BST Webhook Server", ts: new Date().toISOString() });
});

/* ── Webhook principal da Evolution API ── */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); /* responde imediatamente */

  try {
    const body = req.body;
    console.log("=== WEBHOOK RECEBIDO ===");
    console.log(JSON.stringify(body).substring(0, 1000));
    console.log("========================");

    /* Só processa mensagens recebidas (não enviadas por nós) */
    const event = body.event || body.type || "";
    if (!event.includes("message") && !event.includes("MESSAGES")) return;

    /* Extrai dados da mensagem */
    const data = body.data || body;
    const key = data.key || {};
    if (key.fromMe) return; /* ignora mensagens enviadas */

    const jid = key.remoteJid || "";
    const phone = jid
      .replace("@s.whatsapp.net", "")
      .replace("@c.us", "")
      .replace(/^55/, "");

    const msg = data.message || {};
    const text =
      msg.conversation ||
      (msg.extendedTextMessage && msg.extendedTextMessage.text) ||
      (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText) ||
      (msg.listResponseMessage && msg.listResponseMessage.title) ||
      "";

    if (!text || !phone) {
      console.log("Mensagem ignorada - sem texto ou telefone");
      return;
    }

    console.log(`Mensagem de ${phone}: ${text}`);

    /* Busca as entregas no Firebase */
    const delSnap = await REF_DEL().get();
    if (!delSnap.exists) { console.log("Nenhuma entrega no Firebase"); return; }

    const delData = delSnap.data();
    let deliveries = delData.items || [];

    /* Encontra a NF pendente do motorista pelo telefone */
    /* Compara últimos 8 dígitos para tolerar variações de DDD+9 */
    const phoneDigits = phone.replace(/\D/g, "");
    
    /* Mapa de telefones: precisamos do campo waPhones salvo pelo sistema */
    const cfgSnap = await db.collection("sistema").doc("config").get();
    const waPhones = (cfgSnap.exists && cfgSnap.data().waPhones) || {};

    /* Encontra motorista pelo telefone */
    let matchMotorista = null;
    for (const [nome, tel] of Object.entries(waPhones)) {
      const telDigits = tel.replace(/\D/g, "");
      if (telDigits.slice(-8) === phoneDigits.slice(-8)) {
        matchMotorista = nome;
        break;
      }
    }

    if (!matchMotorista) {
      console.log(`Motorista não encontrado para telefone ${phone}`);
      /* Salva mensagem em inbox não identificado para diagnóstico */
      await db.collection("sistema").doc("inbox_unmatched").set(
        { messages: FieldValue.arrayUnion({ phone, text, ts: new Date().toISOString() }) },
        { merge: true }
      );
      return;
    }

    /* Encontra NF pendente deste motorista */
    const matchDel = deliveries.find(
      (d) => d.motorista === matchMotorista && !d.dtEntrega
    );

    if (!matchDel) {
      console.log(`Nenhuma NF pendente para ${matchMotorista}`);
      return;
    }

    /* Adiciona mensagem no chat da NF */
    const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const inMsg = {
      dir: "in",
      txt: text,
      autor: matchMotorista,
      ts: now,
      auto: true,
    };

    /* Processa resposta e gera reply automático */
    const { reply, updates } = processReply(matchDel, text, now);

    /* Atualiza deliveries */
    deliveries = deliveries.map((d) => {
      if (d.id !== matchDel.id) return d;
      const chatMsgs = [...(d.chatMsgs || []), inMsg];
      
      /* Adiciona reply do sistema no chat também */
      if (reply) {
        chatMsgs.push({
          dir: "out",
          txt: reply,
          autor: "Sistema Automático",
          ts: now,
          auto: true,
        });
      }

      return Object.assign({}, d, { chatMsgs }, updates || {});
    });

    /* Salva no Firebase */
    await REF_DEL().set({ items: deliveries, nextId: delData.nextId }, { merge: true });
    console.log(`Chat atualizado para NF ${matchDel.nota} — motorista ${matchMotorista}`);

    /* Envia reply pelo WhatsApp se houver */
    if (reply) {
      await sendReply(jid, reply);
    }

  } catch (e) {
    console.error("Webhook error:", e.message);
  }
});

/* ── Processar resposta do motorista ── */
const flowStates = {};

function processReply(d, text, now) {
  const lower = text.toLowerCase().trim();
  const state = flowStates[d.id] || null;
  let reply = "";
  let updates = {};

  /* Sim entregue */
  if (text === "1" || lower.includes("sim") || lower.includes("entregue") || lower.includes("foi")) {
    if (!d.dtEntrega) {
      reply = "✅ Ótimo! Por favor informe a *data de entrega* no formato DD/MM/AAAA:";
      flowStates[d.id] = "aguardando_data";
    }
  }
  /* Não entregue */
  else if (text === "2" || lower.includes("não") || lower.includes("nao") || lower.includes("ainda")) {
    reply = `📅 Qual é a *data prevista* para realizar a entrega da NF ${d.nota}? (DD/MM/AAAA)`;
    flowStates[d.id] = "aguardando_data_prevista";
  }
  /* Problema */
  else if (text === "3" || lower.includes("problem") || lower.includes("imprevisto")) {
    reply = "⚠️ Descreva brevemente o problema para registrarmos e auxiliarmos:";
    flowStates[d.id] = "aguardando_descricao_problema";
  }
  /* Data de entrega */
  else if (state === "aguardando_data") {
    const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) {
      const iso = `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
      updates.dtEntrega = iso;
      reply = `Obrigado! Data registrada ✅\nAgora informe o *nome completo e CPF* de quem recebeu a mercadoria:`;
      flowStates[d.id] = "aguardando_recebedor";
    } else {
      reply = "Formato não reconhecido. Informe a data como *DD/MM/AAAA*:";
    }
  }
  /* Data prevista */
  else if (state === "aguardando_data_prevista") {
    reply = `📌 Anotado! Aguardaremos a entrega. Obrigado! 👍`;
    flowStates[d.id] = null;
  }
  /* Recebedor */
  else if (state === "aguardando_recebedor") {
    updates.recebedor = text;
    reply = `✅ Entrega da NF ${d.nota} registrada com sucesso! Obrigado! 🎉`;
    flowStates[d.id] = null;
  }
  /* Problema description */
  else if (state === "aguardando_descricao_problema") {
    reply = "📋 Ocorrência registrada! Nossa equipe entrará em contato. Obrigado por informar!";
    flowStates[d.id] = null;
  }
  /* Mensagem não reconhecida */
  else {
    reply = `Mensagem recebida! Para informar sobre a NF ${d.nota}, responda:\n*1* — Sim, foi entregue\n*2* — Ainda não foi entregue\n*3* — Houve algum problema`;
  }

  return { reply, updates };
}

/* ── Enviar reply pelo WhatsApp ── */
async function sendReply(jid, text) {
  const EVO_URL = process.env.EVO_URL || "https://evolution-api-production-4f04.up.railway.app";
  const EVO_KEY = process.env.EVO_KEY || "e33b722cda8840b081914391ef5e55bc7ee16d72f85e6559d4ab180073c10d27";
  const EVO_INST = process.env.EVO_INST || "bst-tracking";

  try {
    const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVO_KEY },
      body: JSON.stringify({ number: jid, text }),
    });
    const data = await res.json();
    console.log("Reply enviado:", JSON.stringify(data).substring(0, 100));
  } catch (e) {
    console.error("sendReply error:", e.message);
  }
}

/* ── Endpoint para salvar waPhones do sistema ── */
app.post("/save-phones", async (req, res) => {
  try {
    const { waPhones } = req.body;
    if (!waPhones) return res.status(400).json({ error: "waPhones required" });
    await db.collection("sistema").doc("config").set({ waPhones }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BST Webhook Server rodando na porta ${PORT}`));
