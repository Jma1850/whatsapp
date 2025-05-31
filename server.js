/* ───────────────────────────────────────────────────────────────────────
   TuCan server.js  —  WhatsApp voice↔text translator bot
   • 5-language wizard in user’s language     • Whisper + GPT-4o translate
   • Google-TTS voices + en-US preference     • Stripe pay-wall (5 free)
   • Supabase logging + self-healing bucket   • 3-part voice-note reply
────────────────────────────────────────────────────────────────────────*/
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI from "openai";
import Stripe from "stripe";
import twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── crash-guard ── */
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

/* ── ENV ── */
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TTS_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRICE_MONTHLY,
  PRICE_ANNUAL,
  PRICE_LIFE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT = 8080
} = process.env;
const WHATSAPP_FROM =
  TWILIO_PHONE_NUMBER.startsWith("whatsapp:")
    ? TWILIO_PHONE_NUMBER
    : `whatsapp:${TWILIO_PHONE_NUMBER}`;

/* ── clients ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe   = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ──────────────────────────────────────────────────────────────────────
   I18N  ▶  wizard strings in EN / ES / FR / PT / DE   (“reset” kept EN)
───────────────────────────────────────────────────────────────────────*/
const I18N = {
  en: {
    how: `📌 How TuCanChat works
• Send any voice note or text.
• I instantly deliver:
\t1. Heard: your exact words
\t2. Translation
\t3. Audio reply in your language
• Type “reset” anytime to switch languages.

When it shines: quick travel chats, decoding a doctor’s or lawyer’s message, serving global customers, or brushing up on a new language—without ever leaving WhatsApp.`,
    receive: "🌎 What language do you RECEIVE messages in?",
    voice:   "🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female",
    genderErr:"❌ Reply 1 or 2.\n1️⃣ Male\n2️⃣ Female",
    setupDone:"✅ Setup complete!  Send a voice-note or text.",
    paywall:`⚠️ You’ve used your 5 free translations. For unlimited access, please choose one of the subscription options below:\n\n1️⃣ Monthly  $4.99\n2️⃣ Annual   $49.99\n3️⃣ Lifetime $199`,
    targetDiff:"⚠️ Target must differ.",
    reply1to5:"❌ Reply 1-5."
  },
  es: {
    how:`📌 Cómo funciona TuCanChat
• Envía cualquier nota de voz o texto.
• Te entrego al instante:
\t1. Heard: tus palabras exactas
\t2. Traducción
\t3. Audio en tu idioma
• Escribe “reset” en cualquier momento para cambiar idiomas.

Ideal para viajes, citas médicas o legales, atender clientes globales o practicar un idioma — todo dentro de WhatsApp.`,
    receive:"🌎 ¿En qué idioma RECIBES los mensajes?",
    voice:"🔊 Voz:\n1️⃣ Masculina\n2️⃣ Femenina",
    genderErr:"❌ Responde 1 o 2.\n1️⃣ Masculina\n2️⃣ Femenina",
    setupDone:"✅ ¡Listo! Envía una nota de voz o texto.",
    paywall:`⚠️ Has usado tus 5 traducciones gratis. Para acceso ilimitado elige:\n\n1️⃣ Mensual  $4.99\n2️⃣ Anual    $49.99\n3️⃣ De por vida $199`,
    targetDiff:"⚠️ El destino debe ser diferente.",
    reply1to5:"❌ Responde 1-5."
  },
  fr: {
    how:`📌 Comment fonctionne TuCanChat
• Envoyez un message vocal ou texte.
• Je réponds aussitôt :
\t1. Heard : vos mots exacts
\t2. Traduction
\t3. Audio dans votre langue
• Tapez “reset” à tout moment pour changer de langue.

Parfait pour voyager, comprendre un médecin ou un avocat, servir des clients internationaux ou pratiquer une langue — sans quitter WhatsApp.`,
    receive:"🌎 Dans quelle langue RECEVEZ-vous les messages ?",
    voice:"🔊 Genre de voix ?\n1️⃣ Masculine\n2️⃣ Féminine",
    genderErr:"❌ Répondez 1 ou 2.\n1️⃣ Masculine\n2️⃣ Féminine",
    setupDone:"✅ Configuration terminée ! Envoyez un vocal ou un texte.",
    paywall:`⚠️ Vous avez utilisé vos 5 traductions gratuites. Pour un accès illimité :\n\n1️⃣ Mensuel  4,99 $\n2️⃣ Annuel   49,99 $\n3️⃣ À vie    199 $`,
    targetDiff:"⚠️ La cible doit être différente.",
    reply1to5:"❌ Répondez 1-5."
  },
  pt: {
    how:`📌 Como o TuCanChat funciona
• Envie qualquer áudio ou texto.
• Eu entrego na hora:
\t1. Heard: suas palavras exatas
\t2. Tradução
\t3. Áudio no seu idioma
• Digite “reset” a qualquer momento para trocar de idioma.

Ótimo para viagens, entender médicos ou advogados, atender clientes globais ou praticar um idioma — sem sair do WhatsApp.`,
    receive:"🌎 Em qual idioma você RECEBE mensagens?",
    voice:"🔊 Gênero da voz:\n1️⃣ Masculina\n2️⃣ Feminina",
    genderErr:"❌ Responda 1 ou 2.\n1️⃣ Masculina\n2️⃣ Feminina",
    setupDone:"✅ Configuração concluída! Envie um áudio ou texto.",
    paywall:`⚠️ Você usou suas 5 traduções grátis. Para acesso ilimitado escolha:\n\n1️⃣ Mensal   $4.99\n2️⃣ Anual    $49.99\n3️⃣ Vitalício $199`,
    targetDiff:"⚠️ O destino deve ser diferente.",
    reply1to5:"❌ Responda 1-5."
  },
  de: {
    how:`📌 So funktioniert TuCanChat
• Sende eine Sprachnachricht oder einen Text.
• Ich liefere sofort:
\t1. Heard: deine genauen Worte
\t2. Übersetzung
\t3. Audio-Antwort in deiner Sprache
• Tippe „reset“, um jederzeit die Sprache zu wechseln.

Ideal für Reisen, Arzt-/Anwaltsnachrichten, globalen Kundenservice oder Sprachpraxis – ohne WhatsApp zu verlassen.`,
    receive:"🌎 In welcher Sprache ERHÄLTST du Nachrichten?",
    voice:"🔊 Stimmtyp?\n1️⃣ Männlich\n2️⃣ Weiblich",
    genderErr:"❌ Antworte 1 oder 2.\n1️⃣ Männlich\n2️⃣ Weiblich",
    setupDone:"✅ Setup abgeschlossen! Sende eine Sprachnachricht oder Text.",
    paywall:`⚠️ Du hast deine 5 Gratis-Übersetzungen verbraucht. Für unbegrenzten Zugang:\n\n1️⃣ Monatlich  $4.99\n2️⃣ Jährlich   $49.99\n3️⃣ Lebenslang $199`,
    targetDiff:"⚠️ Ziellanguage muss unterschiedlich sein.",
    reply1to5:"❌ Antworte 1-5."
  }
};
const tr = (lang,key)=> (I18N[lang]&&I18N[lang][key])||I18N.en[key];

/* ── language menu constants (neutral) ── */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = txt =>
  `${txt}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt=>{
  const d=txt.trim().match(/^\d/);
  if(d&&MENU[d[0]]) return MENU[d[0]];
  const lc=txt.toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc);
};

/* =====================================================================
   1.  Stripe webhook 
===================================================================== */

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

/* =====================================================================
   2.  Helpers:  toWav, whisper, detectLang, translate, TTS, uploadAudio,
       checkoutUrl, sendMessage  (IDENTICAL to previous working build)
       — KEEPING CODE to make the file self-contained —
===================================================================== */
const toWav=(i,o)=>new Promise((res,rej)=>
  ffmpeg(i).audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",rej).on("end",()=>res(o)).save(o));
async function whisper(wav){
  try{
    const r=await openai.audio.transcriptions.create({
      model:"whisper-large-v3",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return{txt:r.text,lang:(r.language||"").slice(0,2)};
  }catch{
    const r=await openai.audio.transcriptions.create({
      model:"whisper-1",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return{txt:r.text,lang:(r.language||"").slice(0,2)};
  }
}
const detectLang=async q=>
 (await fetch(
   `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
   {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q})}
 ).then(r=>r.json())).data.detections[0][0].language;
async function translate(text,target){
  const r=await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      {role:"system",content:`Translate to ${target}. Return ONLY the translation.`},
      {role:"user",content:text}
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}
/* — Google-TTS voice cache (same) — */
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
  return(
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
      {method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({
         input:{text}, voice:{languageCode:lc,name},
         audioConfig:{audioEncoding:"MP3",speakingRate:0.9}
       })}
    ).then(r=>r.json());
    return r.audioContent?Buffer.from(r.audioContent,"base64"):null;
  };
  let buf=await synth(await pickVoice(lang,gender)); if(buf)return buf;
  buf=await synth(lang); if(buf)return buf;
  buf=await synth("en-US-Standard-A"); if(buf)return buf;
  throw new Error("TTS failed");
}
/* self-healing bucket + upload */
async function ensureBucket(){
  const {error}=await supabase.storage.createBucket("tts-voices",{public:true});
  if(error&&error.code!=="PGRST116") throw error;
}
async function uploadAudio(buffer){
  const fn=`tts_${uuid()}.mp3`;
  let up=await supabase.storage.from("tts-voices")
    .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});
  if(up.error&&/Bucket not found/i.test(up.error.message)){
    console.warn("⚠️ Bucket missing → creating …");await ensureBucket();
    up=await supabase.storage.from("tts-voices")
      .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});
  }
  if(up.error) throw up.error;
  return`${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}
/* stripe checkout link (unchanged) */
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
/* skinny Twilio send */
async function sendMessage(to,body="",mediaUrl){
  const p={from:WHATSAPP_FROM,to};
  mediaUrl ? p.mediaUrl=[mediaUrl] : p.body=body;
  await twilioClient.messages.create(p);
}
/* logger */
const logRow=d=>supabase.from("translations").insert({...d,id:uuid()});

/* ====================================================================
   3. Main handler  (wizard & translation logic)
==================================================================== */
async function handleIncoming(from,text,num,mediaUrl){
  if(!from) return;

  /* fetch / create user */
  let {data:user}=await supabase.from("users").select("*")
    .eq("phone_number",from).single();
  if(!user){
    ({data:user}=await supabase.from("users").upsert(
      {phone_number:from,language_step:"ui",plan:"FREE",free_used:0},
      {onConflict:["phone_number"]}).select("*").single());
  }
  const isFree= !user.plan||user.plan==="FREE";

  /* pay-wall quick replies */
  if(/^[1-3]$/.test(text)&&isFree&&user.free_used>=5){
    const tier=text==="1"?"monthly":text==="2"?"annual":"life";
    try{
      const link=await checkoutUrl(user,tier);
      await sendMessage(from,`Tap to pay → ${link}`);
    }catch(e){
      console.error("Stripe checkout err:",e.message);
      await sendMessage(from,"⚠️ Payment link error. Try again later.");
    }
    return;
  }

  /* reset */
  if(/^(reset|change language)$/i.test(text)){
    await supabase.from("users").update({
      language_step:"ui",source_lang:null,target_lang:null,
      voice_gender:null,ui_lang:null
    }).eq("phone_number",from);
    await sendMessage(from,
      "👋 Welcome to TuCanChat!  Please choose your language:\n\n"+
      DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")
    );
    return;
  }

  /* PAYWALL gate */
  if(isFree&&user.free_used>=5){ await sendMessage(from,tr(user.ui_lang||"en","paywall")); return; }

  /* ───── Wizard flow ───── */
  /* STEP 0: choose UI / own language  */
  if(user.language_step==="ui"){
    const c=pickLang(text);
    if(!c){
      await sendMessage(from,tr("en","reply1to5")+"\n"+menuMsg("Please choose your language:"));
      return;
    }
    await supabase.from("users").update({
      ui_lang:c.code,
      source_lang:c.code,             // own language
      language_step:"target"
    }).eq("phone_number",from);

    /* send how-it-works + next prompt in ui_lang */
    await sendMessage(from,tr(c.code,"how"));
    await sendMessage(from,menuMsg(tr(c.code,"receive")));
    return;
  }

  /* STEP 1: target / receive language */
  const ui=user.ui_lang||"en";
  if(user.language_step==="target"){
    const c=pickLang(text);
    if(!c){ await sendMessage(from,tr(ui,"reply1to5")+"\n"+menuMsg(tr(ui,"receive")));return;}
    if(c.code===user.source_lang){
      await sendMessage(from,tr(ui,"targetDiff")+"\n"+menuMsg(tr(ui,"receive")));return;
    }
    await supabase.from("users")
      .update({target_lang:c.code,language_step:"gender"})
      .eq("phone_number",from);
    await sendMessage(from,tr(ui,"voice"));
    return;
  }

  /* STEP 2: voice gender */
  if(user.language_step==="gender"){
    let g=null;
    if(/^1$/.test(text)||/male|masculina|männlich/i.test(text))   g="MALE";
    if(/^2$/.test(text)||/female|femenina|weiblich/i.test(text)) g="FEMALE";
    if(!g){ await sendMessage(from,tr(ui,"genderErr")); return; }
    await supabase.from("users")
      .update({voice_gender:g,language_step:"ready"})
      .eq("phone_number",from);
    await sendMessage(from,tr(ui,"setupDone"));
    return;
  }

  /* Abort if setup incomplete */
  if(!user.source_lang||!user.target_lang||!user.voice_gender){
    await sendMessage(from,"⚠️ Setup incomplete. Text *reset* to start over.");return;
  }

  /* ───── Translation phase ───── */
  let original="",detected="";
  if(num>0&&mediaUrl){
    const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const resp=await fetch(mediaUrl,{headers:{Authorization:auth}});
    const buf=await resp.buffer();
    const ctype=resp.headers.get("content-type")||"";
    const ext=ctype.includes("ogg")?".ogg":ctype.includes("mpeg")?".mp3":
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

  const dest= detected===user.target_lang ? user.source_lang : user.target_lang;
  const translated=await translate(original,dest);

  /* usage + log */
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

  await sendMessage(from,`🗣 ${original}`);       // 1
  await sendMessage(from,translated);            // 2
  try{
    const mp3=await tts(translated,dest,user.voice_gender);
    const pub=await uploadAudio(mp3);
    await sendMessage(from,"",pub);              // 3
  }catch(e){ console.error("TTS/upload error:",e.message); }
}

/* ====================================================================
   4.  Twilio webhook  (ACK immediately, run handler async)
==================================================================== */
app.post("/webhook",
  bodyParser.urlencoded({extended:false,limit:"2mb"}),(req,res)=>{
    if(!req.body||!req.body.From){
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }
    const {From,Body,NumMedia,MediaUrl0}=req.body;
    res.set("Content-Type","text/xml").send("<Response></Response>");
    /* FIRST-CONTACT welcome */
    supabase.from("users").select("id").eq("phone_number",From).single()
      .then(({data})=>{
        if(!data){
          sendMessage(From,
            "👋 Welcome to TuCanChat!  Please choose your language:\n\n"+
            DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")
          );
        }
      })
      .catch(()=>{});
    handleIncoming(
      From,(Body||"").trim(),parseInt(NumMedia||"0",10),MediaUrl0
    ).catch(e=>console.error("handleIncoming ERR",e));
});
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
