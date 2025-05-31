/* ───────────────────────────────────────────────────────────────────────
   TuCanChat server.js  —  WhatsApp voice↔text translator bot
   ✦ 5-language wizard              ✦ Whisper + GPT-4o translate
   ✦ Google-TTS voices (prefers en-US)    ✦ Stripe pay-wall (5 free)
   ✦ Supabase logging + self-healing bucket
   ✦ 3-part voice-note reply flow
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

/* ── crash guard ── */
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
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ── Express ─ */
const app = express();

/* =====================================================================
   1️⃣  STRIPE WEBHOOK (raw body)
===================================================================== */
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      console.error("stripe sig err", e.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const plan =
        s.metadata.tier === "monthly"
          ? "MONTHLY"
          : s.metadata.tier === "annual"
          ? "ANNUAL"
          : "LIFETIME";

      /* ① by stripe_cust_id */
      const upd1 = await supabase
        .from("users")
        .update({ plan, free_used: 0, stripe_sub_id: s.subscription })
        .eq("stripe_cust_id", s.customer);

      /* ② fallback by metadata.uid */
      if (upd1.data?.length === 0) {
        await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_cust_id: s.customer,
            stripe_sub_id: s.subscription
          })
          .eq("id", s.metadata.uid);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await supabase
        .from("users")
        .update({ plan: "FREE" })
        .eq("stripe_sub_id", sub.id);
    }
    res.json({ received: true });
  }
);

/* =====================================================================
   2️⃣  CONSTANTS / LOCALISATION HELPERS
===================================================================== */
const MENU = {
  1: { name: "English", code: "en" },
  2: { name: "Spanish", code: "es" },
  3: { name: "French", code: "fr" },
  4: { name: "Portuguese", code: "pt" },
  5: { name: "German", code: "de" }
};
const DIGITS = Object.keys(MENU);
const menuLines = DIGITS.map(
  d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`
).join("\n");

/* UI strings */
const UI = {
  en: {
    how: `📌 How TuCanChat works
• Send any voice note or text.
• I instantly deliver:
\t1. Heard: your exact words
\t2. Translation
\t3. Audio reply in your language
• Type “reset” anytime to switch languages.

When it shines: quick travel chats, decoding a doctor’s or lawyer’s message, serving global customers, or brushing up on a new language—without ever leaving WhatsApp.`,
    askReceive: "🌎 What language do you RECEIVE messages in?",
    askGender: "🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female",
    done: "✅ Setup complete!  Send a voice-note or text.",
    male: "Male",
    female: "Female",
    badChoice: "❌ Reply 1-5.",
    badMF: "❌ Reply 1 or 2."
  },
  es: {
    how: `📌 Cómo funciona TuCanChat
• Envía una nota de voz o un texto.
• Yo te entrego al instante:
\t1. Heard: tus palabras exactas
\t2. Traducción
\t3. Audio en tu idioma
• Escribe “reset” en cualquier momento para cambiar de idioma.

Úsalo para: viajes rápidos, entender al médico o abogado, atender clientes globales o practicar un nuevo idioma sin salir de WhatsApp.`,
    askReceive: "🌎 ¿En qué idioma RECIBES los mensajes?",
    askGender: "🔊 ¿Voz?\n1️⃣ Masculina\n2️⃣ Femenina",
    done: "✅ ¡Configuración completa! Envía una nota de voz o texto.",
    male: "Masculina",
    female: "Femenina",
    badChoice: "❌ Responde 1-5.",
    badMF: "❌ Responde 1 o 2."
  },
  fr: {
    how: `📌 Comment fonctionne TuCanChat
• Envoie un message vocal ou texte.
• Je réponds instantanément :
\t1. Heard : tes mots exacts
\t2. Traduction
\t3. Réponse audio dans ta langue
• Tape “reset” à tout moment pour changer de langue.

Idéal pour : voyages, comprendre un médecin ou un avocat, servir des clients globaux ou réviser une langue sans quitter WhatsApp.`,
    askReceive: "🌎 Dans quelle langue REÇOIS-tu les messages ?",
    askGender: "🔊 Genre de voix ?\n1️⃣ Masculine\n2️⃣ Féminine",
    done: "✅ Configuration terminée ! Envoie un vocal ou un texte.",
    male: "Masculine",
    female: "Féminine",
    badChoice: "❌ Réponds 1-5.",
    badMF: "❌ Réponds 1 ou 2."
  },
  pt: {
    how: `📌 Como o TuCanChat funciona
• Envie uma nota de voz ou texto.
• Eu entrego na hora:
\t1. Heard: suas palavras exatas
\t2. Tradução
\t3. Resposta em áudio no seu idioma
• Digite “reset” a qualquer momento para trocar o idioma.

Ótimo para: viagens rápidas, entender médico ou advogado, atender clientes globais ou praticar um idioma sem sair do WhatsApp.`,
    askReceive: "🌎 Em que idioma você RECEBE mensagens?",
    askGender: "🔊 Gênero da voz?\n1️⃣ Masculina\n2️⃣ Feminina",
    done: "✅ Configuração concluída! Envie áudio ou texto.",
    male: "Masculina",
    female: "Feminina",
    badChoice: "❌ Responda 1-5.",
    badMF: "❌ Responda 1 ou 2."
  },
  de: {
    how: `📌 So funktioniert TuCanChat
• Sende eine Sprachnachricht oder einen Text.
• Ich liefere sofort:
\t1. Heard: deine genauen Worte
\t2. Übersetzung
\t3. Audio-Antwort in deiner Sprache
• Tippe „reset“, um jederzeit die Sprache zu wechseln.

Ideal für: Reisen, Arzt- oder Anwaltsnachrichten, weltweite Kundenbetreuung oder Sprachlernen – direkt in WhatsApp.`,
    askReceive: "🌎 In welcher Sprache ERHÄLTST du Nachrichten?",
    askGender: "🔊 Stimmtyp?\n1️⃣ Männlich\n2️⃣ Weiblich",
    done: "✅ Einrichtung abgeschlossen! Sende eine Sprachnachricht oder Text.",
    male: "Männlich",
    female: "Weiblich",
    badChoice: "❌ Antworte 1-5.",
    badMF: "❌ Antworte 1 oder 2."
  }
};
/* helper to fetch locale string; default → English */
const L = (lang, key) => (UI[lang] && UI[lang][key]) || UI.en[key];

/* pick language */
const pickLang = txt => {
  const m = txt.trim();
  const d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o => o.code === lc || o.name.toLowerCase() === lc);
};

/* pay-wall prompt (English only) */
const paywallMsg =
`⚠️ You’ve used your 5 free translations. For unlimited access, please choose
one of the subscription options below:

1️⃣ Monthly  $4.99
2️⃣ Annual   $49.99
3️⃣ Lifetime $199`;

/* =====================================================================
   3️⃣  SHARED UTILITIES (toWav, whisper, detectLang, translate, voices…)
   — identical to previous fully-working build, omitted here for brevity —
   (copy the implementations you already have from the working version)
===================================================================== */
const toWav = (i, o) => new Promise((res, rej) =>
  ffmpeg(i).audioCodec("pcm_s16le")
    .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
    .on("error", rej).on("end", () => res(o))
    .save(o)
);
async function whisper(wav){
  try{
    const r=await openai.audio.transcriptions.create({
      model:"whisper-large-v3",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }catch{
    const r=await openai.audio.transcriptions.create({
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
      {role:"user",content:text}
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

/* Google TTS */
let voiceCache=null;
async function loadVoices(){
  if(voiceCache)return;
  const {voices}=await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r=>r.json());
  voiceCache=voices.reduce((m,v)=>{
    v.languageCodes.forEach(full=>{
@@ -283,237 +363,250 @@ async function ensureCustomer(u){
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
  const p={ from:WHATSAPP_FROM, to };
  if(mediaUrl) p.mediaUrl=[mediaUrl];
  else         p.body=body;
  await twilioClient.messages.create(p);
}

/* log insert */
const logRow=d=>supabase.from("translations").insert({ ...d,id:uuid() });

/* =====================================================================
   4️⃣  MAIN HANDLER
===================================================================== */
async function handleIncoming(from,text,num,mediaUrl){
  if(!from) return;

  /* ensure user row */
  let { data:user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number",from)
    .single();

  if(!user){
    ({ data:user } = await supabase
      .from("users")
      .upsert(
        { phone_number:from, language_step:"welcome", plan:"FREE", free_used:0 },
        { onConflict:["phone_number"] }
      )
      .select("*")
      .single());
  }
  const isFree = !user.plan || user.plan === "FREE";

  /* 0️⃣ FIRST-EVER message → send welcome menu */
  if(user.language_step === "welcome"){
    await sendMessage(
      from,
      "👋 Welcome to TuCanChat!  Please choose your language:\n\n" + menuLines
    );
    await supabase
      .from("users")
      .update({ language_step:"pick_source" })
      .eq("id", user.id);
    return;
  }

  /*  paywall & reset logic stays SAME as fully-working version … */
  if(/^(reset|change language)$/i.test(text)){
    await supabase.from("users").update({
      language_step:"welcome",
      source_lang:null,
      target_lang:null,
      voice_gender:null,
      ui_lang:null
    }).eq("id", user.id);
    await sendMessage(
      from,
      "👋 Welcome to TuCanChat!  Please choose your language:\n\n" + menuLines
    );
    return;
  }
  if(/^[1-3]$/.test(text) && isFree && user.free_used>=5){
    const tier=text==="1"?"monthly":text==="2"?"annual":"life";
    try{
      const link=await checkoutUrl(user,tier);
      await sendMessage(from,`Tap to pay → ${link}`);
    }catch(e){
      console.error("Checkout err:",e.message);
      await sendMessage(from,"⚠️ Payment link error. Try again later.");
    }
    return;
  }
  if(isFree && user.free_used>=5){
    await sendMessage(from,paywallMsg);
    return;
  }

  /* pick_source step */
  if(user.language_step === "pick_source"){
    const c=pickLang(text);
    if(!c){
      await sendMessage(from,`❌ Reply 1-5.\n${menuLines}`);
      return;
    }
    await supabase
      .from("users")
      .update({
        source_lang:c.code,
        ui_lang:c.code,
        language_step:"pick_target"
      })
      .eq("id", user.id);

    await sendMessage(from, L(c.code,"how"));
    await sendMessage(
      from,
      L(c.code,"askReceive") + "\n\n" + menuLines.replace(MENU[c.code]?.name ?? "", MENU[c.code]?.name ?? "")
    );
    return;
  }

  /* reload user (may have new ui_lang) */
  ({ data:user } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single());

  const uiLang = user.ui_lang || "en";

  /* pick_target */
  if(user.language_step === "pick_target"){
    const c=pickLang(text);
    if(!c){
      await sendMessage(from, L(uiLang,"badChoice") + "\n" + menuLines);
      return;
    }
    if(c.code === user.source_lang){
      await sendMessage(from, L(uiLang,"badChoice") + "\n" + menuLines);
      return;
    }

    await supabase
      .from("users")
      .update({ target_lang:c.code, language_step:"gender" })
      .eq("id", user.id);

    await sendMessage(from, L(uiLang,"askGender"));
    return;
  }

  /* gender step */
  if(user.language_step === "gender"){
    let g=null;
    if(/^1$/.test(text) || /male/i.test(text)) g="MALE";
    if(/^2$/.test(text) || /female/i.test(text)) g="FEMALE";
    if(!g){
      await sendMessage(from, L(uiLang,"badMF") + "\n1️⃣ " + L(uiLang,"male") + "\n2️⃣ " + L(uiLang,"female"));
      return;
    }

    await supabase
      .from("users")
      .update({ voice_gender:g, language_step:"ready" })
      .eq("id", user.id);

    await sendMessage(from, L(uiLang,"done"));
    return;
  }

  /*  …  remainder of translation/transcription/pay-wall flow
          identical to previous fully-working build
  */

  if(!user.source_lang||!user.target_lang||!user.voice_gender){
    await sendMessage(from,"⚠️ Setup incomplete. Text *reset* to start over.");
    return;
  }

  let original="", detected="";
  if(num>0 && mediaUrl){
    const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const resp=await fetch(mediaUrl,{headers:{Authorization:auth}});
    const buf=await resp.buffer();
    const ctype=resp.headers.get("content-type")||"";
    const ext=ctype.includes("ogg")?".ogg":ctype.includes("mpeg")?".mp3":
              ctype.includes("mp4")||ctype.includes("m4a")?".m4a":".dat";
    const raw=`/tmp/${uuid()}${ext}`, wav=raw.replace(ext,".wav");
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
      .eq("id", user.id);
  }
  await logRow({
    phone_number:from,
    original_text:original,
    translated_text:translated,
    language_from:detected,
    language_to:dest
  });

  if(num===0){ await sendMessage(from,translated); return; }

  await sendMessage(from,`🗣 ${original}`);
  await sendMessage(from,translated);
  try{
    const mp3=await tts(translated,dest,user.voice_gender);
    const pub=await uploadAudio(mp3);
    await sendMessage(from,"",pub);
  }catch(e){ console.error("TTS/upload error:",e.message); }
}

/* =====================================================================
   5️⃣  TWILIO ENTRY (ACK immediately)
===================================================================== */
app.post(
  "/webhook",
  bodyParser.urlencoded({ extended:false, limit:"2mb" }),
  (req,res)=>{
    if(!req.body || !req.body.From){
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }
    const { From, Body, NumMedia, MediaUrl0 } = req.body;
    res.set("Content-Type","text/xml").send("<Response></Response>");
    handleIncoming(
      From,
      (Body||"").trim(),
      parseInt(NumMedia||"0",10),
      MediaUrl0
    ).catch(e=>console.error("handleIncoming ERR",e));
  }
);

/* health */
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
