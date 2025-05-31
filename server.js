/* ───────────────────────────────────────────────────────────────────────
   TuCanChat server.js  —  WhatsApp voice↔text translator bot
   • 5-language wizard          • Whisper + GPT-4o translate
   • Google-TTS voices          • Stripe pay-wall (5 free)
   • Supabase logging           • Self-healing Storage bucket
   • 3-part voice-note reply    • Prefers en-US voice for English
   • UI prompts localised in EN / ES / FR / PT / DE
────────────────────────────────────────────────────────────────────────*/
import express          from "express";
import bodyParser       from "body-parser";
import fetch            from "node-fetch";
import ffmpeg           from "fluent-ffmpeg";
import fs               from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI           from "openai";
import Stripe           from "stripe";
import twilio           from "twilio";
import { createClient } from "@supabase/supabase-js";
import * as dotenv      from "dotenv";
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
  PORT = 8080,
} = process.env;
const WHATSAPP_FROM =
  TWILIO_PHONE_NUMBER.startsWith("whatsapp:")
    ? TWILIO_PHONE_NUMBER
    : `whatsapp:${TWILIO_PHONE_NUMBER}`;

/* ── clients ── */
const supabase     = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe       = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ── express ── */
const app = express();

/* =====================================================================
   ①  Stripe   – raw-body webhook (MUST be first)
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
      const plan = s.metadata.tier === "monthly"
        ? "MONTHLY"
        : s.metadata.tier === "annual"
        ? "ANNUAL"
        : "LIFETIME";

      /* ① try by stripe_cust_id ─────────────────────────────── */
      const upd1 = await supabase
        .from("users")
        .update({ plan, free_used: 0, stripe_sub_id: s.subscription })
        .eq("stripe_cust_id", s.customer);

      /* ② fallback by metadata.uid (created when checkout link built) */
      if (upd1.data?.length === 0) {
        await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_cust_id: s.customer,
            stripe_sub_id: s.subscription,
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
   ②  Constants / text snippets
===================================================================== */
const LANGS = {
  en: { name: "English"    },
  es: { name: "Spanish"    },
  fr: { name: "French"     },
  pt: { name: "Portuguese" },
  de: { name: "German"     },
};
const MENU = {
  1: { code: "en", name: LANGS.en.name },
  2: { code: "es", name: LANGS.es.name },
  3: { code: "fr", name: LANGS.fr.name },
  4: { code: "pt", name: LANGS.pt.name },
  5: { code: "de", name: LANGS.de.name },
};
const DIGITS = Object.keys(MENU);

const i18n = {
  en: {
    welcome:
      "👋 Welcome to TuCanChat!  Please choose your language:",
    howItWorks: `📌 How TuCanChat works
• Send any voice note or text.
• I instantly deliver:
 1. Heard: your exact words
 2. Translation
 3. Audio reply in your language
• Type “reset” anytime to switch languages.

When it shines: quick travel chats, decoding a doctor’s or lawyer’s message, serving global customers, or brushing up on a new language—without ever leaving WhatsApp.`,
    pickReceive: "🌎 What language do you RECEIVE messages in?",
    genderQ:     "🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female",
    complete:    "✅ Setup complete!  Send a voice-note or text.",
    badNumber:   "❌ Reply 1-5.",
    targetSame:  "⚠️ Target must differ.",
  },
  es: {
    welcome:
      "👋 ¡Bienvenido a TuCanChat!  Elige tu idioma:",
    howItWorks: `📌 Cómo funciona TuCanChat
• Envía cualquier nota de voz o texto.
• Recibirás al instante:
 1. Heard: tus palabras exactas
 2. Traducción
 3. Respuesta de audio en tu idioma
• Escribe “reset” en cualquier momento para cambiar de idioma.

Ideal para viajes, interpretar mensajes médicos o legales, atender clientes globales o practicar un nuevo idioma sin salir de WhatsApp.`,
    pickReceive: "🌎 ¿En qué idioma RECIBES mensajes?",
    genderQ:     "🔊 Voz:\n1️⃣ Masculina\n2️⃣ Femenina",
    complete:    "✅ ¡Listo!  Envía una nota de voz o texto.",
    badNumber:   "❌ Responde 1-5.",
    targetSame:  "⚠️ El destino debe ser diferente.",
  },
  fr: {
    welcome:
      "👋 Bienvenue sur TuCanChat ! Choisissez votre langue :",
    howItWorks: `📌 Comment fonctionne TuCanChat
• Envoyez n’importe quelle note vocale ou texte.
• Je réponds immédiatement :
 1. Heard : vos mots exacts
 2. Traduction
 3. Réponse audio dans votre langue
• Tapez “reset” à tout moment pour changer de langue.

Parfait pour voyager, comprendre un médecin ou un avocat, servir des clients internationaux ou pratiquer une nouvelle langue sans quitter WhatsApp.`,
    pickReceive: "🌎 Dans quelle langue RECEVEZ-vous les messages ?",
    genderQ:     "🔊 Genre de la voix ?\n1️⃣ Homme\n2️⃣ Femme",
    complete:    "✅ Configuration terminée ! Envoyez une note vocale ou un texte.",
    badNumber:   "❌ Répondez 1-5.",
    targetSame:  "⚠️ La langue cible doit être différente.",
  },
  pt: {
    welcome:
      "👋 Bem-vindo ao TuCanChat!  Escolha seu idioma:",
    howItWorks: `📌 Como o TuCanChat funciona
• Envie qualquer áudio ou texto.
• Eu retorno instantaneamente:
 1. Heard: suas palavras exatas
 2. Tradução
 3. Resposta de áudio no seu idioma
• Digite “reset” a qualquer momento para trocar de idioma.

Perfeito para viagens, entender mensagens de médicos ou advogados, atender clientes globais ou praticar um novo idioma – tudo dentro do WhatsApp.`,
    pickReceive: "🌎 Em qual idioma você RECEBE mensagens?",
    genderQ:     "🔊 Voz:\n1️⃣ Masculina\n2️⃣ Feminina",
    complete:    "✅ Pronto! Envie um áudio ou texto.",
    badNumber:   "❌ Responda 1-5.",
    targetSame:  "⚠️ O destino deve ser diferente.",
  },
  de: {
    welcome:
      "👋 Willkommen bei TuCanChat!  Bitte wähle deine Sprache:",
    howItWorks: `📌 So funktioniert TuCanChat
• Sende eine Sprachnachricht oder einen Text.
• Ich liefere sofort:
 1. Heard: deine genauen Worte
 2. Übersetzung
 3. Audio-Antwort in deiner Sprache
• Tippe jederzeit “reset”, um die Sprache zu wechseln.

Ideal für Reisen, das Entziffern von Arzt-/Anwalts­nachrichten, internationalen Kundenservice oder zum Sprachenlernen – direkt in WhatsApp.`,
    pickReceive: "🌎 In welcher Sprache ERHÄLTST du Nachrichten?",
    genderQ:     "🔊 Stimmtyp?\n1️⃣ Männlich\n2️⃣ Weiblich",
    complete:    "✅ Einrichtung abgeschlossen!  Sende eine Sprachnachricht oder Text.",
    badNumber:   "❌ Antworte mit 1-5.",
    targetSame:  "⚠️ Zielsprache muss abweichen.",
  },
};

/* helper: numbered menu in correct language */
const menuList = lang =>
  DIGITS
    .map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`)
    .join("\n");

const paywallMsg = {
  en: `⚠️ You’ve used your 5 free translations.

1️⃣ Monthly  $4.99
2️⃣ Annual   $49.99
3️⃣ Lifetime $199`,
  es: `⚠️ Has usado tus 5 traducciones gratis.

1️⃣ Mensual  $4.99
2️⃣ Anual    $49.99
3️⃣ De por vida $199`,
  fr: `⚠️ Vous avez utilisé vos 5 traductions gratuites.

1️⃣ Mensuel  4,99 $
2️⃣ Annuel   49,99 $
3️⃣ À vie    199 $`,
  pt: `⚠️ Você usou suas 5 traduções grátis.

1️⃣ Mensal   US$ 4,99
2️⃣ Anual    US$ 49,99
3️⃣ Vitalício US$ 199`,
  de: `⚠️ Du hast deine 5 kostenlosen Übersetzungen genutzt.

1️⃣ Monatlich  4,99 $
2️⃣ Jährlich   49,99 $
3️⃣ Lebenslang 199 $`,
};

/* ====================================================================
   3️⃣  AUDIO & AI HELPERS  (unchanged from working build)
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

/* Google-TTS voice picker  (same as working build) */
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
async function handleIncoming(from, text, num, mediaUrl) {
  if (!from) return;

  /* fetch or create user row (switch .single → .maybeSingle) */
  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number", from)
    .maybeSingle();

  if (!user) {
    ({ data: user } = await supabase
      .from("users")
      .upsert(
        {
          phone_number: from,
          ui_lang: null,          // not chosen yet
          language_step: "choose_ui",
          plan: "FREE",
          free_used: 0,
        },
        { onConflict: ["phone_number"] }
      )
      .select("*")
      .maybeSingle());
  }

  /* fail-safe: if row still null, bail gracefully */
  if (!user) {
    console.error("❌ couldn’t create user row for", from);
    await sendMessage(
      from,
      "⚠️ Internal setup error – please type “reset” and try again."
    );
    return;
  }

  /* helper to fetch right strings */
  const L = (key) => i18n[user.ui_lang || "en"][key];

  /* ————————————————— 0. first-ever message → welcome menu ——————— */
  if (user.language_step === "choose_ui") {
    const choice = pickLang(text);
    if (choice) {
      await supabase
        .from("users")
        .update({
          ui_lang: choice.code,
          source_lang: choice.code,       // user’s own language
          language_step: "target",
        })
        .eq("id", user.id);

      await sendMessage(
        from,
        [
          i18n[choice.code].howItWorks,
          "",
          i18n[choice.code].pickReceive,
          "",
          menuList(choice.code),
        ].join("\n")
      );
    } else {
      await sendMessage(from, `${i18n.en.welcome}\n\n${menuList("en")}`);
    }
    return;
  }

  const isFree = !user.plan || user.plan === "FREE";
   
  /* pay-wall button replies */
  if (/^[1-3]$/.test(text) && isFree && user.free_used >= 5) {
    const tier = text === "1" ? "monthly" : text === "2" ? "annual" : "life";
    try {
      const link = await checkoutUrl(user, tier);
      await sendMessage(from, `Tap to pay → ${link}`);
    } catch (e) {
      console.error("Stripe checkout err:", e.message);
      await sendMessage(from, "⚠️ Payment link error.  Try again later.");
    }
    return;
  }

  /* reset command (case-insensitive, English word) */
  if (/^reset$/i.test(text)) {
    await supabase
      .from("users")
      .update({
        language_step: "choose_ui",
        ui_lang: null,
        source_lang: null,
        target_lang: null,
        voice_gender: null,
      })
      .eq("id", user.id);

    await sendMessage(from, `${i18n.en.welcome}\n\n${menuList("en")}`);
    return;
  }

  /* pay-wall gate */
  if (isFree && user.free_used >= 5) {
    await sendMessage(from, paywallMsg[user.ui_lang || "en"]);
    return;
  }

  /* wizard: pick RECEIVE language (target_lang) */
  if (user.language_step === "target") {
    const choice = pickLang(text);
    if (choice) {
      if (choice.code === user.source_lang) {
        await sendMessage(
          from,
          `${L("targetSame")}\n\n${menuList(user.ui_lang)}`
        );
        return;
      }
      await supabase
        .from("users")
        .update({ target_lang: choice.code, language_step: "gender" })
        .eq("id", user.id);
      await sendMessage(from, L("genderQ"));
    } else {
      await sendMessage(from, `${L("badNumber")}\n${menuList(user.ui_lang)}`);
    }
    return;
  }

  /* wizard: gender */
  if (user.language_step === "gender") {
    let g = null;
    if (/^1$/.test(text) || /male/i.test(text))   g = "MALE";
    if (/^2$/.test(text) || /female/i.test(text)) g = "FEMALE";
    if (g) {
      await supabase
        .from("users")
        .update({ voice_gender: g, language_step: "ready" })
        .eq("id", user.id);
      await sendMessage(from, L("complete"));
    } else {
      await sendMessage(from, `${L("genderQ")}`);
    }
    return;
  }

  /* guard: setup incomplete */
  if (!user.source_lang || !user.target_lang || !user.voice_gender) {
    await sendMessage(from, "⚠️ Setup incomplete.  Type reset to start over.");
    return;
  }

  /* =================================================================
     Translation / TTS  (unchanged)
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

  await sendMessage(from,`🗣 ${original}`);          // 1
  await sendMessage(from,translated);               // 2
  try{
    const mp3=await tts(translated,dest,user.voice_gender);
    const pub=await uploadAudio(mp3);
    await sendMessage(from,"",pub);                 // 3 (audio)
  }catch(e){ console.error("TTS/upload error:",e.message); }
}

/* ====================================================================
   5️⃣  Twilio entry  (ACK immediately)
==================================================================== */
app.post(
  "/webhook",
  bodyParser.urlencoded({ extended: false, limit: "2mb" }),
  (req, res) => {
    if (!req.body || !req.body.From) {
      return res.set("Content-Type", "text/xml").send("<Response></Response>");
    }
    const { From, Body, NumMedia, MediaUrl0 } = req.body;
    res.set("Content-Type", "text/xml").send("<Response></Response>");
    handleIncoming(
      From,
      (Body || "").trim(),
      parseInt(NumMedia || "0", 10),
      MediaUrl0
    ).catch((e) => console.error("handleIncoming ERR", e));
  }
);

app.get("/healthz", (_, r) => r.send("OK"));
app.listen(PORT, () => console.log("🚀 running on", PORT));
