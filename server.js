/* ──────────────────────────────────────────────────────────────────────
   TuCanChat server.js  –  WhatsApp voice ↔ text translator bot
────────────────────────────────────────────────────────────────────── */
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
import vision           from "@google-cloud/vision";

/* 🆕 PDF libs */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.js";   // ← must be this
import pdfParse from "pdf-parse/lib/pdf-parse.js";  
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas } from "canvas";

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
  GOOGLE_APPLICATION_CREDENTIALS_JSON,
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
const visionClient = new vision.ImageAnnotatorClient({
  credentials: JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON)
});

/* ──────────────────────────────────────────────────────────────────────
   Stripe helpers
────────────────────────────────────────────────────────────────────── */

/* Ensure row has stripe_cust_id before checkout */
async function ensureCustomer(user) {
  if (user.stripe_cust_id) return user.stripe_cust_id;

  const c = await stripe.customers.create({
    description: `TuCanChat — ${user.phone_number}`,
    email: user.email || undefined,
    name : user.full_name || user.phone_number
  });

  /* synchronous upsert ⇒ row definitely has stripe_cust_id */
  await supabase
    .from("users")
    .upsert(
      { id: user.id, stripe_cust_id: c.id },
      { onConflict: ["id"] }
    )
    .select();

  return c.id;
}

/* Build hosted-checkout link */
async function checkoutUrl(user, tier /* 'monthly' | 'annual' | 'life' */) {
  const price =
    tier === "monthly" ? PRICE_MONTHLY :
    tier === "annual"  ? PRICE_ANNUAL  :
    PRICE_LIFE;

  const custId  = await ensureCustomer(user);
  const session = await stripe.checkout.sessions.create({
    mode: tier === "life" ? "payment" : "subscription",
    customer: custId,
    line_items: [{ price, quantity: 1 }],
    success_url: "https://tucanchat.io/success",
    cancel_url : "https://tucanchat.io/cancel",
    metadata   : { tier }               // uid no longer required
  });

  return session.url;
}

/* ──────────────────────────────────────────────────────────────────────
   Stripe webhook  (must be above any JSON body-parser)
────────────────────────────────────────────────────────────────────── */
const app = express();

app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    /* verify signature */
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️  Stripe signature failed:", err.message);
      return res.sendStatus(400);          // tell Stripe to retry
    }

    /* checkout complete → upgrade */
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const plan =
        s.metadata.tier === "monthly" ? "MONTHLY" :
        s.metadata.tier === "annual"  ? "ANNUAL"  :
        "LIFETIME";

      try {
        await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_sub_id: s.subscription     // null for lifetime
          })
          .eq("stripe_cust_id", s.customer);
        console.log("✅ plan set to", plan, "for", s.customer);
      } catch (dbErr) {
        console.error("❌ Supabase update failed:", dbErr.message);
        /* returning 200 so Stripe doesn’t keep retrying
           change to res.sendStatus(500) if you prefer retries */
      }
    }

    /* subscription cancelled → downgrade */
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      try {
        await supabase
          .from("users")
          .update({ plan: "FREE" })
          .eq("stripe_sub_id", sub.id);
        console.log("↩️  subscription cancelled for", sub.id);
      } catch (dbErr) {
        console.error("❌ downgrade failed:", dbErr.message);
      }
    }

    res.json({ received: true });   // ACK Stripe
  }
);

/* ====================================================================
   2️⃣  CONSTANTS / HELPERS
==================================================================== */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = t =>
  `${t}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt => {
  const m = txt.trim(), d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc);
};
const paywallMsg = {
  en: `⚠️ You’ve used your 10 free translations. For unlimited access, please choose
one of the subscription options below:

1️⃣ Monthly  $1.99
2️⃣ Annual   $19.99`,

  es: `⚠️ Has usado tus 10 traducciones gratuitas. Para acceso ilimitado, elige
una de las siguientes opciones de suscripción:

1️⃣ Mensual    $1.99
2️⃣ Anual     $19.99`,

  fr: `⚠️ Vous avez utilisé vos 10 traductions gratuites. Pour un accès illimité, choisissez
l’une des options d’abonnement ci-dessous :

1️⃣ Mensuel   $1.99
2️⃣ Annuel    $19.99`,

  pt: `⚠️ Você usou suas 10 traduções gratuitas. Para acesso ilimitado, escolha
uma das opções de assinatura abaixo:

1️⃣ Mensal    US$1.99
2️⃣ Anual     US$19.99`,

  de: `⚠️ Du hast deine 10 kostenlosen Übersetzungen aufgebraucht. Für unbegrenzten Zugriff wähle
eine der folgenden Abo-Optionen:

1️⃣ Monatlich   $1.99
2️⃣ Jährlich    $19.99`
};

/* ────────── new constants ────────── */
const WELCOME_MSG =
`Welcome to TuCanChat🦜
1) I speak English – type 1
2) Hablo Español – escribe 2
3) Je parle français – tapez 3
4) Eu falo português – digite 4
5) Ich spreche Deutsch – tippe 5`;

const HOW_TEXT =                  // kept in English; we’ll auto-translate later
`📌 How TuCanChat works🦜
Recieve a voice note or text you dont 100% understand?
• Send it to me
• I instantly:
  1. Transcribe the message
  2. Translate
  3. Provide an audio reply in your language
  4. Speak the reply in your own language; I’ll translate and creat a text and voice message you can forward to them
• Type “reset” anytime to switch languages.

All without leaving WhatsApp.`;
/* ─────────────────────────────────── */

/* 🆕  ──────────  PDF HELPERS  ────────── */

/* Split long strings into ~size-char chunks */
const chunkText = (s, size = 3000) => {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
};

/* Extract text → pdf-parse first, Vision OCR fallback */
async function extractPdfText(buffer) {
  /* quick parse */
  const { text } = await pdfParse(buffer);
  if (text.trim().length >= 200) return text;

  /* fallback OCR (scanned PDF) */
  const doc = await pdfjs.getDocument({ data: buffer }).promise;
  let ocr = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const page     = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas   = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const [det] = await visionClient.textDetection(canvas.toBuffer("image/png"));
    ocr += (det.fullTextAnnotation?.text || "") + "\n\n";
  }
  return ocr.trim();
}

/* Build a simple PDF from translated text */
async function buildPdf(text) {
  const doc  = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { width, height } = doc.addPage().getSize(); // dummy to read size
  doc.removePage(0);                                 // remove dummy

  const lines = text.split("\n\n");
  for (const block of lines) {
    const page = doc.addPage();
    page.drawText(block, {
      x: 40,
      y: height - 60,
      size: 12,
      lineHeight: 14,
      font
    });
  }
  return Buffer.from(await doc.save());
}

/* Supabase bucket for PDFs (self-healing) */
async function ensurePdfBucket() {
  const { error } = await supabase.storage
    .createBucket("pdf-translations", { public: true });
  if (error && error.code !== "PGRST116") throw error;
}
async function uploadPdf(buffer) {
  const fn = `pdf_${uuid()}.pdf`;
  let up = await supabase.storage
    .from("pdf-translations")
    .upload(fn, buffer, { contentType: "application/pdf", upsert: true });

  if (up.error && /Bucket not found/i.test(up.error.message)) {
    await ensurePdfBucket();
    up = await supabase.storage
      .from("pdf-translations")
      .upload(fn, buffer, { contentType: "application/pdf", upsert: true });
  }
  if (up.error) throw up.error;

  return `${SUPABASE_URL}/storage/v1/object/public/pdf-translations/${fn}`;
}

/* audio helpers */
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
      {role:"system",content:
        `You are a professional translator.
         Never translate the literal keyword "reset"; always leave it as the
         lowercase English word "reset".
         Translate everything else to ${target}. Return ONLY the translation.`},
       { role: "user",
        content: `Translate this into ${target}:\n\n${text}` }
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

/* Google TTS voices */
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

  /* ⭐ Prefer en-US over en-AU, en-GB, etc. */
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

/* skinny Twilio send */
async function sendMessage(to,body="",mediaUrl){
  const p={ from:WHATSAPP_FROM, to };
  if(mediaUrl) p.mediaUrl=[mediaUrl];
  else         p.body=body;
  await twilioClient.messages.create(p);
}

/* log */
const logRow=d=>supabase.from("translations").insert({ ...d,id:uuid() });

/* ====================================================================
   3️⃣  Main handler
==================================================================== */
async function handleIncoming(
  from,
  text = "",
  num = 0,
  mediaUrl,
  mediaType = "",
  mediaSize = 0
) {
  if (!from) return;
  const lower = text.trim().toLowerCase();

  /* 0. fetch (or create) user */
  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number", from)
    .single();

  if (!user) {
    ({ data: user } = await supabase
      .from("users")
      .upsert(
        { phone_number: from, language_step: "target", plan: "FREE", free_used: 0 },
        { onConflict: "phone_number" })
      .select("*")
      .single());

    await sendMessage(from, WELCOME_MSG);
    return;
  }

  const isFree = !user.plan || user.plan === "FREE";

  /* 1. pay-wall button replies */
  if (/^[1-3]$/.test(lower) && isFree && user.free_used >= 10) {
    const tier = lower === "1" ? "monthly" : lower === "2" ? "annual" : "life";
    try {
      const link = await checkoutUrl(user, tier);
      await sendMessage(from, `Tap to pay → ${link}`);
    } catch (e) {
      console.error("Stripe checkout err:", e.message);
      await sendMessage(from, "⚠️ Payment link error. Try again later.");
    }
    return;
  }

  /* 2. reset */
  if (/^(reset|change language)$/i.test(lower)) {
    await supabase.from("users").update({
      language_step: "target",
      source_lang: null,
      target_lang: null,
      voice_gender: null,
    }).eq("phone_number", from);

    await sendMessage(from, WELCOME_MSG);
    return;
  }

  /* 3. free-tier gate */
  if (isFree && user.free_used >= 10) {
    await sendMessage(
    from,
    paywallMsg[(user.target_lang || "en").toLowerCase()] || paywallMsg.en
    );
;
    return;
  }

  /* 4. onboarding wizard ----------------------------------- */
/* 4a.  pick TARGET language (TuCanChat’s reply language) */
if (user.language_step === "target") {
  const choice = pickLang(text);
  if (choice) {
    /* save target & advance */
    await supabase
      .from("users")
      .update({ target_lang: choice.code, language_step: "source" })
      .eq("phone_number", from);

    /* 1️⃣  send “How TuCanChat works” (translated) */
    const how = await translate(HOW_TEXT, choice.code);
    await sendMessage(from, how);

    /* 2️⃣  build a two-part prompt  */
    const heading = await translate(
      "Choose the language you RECEIVE messages in:",
      choice.code
    );
    const menuRaw = `1) English (en)
2) Spanish (es)
3) French (fr)
4) Portuguese (pt)
5) German (de)`;
    const menuTranslated = await translate(menuRaw, choice.code);

    /* 3️⃣  heading + menu in ONE message */
    await sendMessage(from, `${heading}\n${menuTranslated}`);
  } else {
    await sendMessage(
      from,
      "❌ Reply 1-5.\n1) English\n2) Spanish\n3) French\n4) Portuguese\n5) German"
    );
  }
  return;
}

  /* 4b. pick SOURCE language (user’s sending language) */
  if (user.language_step === "source") {
    const choice = pickLang(text);
    if (choice) {
      if (choice.code === user.target_lang) {
        await sendMessage(from, menuMsg("⚠️ Source must differ.\nLanguages:"));
        return;
      }
      await supabase.from("users")
        .update({ source_lang: choice.code, language_step: "gender" })
        .eq("phone_number", from);

      const gPrompt = await translate(
        "🔊 Choose your voice gender?\n1️⃣ Male\n2️⃣ Female",
        user.target_lang
      );
      await sendMessage(from, gPrompt);
    } else {
      await sendMessage(from, menuMsg("❌ Reply 1-5.\nLanguages:"));
    }
    return;
  }

  /* 4c. pick voice gender */
  if (user.language_step === "gender") {
    let g = null;
    if (/^1$/.test(lower) || /male/i.test(lower))   g = "MALE";
    if (/^2$/.test(lower) || /female/i.test(lower)) g = "FEMALE";

    if (g) {
      await supabase.from("users")
        .update({ voice_gender: g, language_step: "ready" })
        .eq("phone_number", from);

      const done = await translate(
        "✅ Setup complete! Send text or a voice note.",
        user.target_lang
      );
      await sendMessage(from, done);
    } else {
      const retry = await translate(
        "❌ Reply 1 or 2.\n1️⃣ Male\n2️⃣ Female",
        user.target_lang
      );
      await sendMessage(from, retry);
    }
    return;
  }
  if(!user.source_lang||!user.target_lang||!user.voice_gender){
    await sendMessage(from,"⚠️ Setup incomplete. Text *reset* to start over.");return;
  }

 
  /* ------------------ PDF branch ------------------ */
  const isPdf = num > 0 && mediaType && mediaType.includes("pdf");
  if (isPdf) {
    if (mediaSize > 16000000) {
      await sendMessage(from, "🙁 PDF too big for WhatsApp (limit 16 MB).");
      return;
    }
    const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const pdfBuffer = await (await fetch(mediaUrl, { headers: { Authorization: auth } })).buffer();

    let pdfText;
    try { pdfText = await extractPdfText(pdfBuffer); }
    catch (err) {
      console.error("PDF parse/OCR error:", err);
      await sendMessage(from, "⚠️ Couldn’t read that PDF.");
      return;
    }
    if (pdfText.length < 10) {
      await sendMessage(from, "🤔 No readable text in that PDF.");
      return;
    }

    const pieces = [];
    for (const c of chunkText(pdfText)) {
      pieces.push(await translate(c, user.target_lang));
    }
    const translated = pieces.join("\n\n");

    let newPdf;
    try { newPdf = await buildPdf(translated); }
    catch (err) {
      console.error("PDF build error:", err);
      await sendMessage(from, "⚠️ Couldn’t build translated PDF.");
      return;
    }

    let url;
    try { url = await uploadPdf(newPdf); }
    catch (err) {
      console.error("PDF upload error:", err);
      await sendMessage(from, "⚠️ Couldn’t upload translated PDF.");
      return;
    }

    await sendMessage(from, "✅ Translation complete – here’s your file:");
    await sendMessage(from, "", url);

    const add = 3;
    if (isFree) {
      await supabase.from("users")
        .update({ free_used: (user.free_used || 0) + add })
        .eq("phone_number", from);
    }
    await logRow({
      phone_number: from,
      original_text:  "[PDF]",
      translated_text:"[PDF]",
      language_from:  user.source_lang,
      language_to:    user.target_lang,
      credits_used:   add,
      file_type:      "PDF"
    });
    return;          // done with PDF
  }
  /* ------------------------------------------------ */

  /* transcribe / detect */
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

  /* usage + log */
  const add = 1;
  if(isFree){
    await supabase.from("users")
      .update({ free_used: (user.free_used || 0) + add })
      .eq("phone_number",from);
  }
  await logRow({
    phone_number:from,
    original_text:original,
    translated_text:translated,
    language_from:detected,
    language_to:dest,
    credits_used:add,
    file_type:num>0?"AUDIO":"TEXT"
  });

  /* reply flow */
  if(num===0){ await sendMessage(from,translated); return; }

  await sendMessage(from,`🗣 ${original}`);  // 1
  await sendMessage(from,translated);        // 2
  try{
    const mp3=await tts(translated,dest,user.voice_gender);
    const pub=await uploadAudio(mp3);
    await sendMessage(from,"",pub);          // 3 (audio only)
  }catch(e){
    console.error("TTS/upload error:",e.message);
  }
}
/* ====================================================================
   4️⃣  Twilio entry  (ACK immediately)
==================================================================== */
app.post(
  "/webhook",
  bodyParser.urlencoded({ extended:false, limit:"2mb" }),
  (req,res)=>{
    if(!req.body||!req.body.From){
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }
    const { From, Body, NumMedia, MediaUrl0, MediaContentType0, MediaContentSize0 } = req.body;
    res.set("Content-Type","text/xml").send("<Response></Response>");
    handleIncoming(
      From,
      (Body||"").trim(),
      parseInt(NumMedia||"0",10),
      MediaUrl0,
      MediaContentType0,
      parseInt(MediaContentSize0||"0",10)
    ).catch(e=>console.error("handleIncoming ERR",e));
  }
);
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 running on ${PORT}`);
});
