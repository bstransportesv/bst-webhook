/*
  BST Tracking — Webhook Server v5
  Fluxo simples, robusto e com estado persistido no Firebase
*/
const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
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
  console.log("Firebase OK");
} catch(e) { console.error("Firebase erro:", e.message); }

const EVO_URL        = process.env.EVO_URL        || "https://evolution-api-production-4f04.up.railway.app";
const EVO_INST       = process.env.EVO_INST       || "bst-tracking";
const EVO_INST_TOKEN = process.env.EVO_INST_TOKEN || "C77DA501-AB7A-4A8F-A0D7-97B0837D21DB";

/* ── Helpers ── */
function normPhone(tel) {
  let d = String(tel||"").replace(/\D/g,"");
  if(d.length===13&&d.startsWith("55")) d=d.slice(2);
  if(d.length===12&&d.startsWith("55")) d=d.slice(2);
  return d;
}
function phoneMatch(a,b){ const da=normPhone(a),db=normPhone(b); return da&&db&&da.slice(-8)===db.slice(-8); }

function extractText(msg) {
  if(!msg) return "";
  return msg.conversation
    ||(msg.extendedTextMessage&&msg.extendedTextMessage.text)
    ||(msg.buttonsResponseMessage&&msg.buttonsResponseMessage.selectedDisplayText)
    ||(msg.listResponseMessage&&msg.listResponseMessage.title)
    ||"";
}

async function getDeliveries() {
  const snap = await db.collection("sistema").doc("deliveries").get();
  return snap.exists ? (snap.data().items||[]) : [];
}

async function saveDeliveries(items) {
  await db.collection("sistema").doc("deliveries").set({ items }, { merge: true });
}

async function getConfig() {
  const snap = await db.collection("sistema").doc("config").get();
  return snap.exists ? snap.data() : {};
}

async function getFlow(key) {
  try {
    const snap = await db.collection("flows").doc(key).get();
    return snap.exists ? snap.data() : { step:"inicio", nfIdx:0, selectedNfId:null };
  } catch(e) { return { step:"inicio", nfIdx:0, selectedNfId:null }; }
}

async function setFlow(key, data) {
  try { await db.collection("flows").doc(key).set(data); } catch(e) {}
}

async function resetFlow(key) {
  try { await db.collection("flows").doc(key).set({ step:"inicio", nfIdx:0, selectedNfId:null }); } catch(e) {}
}

async function sendWA(jid, text) {
  try {
    const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INST}`,{
      method:"POST",
      headers:{"Content-Type":"application/json","apikey":EVO_INST_TOKEN},
      body:JSON.stringify({number:jid,text})
    });
    console.log("WA sent:", r.status);
  } catch(e) { console.error("sendWA:", e.message); }
}

async function addChatMsg(deliveries, nfId, dir, txt, autor, ts) {
  return deliveries.map(d => {
    if(d.id !== nfId) return d;
    const msgs = [...(d.chatMsgs||[]), {dir,txt,autor,ts,auto:true}];
    return {...d, chatMsgs:msgs};
  });
}

/* ── Health check ── */
app.get("/", (req,res)=>res.json({status:"ok",service:"BST v5",ts:new Date().toISOString()}));

/* ── Webhook ── */
app.post("/webhook", async (req,res) => {
  res.sendStatus(200);
  try {
    const {event, data={}} = req.body;
    if(!event) return;
    console.log("EVENT:", event);
    if(!event.includes("MESSAGES_UPSERT")&&!event.includes("message")) return;

    const key = data.key||{};
    if(key.fromMe) return;

    const jid   = key.remoteJid||"";
    const phone = normPhone(jid.replace(/@s\.whatsapp\.net|@c\.us/g,""));
    const msg   = data.message||{};
    const isMedia = !!(msg.audioMessage||msg.imageMessage||msg.videoMessage||msg.documentMessage||msg.stickerMessage);
    const text  = extractText(msg).trim();

    if(!phone) return;
    if(!text && !isMedia) return;

    console.log(`De ${phone}: "${text}" media:${isMedia}`);

    /* Identifica motorista */
    const [deliveries, cfg] = await Promise.all([getDeliveries(), getConfig()]);
    const waPhones = cfg.waPhones||{};

    let motorista = null;
    for(const [nome,tel] of Object.entries(waPhones)) {
      if(phoneMatch(tel,phone)){ motorista=nome; break; }
    }
    if(!motorista) {
      const d = deliveries.find(d=>d.waPhone&&phoneMatch(d.waPhone,phone));
      if(d) motorista=d.motorista;
    }

    if(!motorista) {
      console.log("Motorista não encontrado:", phone);
      await sendWA(jid, "Olá! Não encontrei seu cadastro.\nPor favor entre em contato com a *Equipe BST Transportes*. 🙏");
      return;
    }

    const ts    = new Date().toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"});
    const nome  = motorista.split(" ")[0];
    const flowKey = motorista.replace(/[^a-zA-Z0-9]/g,"_");
    const flow  = await getFlow(flowKey);

    /* NFs pendentes do motorista */
    const nfsPend = deliveries.filter(d=>d.motorista===motorista&&!d.dtEntrega);

    let reply="";
    let updDels = deliveries;

    /* ── MÍDIA ── */
    if(isMedia) {
      reply=`Recebi uma mídia, mas não consigo processá-la automaticamente.\n\nPara informar sobre suas entregas, responda com texto.\nDúvidas? Fale com a *Equipe BST Transportes*. 🙏`;
      if(flow.selectedNfId) {
        updDels = await addChatMsg(updDels, flow.selectedNfId, "in", "[Mídia]", motorista, ts);
        updDels = await addChatMsg(updDels, flow.selectedNfId, "out", reply, "Sistema BST", ts);
      }
      await saveDeliveries(updDels);
      await sendWA(jid, reply);
      return;
    }

    /* ── SEM NFs PENDENTES ── */
    if(nfsPend.length===0) {
      reply=`Olá ${nome}! ✅\nNão há entregas pendentes para você no momento.`;
      await resetFlow(flowKey);
      await sendWA(jid, reply);
      return;
    }

    /* ── ETAPA: INICIO ou SELEÇÃO ── */
    if(flow.step==="inicio"||flow.step==="aguardando_selecao") {
      if(nfsPend.length===1) {
        /* Uma NF — vai direto */
        const nf=nfsPend[0];
        const newFlow={step:"aguardando_status",nfIdx:0,selectedNfId:nf.id};
        await setFlow(flowKey,newFlow);
        reply=`Olá ${nome}! 👋\n\nSobre a *NF ${nf.nota}* — ${nf.cidade}/${nf.estado}:\n\n*1* — Sim, foi entregue ✅\n*2* — Ainda não foi entregue 📅\n*3* — Houve um problema ⚠️`;
        updDels = await addChatMsg(updDels, nf.id, "in", text, motorista, ts);
        updDels = await addChatMsg(updDels, nf.id, "out", reply, "Sistema BST", ts);
      } else {
        /* Várias NFs */
        const num = parseInt(text);
        const lower = text.toLowerCase();

        /* Se já escolheu um número válido */
        if(!isNaN(num) && num>=1 && num<=nfsPend.length) {
          const nf=nfsPend[num-1];
          const newFlow={step:"aguardando_status",nfIdx:num-1,selectedNfId:nf.id};
          await setFlow(flowKey,newFlow);
          reply=`Ok! Sobre a *NF ${nf.nota}* — ${nf.cidade}/${nf.estado}:\n\n*1* — Sim, foi entregue ✅\n*2* — Ainda não foi entregue 📅\n*3* — Houve um problema ⚠️`;
          updDels = await addChatMsg(updDels, nf.id, "in", text, motorista, ts);
          updDels = await addChatMsg(updDels, nf.id, "out", reply, "Sistema BST", ts);
        } else if(lower==="todas"||lower==="all") {
          const newFlow={step:"aguardando_status_todas",nfIdx:0,selectedNfId:null};
          await setFlow(flowKey,newFlow);
          const lista=nfsPend.map((nf,i)=>`*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado}`).join("\n");
          reply=`Ok ${nome}! Para *todas* as entregas:\n\n${lista}\n\nElas foram entregues?\n*1* — Sim, todas ✅\n*2* — Não, nenhuma 📅\n*3* — Informar individualmente`;
          nfsPend.forEach(async nf => { updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts); });
          nfsPend.forEach(async nf => { updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts); });
        } else {
          /* Mostra lista */
          const newFlow={step:"aguardando_selecao",nfIdx:0,selectedNfId:null};
          await setFlow(flowKey,newFlow);
          const lista=nfsPend.map((nf,i)=>`*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado}`).join("\n");
          reply=`Olá ${nome}! 👋\n\nVocê tem *${nfsPend.length} entregas pendentes*:\n\n${lista}\n\nSobre qual você quer informar?\nDigite o *número* (1 a ${nfsPend.length}) ou *TODAS*.`;
          nfsPend.forEach(async nf => { updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts); });
          nfsPend.forEach(async nf => { updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts); });
        }
      }
      await saveDeliveries(updDels);
      await sendWA(jid, reply);
      return;
    }

    /* ── ETAPA: AGUARDANDO STATUS (NF individual) ── */
    if(flow.step==="aguardando_status") {
      const nf=deliveries.find(d=>d.id===flow.selectedNfId);
      if(!nf){ await resetFlow(flowKey); return; }
      const lower=text.toLowerCase();
      updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts);

      if(text==="1"||lower.includes("sim")||lower.includes("entregue")||lower.includes("foi")) {
        await setFlow(flowKey,{...flow,step:"aguardando_data"});
        reply=`✅ Ótimo ${nome}!\nInforme a *data de entrega* da NF ${nf.nota} no formato *DD/MM/AAAA*:`;
      } else if(text==="2"||lower.includes("não")||lower.includes("nao")||lower.includes("ainda")) {
        await setFlow(flowKey,{...flow,step:"aguardando_previsao"});
        reply=`📅 Entendido ${nome}.\nQual a *data prevista* para a NF ${nf.nota} em ${nf.cidade}/${nf.estado}?\nFormato: *DD/MM/AAAA*`;
      } else if(text==="3"||lower.includes("problem")||lower.includes("imprevisto")) {
        await setFlow(flowKey,{...flow,step:"aguardando_problema"});
        reply=`⚠️ Descreva brevemente o problema com a NF ${nf.nota}:`;
      } else {
        reply=`Por favor responda:\n*1* — Entregue ✅\n*2* — Não entregue 📅\n*3* — Problema ⚠️`;
      }
      updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    /* ── ETAPA: AGUARDANDO DATA ── */
    if(flow.step==="aguardando_data") {
      const nf=deliveries.find(d=>d.id===flow.selectedNfId);
      if(!nf){ await resetFlow(flowKey); return; }
      const m=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts);
      if(m) {
        const iso=`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
        updDels=updDels.map(d=>d.id===nf.id?{...d,dtEntrega:iso}:d);
        await setFlow(flowKey,{...flow,step:"aguardando_recebedor"});
        reply=`📋 Data *${text}* registrada!\nAgora informe o *nome completo e CPF* de quem recebeu:`;
      } else {
        reply=`❌ Data não reconhecida.\nInforme no formato *DD/MM/AAAA* (ex: 30/06/2026):`;
      }
      updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    /* ── ETAPA: AGUARDANDO PREVISÃO ── */
    if(flow.step==="aguardando_previsao") {
      const nf=deliveries.find(d=>d.id===flow.selectedNfId);
      if(!nf){ await resetFlow(flowKey); return; }
      updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts);
      const m=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(m) {
        updDels=updDels.map(d=>d.id===nf.id?{...d,dtPrevisao:text}:d);
        reply=`📌 Previsão *${text}* registrada para NF ${nf.nota}!\nObrigado ${nome}! 👍`;
        /* Marca esta NF como processada nesta sessão */
        const processadas = [...(flow.processadas||[]), nf.id];
        /* Vai para próxima NF pendente que ainda não foi processada */
        const proximas=nfsPend.filter(d=>!processadas.includes(d.id));
        if(proximas.length>0) {
          const prox=proximas[0];
          await setFlow(flowKey,{step:"aguardando_status",nfIdx:flow.nfIdx+1,selectedNfId:prox.id,processadas});
          reply+=`\n\n---\nSobre a *NF ${prox.nota}* — ${prox.cidade}/${prox.estado}:\n\n*1* — Entregue ✅\n*2* — Não entregue 📅\n*3* — Problema ⚠️`;
          updDels=await addChatMsg(updDels,prox.id,"out",reply,"Sistema BST",ts);
        } else {
          reply+=`\n\n🎉 Todas as suas entregas pendentes foram informadas. Obrigado!`;
          await resetFlow(flowKey);
        }
      } else {
        reply=`❌ Data não reconhecida.\nInforme no formato *DD/MM/AAAA* (ex: 30/06/2026):`;
      }
      updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    /* ── ETAPA: AGUARDANDO RECEBEDOR ── */
    if(flow.step==="aguardando_recebedor") {
      const nf=deliveries.find(d=>d.id===flow.selectedNfId);
      if(!nf){ await resetFlow(flowKey); return; }
      updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts);
      updDels=updDels.map(d=>d.id===nf.id?{...d,recebedor:text}:d);
      reply=`✅ Entrega da NF ${nf.nota} registrada!\nObrigado ${nome}! 🎉`;
      /* Marca esta NF como processada (já tem dtEntrega agora) */
      const processadas = [...(flow.processadas||[]), nf.id];
      const proximas=nfsPend.filter(d=>!processadas.includes(d.id));
      if(proximas.length>0) {
        const prox=proximas[0];
        await setFlow(flowKey,{step:"aguardando_status",nfIdx:flow.nfIdx+1,selectedNfId:prox.id,processadas});
        reply+=`\n\n---\nSobre a *NF ${prox.nota}* — ${prox.cidade}/${prox.estado}:\n\n*1* — Entregue ✅\n*2* — Não entregue 📅\n*3* — Problema ⚠️`;
        updDels=await addChatMsg(updDels,prox.id,"out",reply,"Sistema BST",ts);
      } else {
        reply+=`\n\n🎉 Todas as suas entregas pendentes foram informadas. Obrigado!`;
        await resetFlow(flowKey);
      }
      updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    /* ── ETAPA: AGUARDANDO PROBLEMA ── */
    if(flow.step==="aguardando_problema") {
      const nf=deliveries.find(d=>d.id===flow.selectedNfId);
      if(!nf){ await resetFlow(flowKey); return; }
      updDels=await addChatMsg(updDels,nf.id,"in",text,motorista,ts);
      updDels=updDels.map(d=>d.id===nf.id?{...d,ocorrencia:text}:d);
      reply=`📋 Ocorrência registrada para NF ${nf.nota}.\nNossa *Equipe BST Transportes* entrará em contato. Obrigado!`;
      const processadas = [...(flow.processadas||[]), nf.id];
      const proximas=nfsPend.filter(d=>!processadas.includes(d.id));
      if(proximas.length>0) {
        const prox=proximas[0];
        await setFlow(flowKey,{step:"aguardando_status",nfIdx:flow.nfIdx+1,selectedNfId:prox.id,processadas});
        reply+=`\n\n---\nSobre a *NF ${prox.nota}* — ${prox.cidade}/${prox.estado}:\n\n*1* — Entregue ✅\n*2* — Não entregue 📅\n*3* — Problema ⚠️`;
        updDels=await addChatMsg(updDels,prox.id,"out",reply,"Sistema BST",ts);
      } else {
        reply+=`\n\n🎉 Todas as suas entregas pendentes foram informadas. Obrigado!`;
        await resetFlow(flowKey);
      }
      updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    /* ── ETAPA: TODAS AS NFs ── */
    if(flow.step==="aguardando_status_todas") {
      updDels=nfsPend.reduce(async(acc,nf)=>addChatMsg(await acc,nf.id,"in",text,motorista,ts), Promise.resolve(updDels));
      updDels=await updDels;
      if(text==="1") {
        await setFlow(flowKey,{...flow,step:"aguardando_data_todas"});
        reply=`✅ Ótimo!\nInforme a *data de entrega* de todas no formato *DD/MM/AAAA*:`;
      } else if(text==="2") {
        await setFlow(flowKey,{...flow,step:"aguardando_previsao_todas"});
        reply=`📅 Qual a *data prevista* para as entregas? (*DD/MM/AAAA*)`;
      } else if(text==="3") {
        await setFlow(flowKey,{step:"aguardando_selecao",nfIdx:0,selectedNfId:null});
        const lista=nfsPend.map((nf,i)=>`*${i+1}* — NF ${nf.nota} | ${nf.cidade}/${nf.estado}`).join("\n");
        reply=`Ok! Sobre qual entrega você quer informar?\n\n${lista}`;
      } else {
        reply=`Responda:\n*1* — Todas entregues ✅\n*2* — Nenhuma entregue 📅\n*3* — Informar individual`;
      }
      for(const nf of nfsPend) updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    if(flow.step==="aguardando_data_todas") {
      const m=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(m) {
        const iso=`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
        updDels=updDels.map(d=>nfsPend.find(n=>n.id===d.id)?{...d,dtEntrega:iso}:d);
        await setFlow(flowKey,{...flow,step:"aguardando_recebedor_todas"});
        reply=`📋 Data *${text}* registrada para todas!\nInforme o *nome e CPF* de quem recebeu:`;
      } else {
        reply=`❌ Data inválida. Use o formato *DD/MM/AAAA*:`;
      }
      for(const nf of nfsPend) updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    if(flow.step==="aguardando_previsao_todas") {
      const m=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if(m) {
        updDels=updDels.map(d=>nfsPend.find(n=>n.id===d.id)?{...d,dtPrevisao:text}:d);
        await resetFlow(flowKey);
        reply=`📌 Previsão *${text}* registrada para todas as entregas!\nObrigado ${nome}! 👍`;
      } else {
        reply=`❌ Data inválida. Use o formato *DD/MM/AAAA*:`;
      }
      for(const nf of nfsPend) updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    if(flow.step==="aguardando_recebedor_todas") {
      updDels=updDels.map(d=>nfsPend.find(n=>n.id===d.id)?{...d,recebedor:text}:d);
      await resetFlow(flowKey);
      reply=`✅ *${nfsPend.length} entregas* registradas com sucesso!\nMuito obrigado ${nome}! 🎉`;
      for(const nf of nfsPend) updDels=await addChatMsg(updDels,nf.id,"out",reply,"Sistema BST",ts);
      await saveDeliveries(updDels);
      await sendWA(jid,reply);
      return;
    }

    /* Fallback */
    await resetFlow(flowKey);
    await sendWA(jid,`Olá ${nome}! Envie qualquer mensagem para começar.`);

  } catch(e) { console.error("Webhook error:", e.message, e.stack?.substring(0,200)); }
});

/* ── Save phones ── */
app.post("/save-phones", async (req,res) => {
  try {
    const {waPhones}=req.body;
    if(!waPhones) return res.status(400).json({error:"waPhones required"});
    await db.collection("sistema").doc("config").set({waPhones},{merge:true});
    console.log("Phones saved:", Object.keys(waPhones).length);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/save-delivery-phone", async (req,res) => {
  try {
    const {motorista,phone}=req.body;
    if(!motorista||!phone) return res.status(400).json({error:"missing fields"});
    const snap=await db.collection("sistema").doc("deliveries").get();
    let items=snap.exists?(snap.data().items||[]):[];
    items=items.map(d=>d.motorista===motorista?{...d,waPhone:phone}:d);
    await db.collection("sistema").doc("deliveries").set({items,nextId:snap.data()?.nextId||0},{merge:true});
    const upd={};upd[`waPhones.${motorista}`]=phone;
    await db.collection("sistema").doc("config").set(upd,{merge:true});
    console.log("Delivery phone saved:", motorista, phone);
    res.json({ok:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`BST Webhook v5 porta ${PORT}`));
