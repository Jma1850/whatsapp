/* ──────────────────────────────────────────────────────────────────────
   TuCanChat server.js   –   WhatsApp voice ↔ text translator bot
   ────────────────────────────────────────────────────────────────────
   • Five-language onboard wizard      • Whisper-v3 + GPT-4o-mini
   • Google-TTS voices (en-US pref.)   • 3-part voice-note reply
   • Stripe pay-wall after 5 uses      • Supabase logging + bucket heal
   • “reset” is ALWAYS English         • Localised UI prompts
────────────────────────────────────────────────────────────────────── */
import express    from "express";
import bodyParser from "body-parser";
import fetch      from "node-fetch";
import ffmpeg     from "fluent-ffmpeg";
import fs         from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI     from "openai";
import Stripe     from "stripe";
import twilio     from "twilio";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config();

/* ── crash guard ───────────────────────────────────────────────────── */
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

/* ── ENV ───────────────────────────────────────────────────────────── */
const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  PRICE_MONTHLY, PRICE_ANNUAL, PRICE_LIFE,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
  PORT = 8080
} = process.env;

const WHATSAPP_FROM =
  TWILIO_PHONE_NUMBER.startsWith("whatsapp:")
    ? TWILIO_PHONE_NUMBER
    : `whatsapp:${TWILIO_PHONE_NUMBER}`;

/* ── clients ───────────────────────────────────────────────────────── */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe   = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ── express ───────────────────────────────────────────────────────── */
const app = express();                     // will add parsers later

/* ====================================================================
   0️⃣  STATIC LANGUAGE INFO
==================================================================== */
const MENU = {
  1: { name:"English",    code:"en" },
  2: { name:"Spanish",    code:"es" },
  3: { name:"French",     code:"fr" },
  4: { name:"Portuguese", code:"pt" },
  5: { name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const pickLang = txt => {
  const m = txt.trim(), d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(
    o => o.code === lc || o.name.toLowerCase() === lc
  );
};
/* very small UI-string dictionary */
const L = {
  en: {
    how:
`📌 How TuCanChat works
• Send any voice note or text.
• I instantly deliver:
  1. Heard: your exact words
  2. Translation
  3. Audio reply in your language
• Type “reset” anytime to switch languages.`,
    askReceive : "🌎 What language do you RECEIVE messages in?",
    askGender  : "🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female",
    setupDone  : "✅ Setup complete!  Send a voice-note or text."
  },
  es: {
    how:
`📌 Cómo funciona TuCanChat
• Envía una nota de voz o texto.
• Yo te devuelvo al instante:
  1. Oído: tus palabras exactas
  2. Traducción
  3. Audio en tu idioma
• Escribe “reset” para cambiar de idioma.`,
    askReceive : "🌎 ¿En qué idioma RECIBES los mensajes?",
    askGender  : "🔊 Género de voz:\n1️⃣ Masculino\n2️⃣ Femenino",
    setupDone  : "✅ ¡Listo! Envía una nota de voz o texto."
  },
  fr: {
    how:
`📌 Comment fonctionne TuCanChat
• Envoie une note vocale ou un texte.
• Je réponds aussitôt :
  1. Entendu : tes mots exacts
  2. Traduction
  3. Audio dans ta langue
• Tape “reset” pour changer de langue.`,
    askReceive : "🌎 Quelle langue pour RECEVOIR les messages ?",
    askGender  : "🔊 Voix :\n1️⃣ Homme\n2️⃣ Femme",
    setupDone  : "✅ Configuration terminée ! Envoie un message vocal ou texte."
  },
  pt: {
    how:
`📌 Como o TuCanChat funciona
• Envie qualquer áudio ou texto.
• Eu retorno na hora:
  1. Ouvi: suas palavras exatas
  2. Tradução
  3. Áudio no seu idioma
• Digite “reset” para mudar de idioma.`,
    askReceive : "🌎 Em que idioma você RECEBE mensagens?",
    askGender  : "🔊 Gênero da voz:\n1️⃣ Masculino\n2️⃣ Feminino",
    setupDone  : "✅ Pronto! Envie um áudio ou texto."
  },
  de: {
    how:
`📌 So funktioniert TuCanChat
• Sende eine Sprachnachricht oder Text.
• Ich liefere sofort:
  1. Gehört: deine Worte
  2. Übersetzung
  3. Audio in deiner Sprache
• Tippe “reset”, um die Sprache zu wechseln.`,
    askReceive : "🌎 In welcher Sprache ERHÄLTST du Nachrichten?",
    askGender  : "🔊 Stimmgeschlecht:\n1️⃣ Männlich\n2️⃣ Weiblich",
    setupDone  : "✅ Fertig! Sende eine Sprachnachricht oder Text."
  }
};
const t = (key, lang) => (L[lang] ?? L.en)[key];

/* helper that prints the numeric language menu in the UI language */
const buildMenu = lang =>
  DIGITS.map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");

/* initial welcome (always English to guarantee emoji order) */
const WELCOME =
`👋 Welcome to TuCanChat!  Please choose your language:\n\n${buildMenu("en")}`;

/* pay-wall message stays English (short & clear) */
const PAYWALL =
`⚠️ You’ve used your 5 free translations.

1️⃣ Monthly  $4.99
2️⃣ Annual   $49.99
3️⃣ Lifetime $199`;

/* ====================================================================
   1️⃣  STRIPE WEBHOOK  (raw body first)
==================================================================== */
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type:"application/json" }),
  async (req,res) => {
    let event;
    try{
      event = stripe.webhooks.constructEvent(
        req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET
      );
    }catch(e){ console.error("stripe sig err",e.message); return res.sendStatus(400); }

    if(event.type==="checkout.session.completed"){
      const s=event.data.object;
      const plan = s.metadata.tier==="monthly"?"MONTHLY"
                 :s.metadata.tier==="annual" ?"ANNUAL":"LIFETIME";

      const upd = await supabase.from("users")
        .update({ plan, free_used:0, stripe_sub_id:s.subscription })
        .eq("stripe_cust_id", s.customer);

      if(upd.data?.length===0){
        await supabase.from("users").update({
          plan, free_used:0, stripe_cust_id:s.customer, stripe_sub_id:s.subscription
        }).eq("id", s.metadata.uid);
      }
    }
    if(event.type==="customer.subscription.deleted"){
      const sub=event.data.object;
      await supabase.from("users").update({plan:"FREE"}).eq("stripe_sub_id",sub.id);
    }
    res.json({received:true});
  }
);

/* ====================================================================
   2️⃣  CONSTANTS / TEXT  (menus, i18n)
==================================================================== */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuList = () =>
  DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");

const MENU_PROMPT = `👋 Welcome to TuCanChat!  Please choose your language:\n\n${menuList()}`;

const HOW_WORKS = {
  en:`📌 How TuCanChat works
• Send any voice note or text.
• I instantly deliver:
 1. Heard: your exact words
 2. Translation
 3. Audio reply in your language
• Type “reset” anytime to switch languages.

When it shines: quick travel chats, decoding a doctor or lawyer, serving global customers, or brushing up on a new language—without ever leaving WhatsApp.`,
  es:`📌 Cómo funciona TuCanChat
• Envía una nota de voz o texto.
• Yo entrego al instante:
 1. Escuchado: tus palabras exactas
 2. Traducción
 3. Audio en tu idioma
• Escribe “reset” en cualquier momento para cambiar de idioma.

Ideal para: viajes, entender mensajes médicos o legales, atender clientes globales o practicar un idioma sin salir de WhatsApp.`,
  fr:`📌 Comment fonctionne TuCanChat
• Envoie un message vocal ou texte.
• Je réponds instantanément :
 1. Entendu : tes mots exacts
 2. Traduction
 3. Audio dans ta langue
• Tape “reset” à tout moment pour changer de langue.

Parfait pour voyager, comprendre médecins/avocats, servir des clients mondiaux ou apprendre une langue sans quitter WhatsApp.`,
  pt:`📌 Como o TuCanChat funciona
• Envie qualquer áudio ou texto.
• Eu entrego instantaneamente:
 1. Ouvido: suas palavras
 2. Tradução
 3. Áudio no seu idioma
• Digite “reset” a qualquer momento para trocar de idioma.

Ótimo para viagens, entender médicos ou advogados, atender clientes globais ou praticar um novo idioma sem sair do WhatsApp.`,
  de:`📌 So funktioniert TuCanChat
• Sende eine Sprachnachricht oder Text.
• Ich liefere sofort:
 1. Gehört: deine Worte
 2. Übersetzung
 3. Audio in deiner Sprache
• Tippe jederzeit “reset”, um die Sprache zu wechseln.

Perfekt für Reisen, Arzt- oder Anwaltstexte, weltweiten Kundensupport oder Sprachtraining – alles in WhatsApp.`
};

const UI = {
  en:{ pickReceive:`🌎 What language do you RECEIVE messages in?`,
       voice:`🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female`,
       setupDone:`✅ Setup complete!  Send a voice-note or text.`,
       targetDiff:`⚠️ Target must differ.`, badReply:`❌ Reply 1-5.`},
  es:{ pickReceive:`🌎 ¿En qué idioma RECIBES mensajes?`,
       voice:`🔊 ¿Género de voz?\n1️⃣ Masculino\n2️⃣ Femenino`,
       setupDone:`✅ Configuración lista.  Envía audio o texto.`,
       targetDiff:`⚠️ El idioma destino debe ser distinto.`, badReply:`❌ Responde 1-5.`},
  fr:{ pickReceive:`🌎 Dans quelle langue RECEVEZ-vous les messages ?`,
       voice:`🔊 Genre de voix ?\n1️⃣ Homme\n2️⃣ Femme`,
       setupDone:`✅ Configuration terminée ! Envoie un vocal ou un texte.`,
       targetDiff:`⚠️ La langue cible doit être différente.`, badReply:`❌ Réponds 1-5.`},
  pt:{ pickReceive:`🌎 Em que idioma você RECEBE mensagens?`,
       voice:`🔊 Gênero de voz?\n1️⃣ Masculino\n2️⃣ Feminino`,
       setupDone:`✅ Configuração pronta! Envie áudio ou texto.`,
       targetDiff:`⚠️ Idioma de destino deve ser diferente.`, badReply:`❌ Responda 1-5.`},
  de:{ pickReceive:`🌎 In welcher Sprache ERHÄLTST du Nachrichten?`,
       voice:`🔊 Stimmgeschlecht?\n1️⃣ Männlich\n2️⃣ Weiblich`,
       setupDone:`✅ Einrichtung abgeschlossen!  Sende eine Sprachnachricht oder Text.`,
       targetDiff:`⚠️ Zielsprache muss abweichen.`, badReply:`❌ Antworte 1-5.`}
};

const PAYWALL = {
  en:`⚠️ You’ve used your 5 free translations.\n\nChoose a plan:\n1️⃣ Monthly  $4.99\n2️⃣ Annual   $49.99\n3️⃣ Lifetime $199`,
  es:`⚠️ Has usado tus 5 traducciones gratis.\n\nElige un plan:\n1️⃣ Mensual  $4.99\n2️⃣ Anual    $49.99\n3️⃣ De por vida $199`,
  fr:`⚠️ Vous avez utilisé vos 5 traductions gratuites.\n\nChoisissez :\n1️⃣ Mensuel  4,99 $\n2️⃣ Annuel   49,99 $\n3️⃣ À vie    199 $`,
  pt:`⚠️ Você usou suas 5 traduções grátis.\n\nEscolha um plano:\n1️⃣ Mensal   $4.99\n2️⃣ Anual    $49.99\n3️⃣ Vitalício $199`,
  de:`⚠️ Du hast deine 5 kostenlosen Übersetzungen verbraucht.\n\nWähle einen Plan:\n1️⃣ Monatlich  $4,99\n2️⃣ Jährlich   $49,99\n3️⃣ Lebenslang $199`
};

/* ====================================================================
   3️⃣  AUDIO & AI HELPERS
==================================================================== */
const toWav = (i,o)=>new Promise((res,rej)=>
  ffmpeg(i).audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",rej).on("end",()=>res(o))
    .save(o)
);
async function whisper(wav){
  try{
    const r = await openai.audio.transcriptions.create({
      model:"whisper-large-v3",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }catch{
    const r = await openai.audio.transcriptions.create({
      model:"whisper-1",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }
}
const detectLang = async q =>
  (await fetch(
    `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q})}
  ).then(r=>r.json())).data.detections[0][0].language;
async function translate(text,target){
  const r=await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      {role:"system",content:`Translate to ${target}. Return ONLY the translation.`},
      {role:"user",  content:text}
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

let voiceCache=null;
async function loadVoices(){
  if(voiceCache)return;
  const {voices}=await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r=>r.json());
  voiceCache=voices.reduce((m,v)=>{
    v.languageCodes.forEach(full=>{
      const code=full.split("-",1)[0];
      (m[code]||=[]).push(v);
    });
    return m;
  },{});
}
(async()=>{try{await loadVoices();console.log("🔊 voice cache ready");}catch{}})();
async function pickVoice(lang,gender){
  await loadVoices();
  let list=(voiceCache[lang]||[]).filter(v=>v.ssmlGender===gender);
  if(!list.length) list=voiceCache[lang]||[];
  if(lang==="en"){
    const us=list.filter(v=>v.name.startsWith("en-US"));
    if(us.length) list=us;
  }
  return (
    list.find(v=>v.name.includes("Neural2"))||
    list.find(v=>v.name.includes("WaveNet"))||
    list.find(v=>v.name.includes("Standard"))||
    {name:"en-US-Standard-A"}
  ).name;
}
async function tts(text,lang,gender){
  const synth=async name=>{
    const lc=name.split("-",2).join("-");
    const r=await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          input:{text},
          voice:{languageCode:lc,name},
          audioConfig:{audioEncoding:"MP3",speakingRate:0.9}
        })
      }
    ).then(r=>r.json());
    return r.audioContent?Buffer.from(r.audioContent,"base64"):null;
  };
  let buf=await synth(await pickVoice(lang,gender)); if(buf)return buf;
  buf=await synth(lang);               if(buf)return buf;
  buf=await synth("en-US-Standard-A"); if(buf)return buf;
  throw new Error("TTS failed");
}

/* Storage bucket (self-healing) */
async function ensureBucket(){
  const { error } = await supabase.storage.createBucket("tts-voices",{ public:true });
  if(error && error.code!=="PGRST116") throw error;
}
async function uploadAudio(buffer){
  const fn=`tts_${uuid()}.mp3`;

  let up=await supabase
    .storage.from("tts-voices")
    .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});

  if(up.error && /Bucket not found/i.test(up.error.message)){
    console.warn("⚠️ Bucket missing → creating …");
    await ensureBucket();
    up=await supabase
      .storage.from("tts-voices")
      .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});
  }
  if(up.error) throw up.error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

/* Stripe checkout helper */
async function ensureCustomer(u){
  if(u.stripe_cust_id) return u.stripe_cust_id;
  const c=await stripe.customers.create({description:`TuCan ${u.phone_number}`});
  await supabase.from("users").update({stripe_cust_id:c.id}).eq("id",u.id);
  return c.id;
}
async function checkoutUrl(u,tier){
  const price=tier==="monthly"?PRICE_MONTHLY:tier==="annual"?PRICE_ANNUAL:PRICE_LIFE;
  const s=await stripe.checkout.sessions.create({
    mode:tier==="life"?"payment":"subscription",
    customer:await ensureCustomer(u),
    line_items:[{price,quantity:1}],
    success_url:"https://tucanchat.io/success",
    cancel_url:"https://tucanchat.io/cancel",
    metadata:{tier}
  });
  return s.url;
}

/* tiny Twilio send */
async function sendMessage(to,body="",mediaUrl){
  const p={ from:WHATSAPP_FROM, to };
  if(mediaUrl) p.mediaUrl=[mediaUrl]; else p.body=body;
  await twilioClient.messages.create(p);
}
/* log row */
const logRow=d=>supabase.from("translations").insert({ ...d,id:uuid() });

/* ====================================================================
   4️⃣  Main handler
==================================================================== */
async function handleIncoming(from,text,num,mediaUrl){
  if(!from) return;

  /* fetch / create user row */
  let { data:user } = await supabase.from("users")
    .select("*").eq("phone_number",from).single();

  if(!user){
    ({ data:user } = await supabase.from("users").upsert(
      { phone_number:from, language_step:"choose_ui", plan:"FREE", free_used:0 },
      { onConflict:["phone_number"] }
    ).select("*").single());
  }

  const isFree = !user.plan || user.plan==="FREE";

  /* 0. first run – choose UI language */
  if(user.language_step==="choose_ui"){
    const lang = pickLang(text);
    if(!lang){
      await sendMessage(from, WELCOME);
      return;
    }
    await supabase.from("users").update({
      ui_lang   : lang.code,
      source_lang: lang.code,            // user language
      language_step:"receive"
    }).eq("id", user.id);

    /* send how-it-works + ask receive-language (localised) */
    await sendMessage(from, t("how", lang.code));
    await sendMessage(from,
      `${t("askReceive",lang.code)}\n\n${buildMenu(lang.code)}`
    );
    return;
  }

  /* 1. choose language you receive */
  if(user.language_step==="receive"){
    const lang = pickLang(text);
    if(!lang){
      await sendMessage(from,
        `${t("askReceive", user.ui_lang)}\n\n${buildMenu(user.ui_lang)}`
      );
      return;
    }
    if(lang.code===user.source_lang){
      await sendMessage(from,
        `${t("askReceive", user.ui_lang)}\n\n${buildMenu(user.ui_lang)}`
      );
      return;
    }
    await supabase.from("users").update({
      target_lang: lang.code,
      language_step:"gender"
    }).eq("id", user.id);

    await sendMessage(from, t("askGender", user.ui_lang));
    return;
  }

  /* 2. choose voice gender */
  if(user.language_step==="gender"){
    let g=null;
    if(/^1$/.test(text)||/male/i.test(text)) g="MALE";
    if(/^2$/.test(text)||/female/i.test(text)) g="FEMALE";
    if(!g){ await sendMessage(from,t("askGender",user.ui_lang)); return; }

    await supabase.from("users").update({
      voice_gender:g,
      language_step:"ready"
    }).eq("id", user.id);

    await sendMessage(from, t("setupDone", user.ui_lang));
    return;
  }

  /* 3. PAY-WALL quick replies */
  if(/^[1-3]$/.test(text)&&isFree&&user.free_used>=5){
    const tier = text==="1"?"monthly":text==="2"?"annual":"life";
    try{
      const link = await checkoutUrl(user,tier);
      await sendMessage(from,`Tap to pay → ${link}`);
    }catch(e){
      console.error("Stripe checkout err:",e.message);
      await sendMessage(from,"⚠️ Payment link error. Try again later.");
    }
    return;
  }

  /* 4. reset cmd */
  if(/^(reset|change language)$/i.test(text)){
    await supabase.from("users").update({
      language_step:"choose_ui",
      ui_lang:null, source_lang:null, target_lang:null,
      voice_gender:null
    }).eq("id",user.id);
    await sendMessage(from, WELCOME);
    return;
  }

  /* 5. pay-wall gate */
  if(isFree&&user.free_used>=5){
    await sendMessage(from, PAYWALL); return;
  }

  /* 6. guard */
  if(!user.source_lang||!user.target_lang||!user.voice_gender){
    await sendMessage(from,"⚠️ Setup incomplete. Type “reset” to start over."); return;
  }


  /* =================================================================
     Translation / TTS  (same as working build)
  ================================================================= */
  let original="",detected="";
  if(num>0&&mediaUrl){
    const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const resp=await fetch(mediaUrl,{headers:{Authorization:auth}});
    const buf=await resp.buffer();
    const ctype=resp.headers.get("content-type")||"";
    const ext=ctype.includes("ogg")?".ogg":
              ctype.includes("mpeg")?".mp3":
              ctype.includes("mp4")||ctype.includes("m4a")?".m4a":".dat";
    const raw=`/tmp/${uuid()}${ext}`,wav=raw.replace(ext,".wav");
    fs.writeFileSync(raw,buf); await toWav(raw,wav);
    try{
      const r=await whisper(wav);
      original=r.txt; detected=r.lang||(await detectLang(original)).slice(0,2);
    }finally{ fs.unlinkSync(raw); fs.unlinkSync(wav); }
  }else if(text){
    original=text;
    detected=(await detectLang(original)).slice(0,2);
  }
  if(!original){ await sendMessage(from,"⚠️ Send text or a voice note."); return; }

  const dest       = detected===user.target_lang ? user.source_lang : user.target_lang;
  const translated = await translate(original,dest);

  if(isFree){
    await supabase.from("users")
      .update({free_used:user.free_used+1})
      .eq("phone_number",from);
  }
  await logRow({
    phone_number:from,
    original_text:original,
    translated_text:translated,
    language_from:detected,
    language_to:dest
  });

  /* reply */
  if(num===0){ await sendMessage(from,translated); return; }

  await sendMessage(from,`🗣 ${original}`);     // 1
  await sendMessage(from,translated);          // 2
  try{
    const mp3=await tts(translated,dest,user.voice_gender);
    const pub=await uploadAudio(mp3);
    await sendMessage(from,"",pub);            // 3 (audio only)
  }catch(e){ console.error("TTS/upload error:",e.message); }
}

/* ====================================================================
   5️⃣  Twilio entry  (ACK immediately)
==================================================================== */
app.post(
  "/webhook",
  bodyParser.urlencoded({ extended:false, limit:"2mb" }),
  (req,res)=>{
    if(!req.body||!req.body.From){
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }
    const { From, Body, NumMedia, MediaUrl0 } = req.body;
    res.set("Content-Type","text/xml").send("<Response></Response>");
    handleIncoming(
      From, (Body||"").trim(), parseInt(NumMedia||"0",10), MediaUrl0
    ).catch(e=>console.error("handleIncoming ERR",e));
  }
);

/* health */
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
