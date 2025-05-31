/* ───────────────────────────────────────────────────────────────────────
   TuCan server.js  —  WhatsApp voice↔text translator bot
   • Welcome-language picker     • 5-language wizard
   • Whisper + GPT-4o translate  • Google-TTS voices
   • Stripe pay-wall (5 free)    • Supabase logging & self-healing bucket
   • 3-part voice-note reply     • Prefers en-US voice for English
────────────────────────────────────────────────────────────────────────*/
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
import * as dotenv from "dotenv";
dotenv.config();

/* crash guard */
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

/* ENV */
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

/* clients */
const supabase     = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe       = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* express */
const app = express();

/* ====================================================================
   1️⃣  STRIPE WEBHOOK  (raw body) — unchanged
==================================================================== */
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
      const s    = event.data.object;
      const plan = s.metadata.tier === "monthly" ? "MONTHLY"
                 : s.metadata.tier === "annual"  ? "ANNUAL"
                 : "LIFETIME";

      const upd1 = await supabase
        .from("users")
        .update({ plan, free_used: 0, stripe_sub_id: s.subscription })
        .eq("stripe_cust_id", s.customer);

      if (upd1.data?.length === 0) {
        await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_cust_id: s.customer,
            stripe_sub_id:  s.subscription
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
  return Object.values(MENU).find(
    o => o.code === lc || o.name.toLowerCase() === lc
  );
};

const HOW_IT_WORKS_EN =
`Send a voice note or text ➜
• I transcribe & translate it
• You receive text + audio reply
Send “reset” anytime to change languages.`.trim();

const paywallMsg =
`⚠️ You’ve used your 5 free translations. For unlimited access, choose:

1️⃣ Monthly  $4.99
2️⃣ Annual   $49.99
3️⃣ Lifetime $199`;

/* ── (all audio / TTS / storage / Stripe helpers remain unchanged) ── */
⋯    /* — SNIPPED FOR BREVITY:  toWav, whisper, detectLang, translate,
         loadVoices/pickVoice, tts, ensureBucket, uploadAudio,
         ensureCustomer, checkoutUrl, sendMessage, logRow — remain identical
         to the working code you supplied. */
      
/* ====================================================================
   3️⃣  Main handler
==================================================================== */
async function handleIncoming(from,text,num,mediaUrl){
  if(!from) return;

  /* user row */
  let { data:user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number",from)
    .single();

  if(!user){
    ({ data:user } = await supabase.from("users")
      .upsert(
        { phone_number:from,
          language_step:"welcome",           // 👈 NEW start state
          plan:"FREE",
          free_used:0
        },
        { onConflict:["phone_number"] }
      ).select("*").single());
  }
  const isFree = !user.plan || user.plan==="FREE";

  /* ───────────────────────────────
     WELCOME  – pick own language
  ─────────────────────────────── */
  if(user.language_step==="welcome"){
    const choice = pickLang(text);

    /* if no valid digit/keyword → show menu (again) */
    if(!choice){
      await sendMessage(from,
        menuMsg("👋 Welcome to TuCanChat!  Please choose your language:")
      );
      return;
    }

    /* save as TARGET language & step forward */
    await supabase.from("users")
      .update({ target_lang: choice.code, language_step:"source" })
      .eq("phone_number",from);

    const blurb = choice.code==="en"
        ? HOW_IT_WORKS_EN
        : await translate(HOW_IT_WORKS_EN, choice.code);

    await sendMessage(from, blurb);

    await sendMessage(
      from,
      menuMsg("🗣 What language are the messages you RECEIVE in?")
    );
    return;
  }

  /* =================================================================
     Rest of the ORIGINAL wizard / pay-wall / translation logic
     (everything below is **identical** to the working file you sent)
  ================================================================= */
  /* pay-wall replies */
  if(/^[1-3]$/.test(text) && isFree && user.free_used>=5){
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
      language_step:"welcome",
      source_lang:null,target_lang:null,voice_gender:null
    }).eq("phone_number",from);
    await sendMessage(from,
      menuMsg("🔄 Setup reset!\n👋 Please choose your language:")
    );
    return;
  }

  /* pay-wall gate */
  if(isFree && user.free_used>=5){ await sendMessage(from,paywallMsg); return; }

  /* wizard: source language */
  if(user.language_step==="source"){
    const c=pickLang(text);
    if(c){
      await supabase.from("users")
        .update({source_lang:c.code,language_step:"gender"})
        .eq("phone_number",from);
      await sendMessage(from,"🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female");
    }else{
      await sendMessage(from,menuMsg("❌ Reply 1-5.\nLanguages:"));
    }
    return;
  }

  /* wizard: gender */
  if(user.language_step==="gender"){
    let g=null;
    if(/^1$/.test(text)||/male/i.test(text))   g="MALE";
    if(/^2$/.test(text)||/female/i.test(text)) g="FEMALE";
    if(g){
      await supabase.from("users")
        .update({voice_gender:g,language_step:"ready"})
        .eq("phone_number",from);
      await sendMessage(from,"✅ Setup complete! Send text or a voice note.");
    }else{
      await sendMessage(from,"❌ Reply 1 or 2.\n1️⃣ Male\n2️⃣ Female");
    }
    return;
  }

  /* guard */
  if(!user.source_lang||!user.target_lang||!user.voice_gender){
    await sendMessage(from,"⚠️ Setup incomplete. Text *reset* to start over.");return;
  }

  /* transcribe / detect / translate — unchanged */
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

  /* usage & log */
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
