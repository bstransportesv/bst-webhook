/*
  BST Tracking — Webhook Server v4
  - Múltiplas NFs por motorista
  - Reagendamento de entrega
  - Mensagens não reconhecidas → "fale com equipe BST"
  - Áudios ignorados com resposta amigável
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

/* ── Normaliza telefone ── */
function normPhone(tel) {
  if(!tel) return "";
  let d = String(tel).replace(/\D/g, "");
  if(d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if(d.length === 12 && d.startsWith("55")) d = d.slice(2);
  return d;
}

function phoneMatch(a, b) {
  const da = normPhone(a), db2 = normPhone(b);
  if(!da || !db2) return false;
  return da.slice(-8) === db2.slice(-8);
}

/* ── Estados de fluxo por motorista (persistido no Firebase) ── */
const motoristFlow = {};

async function getFlow(motorista) {
  if(motoristFlow[motorista]) return motoristFlow[motorista];
  try {
    const snap = await db.collection("flows").doc(motorista.replace(/[^a-zA-Z0-9]/g,"_")).get();
    if(snap.exists) { motoristFlow[motorista] = snap.data(); return snap.data(); }
  } catch(e) {}
  return { step: "inicio", selectedNfId: null };
}

async function saveFlow(motorista, flow) {
  motoristFlow[motorista] = flow;
  try {
    await db.collection("flows").doc(motorista.replace(/[^a-zA-Z0-9]/g,"_")).set(flow);
  } catch(e) { console.error("saveFlow error:", e.message); }
}

async function clearFlow(motorista) {
  const f = { step: "inicio", selectedNfId: null };
  motoristFlow[motorista] = f;
  try {
    await db.collection("flows").doc(motorista.replace(/[^a-zA-Z0-9]/g,"_")).set(f);
  } catch(e) {}
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "BST Webhook v4", ts: new Date().toISOString() });
});

/* ── Webhook principal ── */
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

    /* Detecta mídia (áudio, imagem, etc) */
    const msg     = data.message || {};
    const isMedia = !!(msg.audioMessage || msg.imageMessage || msg.videoMessage || msg.documentMessage || msg.stickerMessage);
    const text    = msg.conversation
      || (msg.extendedTextMessage && msg.extendedTextMessage.text)
      || (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedDisplayText)
      || (msg.listResponseMessage && msg.listResponseMessage.title)
      || "";

    if(!phone) return;
    if(!text && !isMedia) { console.log("Sem texto/midia, ignorado"); return; }

    console.log(`De ${phone}: "${text}" isMedia:${isMedia}`);

    /* Busca dados */
    const [delSnap, cfgSnap] = await Promise.all([
      db.collection("sistema").doc("deliveries").get(),
      db.collection("sistema").doc("config").get()
    ]);

    if(!delSnap.exists) return;
    let deliveries = delSnap.data().items || [];
    const waPhones = (cfgSnap.exists && cfgSnap.data().waPhones) || {};

    /* Encontra motorista */
    let matchMotorista = null;
    for(const [nome, tel] of Object.entries(waPhones)) {
      if(phoneMatch(tel, phone)) { matchMotorista = nome; break; }
    }
    if(!matchMotorista) {
      const byPhone = deliveries.find(d => d.waPhone && phoneMatch(d.waPhone, phone));
      if(byPhone) matchMotorista = byPhone.motorista;
    }

    if(!matchMotorista) {
      console.log("Motorista não encontrado para:", phone);
      await sendWA(jid, "Olá! Não consegui identificar seu cadastro. Por favor entre em contato com a *Equipe BST Transportes*. 🙏");
      return;
    }

    console.log("Motorista:", matchMotorista);

    /* NFs pendentes do motorista */
    const nfsPendentes = deliveries.filter(d => d.motorista === matchMotorista && !d.dtEntrega);
    const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    /* Estado atual do fluxo (persistido no Firebase) */
    let flow = await getFlow(matchMotorista);
    flow.nfs = nfsPendentes; /* atualiza sempre */

    let reply = "";
    let updatesById = {}; /* { nfId: { campo: valor } } */
    let chatMsgsByNfId = {}; /* { nfId: [msgs] } */

    /* Função para adicionar mensagem no chat de uma NF */
    const addMsg = (nfId, dir, txt) => {
      if(!chatMsgsByNfId[nfId]) chatMsgsByNfId[nfId] = [];
      chatMsgsByNfId[nfId].push({ dir, txt, autor: dir==="in" ? matchMotorista : "Sistema BST", ts: now, auto: true });
    };

    /* ── ÁUDIO OU MÍDIA NÃO RECONHECIDA ── */
    if(isMedia || (!text && isMedia)) {
      reply = `Olá ${matchMotorista.split(" ")[0]}! 👋\n\nRecebi sua mensagem, mas não consigo processar mídia automaticamente.\n\nPor favor responda com texto ou entre em contato com a *Equipe BST Transportes*.`;
      if(flow.selectedNfId) addMsg(flow.selectedNfId, "in", "[Mídia recebida]");
      if(flow.selectedNfId) addMsg(flow.selectedNfId, "out", reply);
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    /* ── INÍCIO ou SEM NF SELECIONADA ── */
    if(flow.step === "inicio" || !flow.selectedNfId) {
      if(nfsPendentes.length === 0) {
        reply = `Olá ${matchMotorista.split(" ")[0]}! Não encontrei entregas pendentes para você no momento. ✅`;
        motoristFlow[matchMotorista] = { step:"inicio", nfs:[], selectedNfId:null };
        await sendWA(jid, reply);
        return;
      }

      if(nfsPendentes.length === 1) {
        /* Só uma NF — vai direto para ela */
        const nf = nfsPendentes[0];
        flow.selectedNfId = nf.id;
        flow.step = "aguardando_status";
        reply = buildNfQuestion(nf, matchMotorista, false);
        addMsg(nf.id, "in", text);
        addMsg(nf.id, "out", reply);
      } else {
        /* Múltiplas NFs — lista todas */
        flow.step = "aguardando_selecao";
        flow.selectedNfId = null;
        reply = `Olá ${matchMotorista.split(" ")[0]}! 👋\n\nVocê tem *${nfsPendentes.length} entregas pendentes*:\n\n`;
        nfsPendentes.forEach((nf, i) => {
          reply += `*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado} | Estab ${nf.estabel}\n`;
        });
        reply += `\nSobre qual entrega você quer informar? Responda com o *número* (1, 2, 3...)\n\nOu responda *TODAS* para informar sobre todas de uma vez.`;

        /* Adiciona msg em todas as NFs */
        nfsPendentes.forEach(nf => {
          addMsg(nf.id, "in", text);
          addMsg(nf.id, "out", reply);
        });
      }
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    /* ── AGUARDANDO SELEÇÃO DE NF ── */
    if(flow.step === "aguardando_selecao") {
      const lower = text.toLowerCase().trim();

      if(lower === "todas" || lower === "all") {
        /* Responde sobre todas as NFs */
        flow.step = "aguardando_status_todas";
        const lista = nfsPendentes.map((nf,i) => `*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado}`).join("\n");
        reply = `Para *todas* as entregas:\n\n${lista}\n\nResponda:\n*1* — Todas entregues ✅\n*2* — Nenhuma foi entregue 📅\n*3* — Informar individualmente`;
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      } else {
        const num = parseInt(text);
        if(!isNaN(num) && num >= 1 && num <= nfsPendentes.length) {
          const nf = nfsPendentes[num-1];
          flow.selectedNfId = nf.id;
          flow.step = "aguardando_status";
          reply = buildNfQuestion(nf, matchMotorista, true);
          addMsg(nf.id, "in", text);
          addMsg(nf.id, "out", reply);
        } else {
          reply = `Por favor responda com um número de *1 a ${nfsPendentes.length}* ou *TODAS*.\n\n`;
          nfsPendentes.forEach((nf,i) => { reply += `*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado}\n`; });
          nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
        }
      }
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    /* ── AGUARDANDO STATUS DE TODAS ── */
    if(flow.step === "aguardando_status_todas") {
      const t = text.trim();
      if(t === "1") {
        flow.step = "aguardando_data_todas";
        reply = `✅ Ótimo! Informe a *data de entrega* para todas as NFs (DD/MM/AAAA):`;
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      } else if(t === "2") {
        flow.step = "aguardando_data_prevista_todas";
        reply = `📅 Qual a *data prevista* para as entregas? (DD/MM/AAAA)`;
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      } else if(t === "3") {
        flow.step = "aguardando_selecao";
        flow.selectedNfId = null;
        const lista = nfsPendentes.map((nf,i) => `*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado}`).join("\n");
        reply = `Ok! Informe o número da entrega:\n\n${lista}`;
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      } else {
        reply = "Responda *1* (todas entregues), *2* (nenhuma entregue) ou *3* (informar individual).";
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      }
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    if(flow.step === "aguardando_data_todas") {
      const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(m) {
        const iso = `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
        nfsPendentes.forEach(nf => {
          updatesById[nf.id] = { dtEntrega: iso };
          addMsg(nf.id, "in", text);
        });
        reply = `✅ Data ${text} registrada para *${nfsPendentes.length} entregas*! Agora informe o *nome e CPF* de quem recebeu as mercadorias:`;
        nfsPendentes.forEach(nf => addMsg(nf.id, "out", reply));
        flow.step = "aguardando_recebedor_todas";
      } else {
        reply = `❌ Data não reconhecida. Informe no formato *DD/MM/AAAA*:`;
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      }
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    if(flow.step === "aguardando_data_prevista_todas") {
      const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(m) {
        nfsPendentes.forEach(nf => {
          updatesById[nf.id] = { dtPrevisao: text };
          addMsg(nf.id, "in", text);
        });
        reply = `📌 Previsão ${text} registrada para todas as entregas! Obrigado ${matchMotorista.split(" ")[0]}! 👍`;
        nfsPendentes.forEach(nf => addMsg(nf.id, "out", reply));
        flow.step = "inicio"; flow.selectedNfId = null;
      } else {
        reply = `❌ Data não reconhecida. Informe no formato *DD/MM/AAAA*:`;
        nfsPendentes.forEach(nf => { addMsg(nf.id, "in", text); addMsg(nf.id, "out", reply); });
      }
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    if(flow.step === "aguardando_recebedor_todas") {
      nfsPendentes.forEach(nf => {
        updatesById[nf.id] = Object.assign(updatesById[nf.id]||{}, { recebedor: text });
        addMsg(nf.id, "in", text);
        addMsg(nf.id, "out", `✅ Todas as entregas registradas com sucesso! Obrigado ${matchMotorista.split(" ")[0]}! 🎉`);
      });
      reply = `✅ *${nfsPendentes.length} entregas* registradas com sucesso! Muito obrigado ${matchMotorista.split(" ")[0]}! 🎉`;
      flow.step = "inicio"; flow.selectedNfId = null;
      await saveFlow(matchMotorista, flow);
      await sendWA(jid, reply);
      await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);
      return;
    }

    /* ── FLUXO DE NF INDIVIDUAL ── */
    const selectedNf = deliveries.find(d => d.id === flow.selectedNfId);
    if(!selectedNf) {
      flow.step = "inicio"; flow.selectedNfId = null;
      await saveFlow(matchMotorista, flow);
      reply = "Ocorreu um erro. Por favor inicie novamente enviando qualquer mensagem.";
      await sendWA(jid, reply);
      return;
    }

    addMsg(selectedNf.id, "in", text);
    const result = processIndividual(selectedNf, text, matchMotorista, flow);
    reply = result.reply;
    if(result.updates) updatesById[selectedNf.id] = result.updates;
    if(result.nextStep) flow.step = result.nextStep;
    if(result.resetFlow) { flow.step = "inicio"; flow.selectedNfId = null; }
    if(result.goToNext && nfsPendentes.length > 1) {
      /* Pergunta sobre próxima NF pendente */
      const remaining = nfsPendentes.filter(d => d.id !== selectedNf.id && !updatesById[d.id]);
      if(remaining.length > 0) {
        const next = remaining[0];
        flow.selectedNfId = next.id;
        flow.step = "aguardando_status";
        const nextQ = `\n\n---\nAgora sobre a *NF ${next.nota}* — ${next.cidade}/${next.estado}:\n\n*1* — Sim, foi entregue ✅\n*2* — Ainda não foi entregue 📅\n*3* — Houve algum problema ⚠️`;
        reply += nextQ;
        addMsg(next.id, "out", reply);
      } else {
        flow.step = "inicio"; flow.selectedNfId = null;
      }
    }
    addMsg(selectedNf.id, "out", result.reply);

    await saveFlow(matchMotorista, flow);
    await sendWA(jid, reply);
    await updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById);

  } catch(e) {
    console.error("Webhook error:", e.message, e.stack ? e.stack.substring(0,300) : "");
  }
});

function buildNfQuestion(nf, motorista, withContext) {
  const nome = motorista.split(" ")[0];
  const ctx = withContext ? `\n\nSobre a *NF ${nf.nota}* | ${nf.cidade}/${nf.estado} | Estab ${nf.estabel}:` : `\n\nOlá ${nome}! 👋\n\nSobre a *NF ${nf.nota}* — ${nf.cidade}/${nf.estado}:`;
  return ctx + `\n\n*1* — Sim, foi entregue ✅\n*2* — Ainda não foi entregue 📅\n*3* — Houve algum problema ⚠️`;
}

function processIndividual(nf, text, motorista, flow) {
  const lower = text.toLowerCase().trim();
  const nome  = motorista.split(" ")[0];
  let reply = "", updates = null, nextStep = null, resetFlow = false, goToNext = false;

  switch(flow.step) {
    case "aguardando_status":
      if(text==="1"||lower.includes("sim")||lower.includes("entregue")||lower.includes("foi")) {
        reply = `✅ Ótimo ${nome}! Por favor informe a *data de entrega* da NF ${nf.nota} no formato DD/MM/AAAA:`;
        nextStep = "aguardando_data";
      } else if(text==="2"||lower.includes("não")||lower.includes("nao")||lower.includes("ainda")) {
        reply = `📅 Qual é a *data prevista* para a entrega da NF ${nf.nota} em ${nf.cidade}/${nf.estado}? (DD/MM/AAAA)`;
        nextStep = "aguardando_data_prevista";
      } else if(text==="3"||lower.includes("problem")||lower.includes("imprevisto")||lower.includes("acidente")) {
        reply = `⚠️ Entendido! Descreva brevemente o problema com a NF ${nf.nota}:`;
        nextStep = "aguardando_problema";
      } else {
        reply = `Por favor responda:\n*1* — Sim, foi entregue ✅\n*2* — Ainda não foi entregue 📅\n*3* — Houve algum problema ⚠️`;
      }
      break;

    case "aguardando_data":
      const m = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(m) {
        const iso = `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
        updates = { dtEntrega: iso };
        reply = `📋 Data ${text} registrada! Informe o *nome completo e CPF* de quem recebeu a mercadoria:`;
        nextStep = "aguardando_recebedor";
      } else {
        reply = `❌ Formato não reconhecido. Informe como *DD/MM/AAAA* (ex: 28/06/2026):`;
      }
      break;

    case "aguardando_data_prevista":
      const mp = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(mp) {
        updates = { dtPrevisao: text };
        reply = `📌 Previsão ${text} registrada para NF ${nf.nota}! Obrigado ${nome}! 👍`;
        goToNext = true; resetFlow = false;
        nextStep = "inicio";
      } else {
        reply = `❌ Formato não reconhecido. Informe como *DD/MM/AAAA*:`;
      }
      break;

    case "aguardando_recebedor":
      updates = { recebedor: text };
      reply = `✅ Entrega da NF ${nf.nota} registrada com sucesso! Obrigado ${nome}! 🎉`;
      goToNext = true;
      nextStep = "inicio";
      break;

    case "aguardando_problema":
      updates = { ocorrencia: text };
      reply = `📋 Ocorrência registrada para NF ${nf.nota}!\n\n_"${text}"_\n\nNossa equipe BST Transportes entrará em contato. Obrigado ${nome}!`;
      goToNext = true;
      nextStep = "inicio";
      break;

    default:
      reply = buildNfQuestion(nf, motorista, true);
      nextStep = "aguardando_status";
  }

  return { reply, updates, nextStep, resetFlow, goToNext };
}

async function updateFirebase(deliveries, delSnap, chatMsgsByNfId, updatesById) {
  try {
    let changed = false;
    let items = deliveries.map(d => {
      let updated = Object.assign({}, d);
      if(chatMsgsByNfId[d.id] && chatMsgsByNfId[d.id].length > 0) {
        updated.chatMsgs = [...(d.chatMsgs || []), ...chatMsgsByNfId[d.id]];
        changed = true;
      }
      if(updatesById[d.id]) {
        Object.assign(updated, updatesById[d.id]);
        changed = true;
      }
      return updated;
    });

    if(changed) {
      await db.collection("sistema").doc("deliveries").set(
        { items, nextId: delSnap.data().nextId },
        { merge: true }
      );
      console.log("Firebase atualizado OK");
    }
  } catch(e) {
    console.error("updateFirebase error:", e.message);
  }
}

async function sendWA(jid, text) {
  try {
    const res = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": EVO_INST_TOKEN },
      body: JSON.stringify({ number: jid, text })
    });
    const data = await res.json();
    console.log("WA enviado:", res.status);
    if(!res.ok) console.error("WA erro:", JSON.stringify(data).substring(0,150));
  } catch(e) {
    console.error("sendWA error:", e.message);
  }
}

app.post("/save-phones", async (req, res) => {
  try {
    const { waPhones } = req.body;
    if(!waPhones) return res.status(400).json({ error: "waPhones required" });
    console.log("Salvando phones:", JSON.stringify(waPhones));
    await db.collection("sistema").doc("config").set({ waPhones }, { merge: true });
    res.json({ ok: true, saved: Object.keys(waPhones).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/save-delivery-phone", async (req, res) => {
  try {
    const { motorista, phone } = req.body;
    if(!motorista || !phone) return res.status(400).json({ error: "motorista e phone obrigatorios" });
    console.log("Salvando phone para motorista:", motorista, phone);

    const delSnap = await db.collection("sistema").doc("deliveries").get();
    let items = delSnap.exists ? (delSnap.data().items || []) : [];
    items = items.map(d => d.motorista === motorista ? Object.assign({}, d, { waPhone: phone }) : d);

    await db.collection("sistema").doc("deliveries").set(
      { items, nextId: delSnap.exists ? delSnap.data().nextId : 0 },
      { merge: true }
    );

    /* Salva no waPhones do config */
    const cfgUpdate = {};
    cfgUpdate[`waPhones.${motorista}`] = phone;
    await db.collection("sistema").doc("config").set(cfgUpdate, { merge: true });

    console.log("Phone salvo OK:", motorista, phone);
    res.json({ ok: true });
  } catch(e) {
    console.error("save-delivery-phone:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BST Webhook Server v4 rodando na porta ${PORT}`));
