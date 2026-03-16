import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = "Audilix <onboarding@resend.dev>";
const AUDILIX_EMAIL = "mohamed7azouzi@gmail.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

// ─── Supabase helpers ──────────────────────────────────────────
async function sbGet(table, filter = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${filter}`, {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function sbInsert(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password + "audilix_salt_2026").digest("hex");
}

function generateToken(userId) {
  return Buffer.from(`${userId}:${Date.now()}:audilix_secret`).toString("base64");
}

// ─── Email via Resend ──────────────────────────────────────────
async function sendReportEmail(toEmail, companyName, report) {
  const { score, risques, recommandations, résumé } = report;
  const scoreColor = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";
  const risquesHtml = (risques || []).map((r) => `<li style="margin-bottom:8px;">⚠️ ${r}</li>`).join("");
  const recoHtml = (recommandations || []).map((r) => `<li style="margin-bottom:8px;">✅ ${r}</li>`).join("");

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;background:#0B2545;border-radius:16px;overflow:hidden;">
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8C97A,#C9A84C);"></div>
    <div style="padding:40px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#C9A84C;">Rapport d'audit de conformité</p>
      <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;">AUDILIX</h1>
    </div>
    <div style="padding:40px;text-align:center;">
      <p style="margin:0 0 16px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Score de conformité — ${companyName}</p>
      <div style="display:inline-block;width:110px;height:110px;border-radius:50%;border:3px solid ${scoreColor};line-height:110px;font-size:36px;font-weight:700;color:${scoreColor};background:rgba(255,255,255,0.03);">${score}</div>
      <p style="margin:12px 0 0;font-size:13px;color:rgba(255,255,255,0.35);">sur 100</p>
    </div>
    <div style="padding:0 40px 32px;">
      <p style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#C9A84C;margin:0 0 12px;border-left:3px solid #C9A84C;padding-left:12px;">Analyse</p>
      <p style="font-size:15px;line-height:1.75;color:rgba(255,255,255,0.6);margin:0;">${résumé || ""}</p>
    </div>
    <div style="padding:0 40px 32px;">
      <p style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#ef4444;margin:0 0 12px;border-left:3px solid #ef4444;padding-left:12px;">Risques identifiés</p>
      <ul style="font-size:14px;line-height:1.7;color:rgba(255,255,255,0.6);padding-left:16px;margin:0;">${risquesHtml}</ul>
    </div>
    <div style="padding:0 40px 40px;">
      <p style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#22c55e;margin:0 0 12px;border-left:3px solid #22c55e;padding-left:12px;">Recommandations prioritaires</p>
      <ul style="font-size:14px;line-height:1.7;color:rgba(255,255,255,0.6);padding-left:16px;margin:0;">${recoHtml}</ul>
    </div>
    <div style="padding:32px 40px;text-align:center;background:rgba(255,255,255,0.03);border-top:1px solid rgba(255,255,255,0.06);">
      <a href="https://audilix.onrender.com/login.html" style="background:#C9A84C;color:#0B2545;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Accéder à mon dashboard →</a>
    </div>
    <div style="padding:24px 40px;text-align:center;">
      <p style="font-size:11px;color:rgba(255,255,255,0.2);margin:0;">© 2026 AUDILIX — contact.audilix@gmail.com</p>
    </div>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: [toEmail], subject: `🔍 Rapport Audilix — ${companyName} — Score ${score}/100`, html }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  return data;
}

// ─── OpenAI ────────────────────────────────────────────────────
async function callOpenAI(messages, maxTokens = 900) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, temperature: 0.15, max_tokens: maxTokens }),
  });
  const data = await res.json();
  if (!data.choices) throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

function cleanJSON(raw) {
  return raw.replace(/```json|```/g, "").trim();
}

// ─── AUTH — REGISTER ───────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  try {
    const { firstname, lastname, email, company, password, plan } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
    if (password.length < 8) return res.status(400).json({ error: "Mot de passe trop court (8 caractères min)" });

    // Vérif email déjà pris
    const existing = await sbGet("users", `?email=eq.${encodeURIComponent(email)}`);
    if (existing && existing.length > 0) return res.status(400).json({ error: "Un compte existe déjà avec cet email" });

    const user = await sbInsert("users", {
      email,
      password_hash: hashPassword(password),
      firstname: firstname || "",
      lastname: lastname || "",
      company: company || "",
      plan: plan || "starter"
    });

    const token = generateToken(user.id);
    const { password_hash, ...safeUser } = user;
    console.log(`✅ Nouveau compte: ${email} — Plan: ${plan}`);
    res.json({ token, user: safeUser });
  } catch(e) {
    console.error("❌ Register error:", e);
    res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

// ─── AUTH — LOGIN ──────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });

    const users = await sbGet("users", `?email=eq.${encodeURIComponent(email)}`);
    if (!users || users.length === 0) return res.status(401).json({ error: "Email ou mot de passe incorrect" });

    const user = users[0];
    if (user.password_hash !== hashPassword(password)) return res.status(401).json({ error: "Email ou mot de passe incorrect" });

    const token = generateToken(user.id);
    const { password_hash, ...safeUser } = user;
    console.log(`✅ Connexion: ${email}`);
    res.json({ token, user: safeUser });
  } catch(e) {
    console.error("❌ Login error:", e);
    res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

// ─── CRAWLER HTML ─────────────────────────────────────────────
async function crawlSite(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Audilix-Scanner/1.0 (compliance audit bot)" },
      timeout: 8000
    });
    const html = await res.text();
    const headers = Object.fromEntries(res.headers.entries());

    // Extraire infos clés du HTML
    const hasPrivacyPolicy = /politique de confidentialit|privacy policy|confidentialit/i.test(html);
    const hasLegalMentions = /mentions l.gales|legal notice/i.test(html);
    const hasCookieBanner = /cookie|consentement|consent|bandeau/i.test(html);
    const hasCookiePolicy = /politique.*cookie|cookie.*policy/i.test(html);
    const hasHttps = url.startsWith("https://");
    const hasHSTSHeader = !!headers["strict-transport-security"];
    const hasCSPHeader = !!headers["content-security-policy"];
    const hasXFrameHeader = !!headers["x-frame-options"];
    const hasXContentHeader = !!headers["x-content-type-options"];
    const hasRGPDMention = /rgpd|gdpr/i.test(html);
    const hasDPO = /dpo|délégué.*protection|data protection officer/i.test(html);
    const hasContactInfo = /contact|email|mail/i.test(html);
    const hasTerms = /conditions générales|cgu|terms|cgv/i.test(html);
    const hasSitemap = /sitemap/i.test(html);

    return {
      hasPrivacyPolicy, hasLegalMentions, hasCookieBanner, hasCookiePolicy,
      hasHttps, hasHSTSHeader, hasCSPHeader, hasXFrameHeader, hasXContentHeader,
      hasRGPDMention, hasDPO, hasContactInfo, hasTerms, hasSitemap,
      htmlLength: html.length,
      statusCode: res.status
    };
  } catch(e) {
    console.warn("⚠️ Crawl failed:", e.message);
    return null;
  }
}

// ─── SCAN PUBLIC ───────────────────────────────────────────────
app.post("/api/scan", async (req, res) => {
  try {
    const { url, user_id } = req.body;
    if (!url) return res.status(400).json({ error: "URL manquante" });

    console.log(`🔍 Scan demandé pour: ${url}`);

    // Crawler le site en temps réel
    const siteData = await crawlSite(url);
    const crawlInfo = siteData ? `
DONNÉES RÉELLES CRAWLÉES DU SITE :
- Politique de confidentialité présente : ${siteData.hasPrivacyPolicy}
- Mentions légales présentes : ${siteData.hasLegalMentions}
- Bandeau cookies présent : ${siteData.hasCookieBanner}
- Politique cookies présente : ${siteData.hasCookiePolicy}
- HTTPS actif : ${siteData.hasHttps}
- Header HSTS : ${siteData.hasHSTSHeader}
- Header CSP : ${siteData.hasCSPHeader}
- Header X-Frame-Options : ${siteData.hasXFrameHeader}
- Header X-Content-Type : ${siteData.hasXContentHeader}
- Mention RGPD/GDPR : ${siteData.hasRGPDMention}
- DPO mentionné : ${siteData.hasDPO}
- Coordonnées de contact : ${siteData.hasContactInfo}
- CGU/CGV présentes : ${siteData.hasTerms}
- Code HTTP : ${siteData.statusCode}
` : "Crawl impossible - analyse basée sur l'URL uniquement";

    const messages = [
      {
        role: "system",
        content: `Tu es un expert en conformité réglementaire européenne (RGPD, NIS2, AI Act, cybersécurité).
        On t'a fourni des données réelles crawlées du site. Base-toi UNIQUEMENT sur ces données réelles pour générer le rapport.
        
        RÈGLES DE SCORING STRICTES basées sur les données réelles :
        - Politique de confidentialité présente = +20 points
        - Mentions légales présentes = +15 points  
        - Bandeau cookies présent = +15 points
        - HTTPS actif = +10 points
        - Header HSTS présent = +5 points
        - Header CSP présent = +10 points
        - Header X-Frame-Options présent = +5 points
        - Coordonnées de contact = +5 points
        - CGU présentes = +5 points
        - Mention RGPD = +5 points
        - DPO mentionné = +5 points
        
        Commence à 0 et additionne uniquement les points des éléments PRÉSENTS.
        
        Renvoie UNIQUEMENT un JSON valide sans markdown :
        {
          "score": (nombre 0-100 basé strictement sur les données),
          "risques": [
            { "titre": "...", "description": "...", "niveau": "critique|important|modéré" },
            { "titre": "...", "description": "...", "niveau": "critique|important|modéré" },
            { "titre": "...", "description": "...", "niveau": "critique|important|modéré" }
          ],
          "résumé": "..."
        }
        Génère des risques UNIQUEMENT pour les éléments manquants détectés.`
      },
      {
        role: "user",
        content: `URL analysée : ${url}
        
        ${crawlInfo}
        
        Génère le rapport de conformité basé sur ces données réelles.`
      }
    ];

    const raw = await callOpenAI(messages, 700);
    const report = JSON.parse(cleanJSON(raw));

    // Sauvegarder en DB si utilisateur connecté
    if (user_id && SUPABASE_URL) {
      try {
        await sbInsert("scans", {
          user_id,
          url,
          score: report.score,
          risques: report.risques,
          resume: report.résumé
        });
      } catch(e) {
        console.warn("⚠️ Scan non sauvegardé en DB:", e.message);
      }
    }

    console.log(`✅ Scan terminé pour ${url} — Score: ${report.score}`);
    res.json(report);
  } catch (e) {
    console.error("❌ Erreur scan:", e);
    res.status(500).json({ error: "Erreur analyse", details: String(e) });
  }
});

// ─── GET SCANS UTILISATEUR ─────────────────────────────────────
app.get("/api/scans/:userId", async (req, res) => {
  try {
    const scans = await sbGet("scans", `?user_id=eq.${req.params.userId}&order=created_at.desc`);
    res.json(scans || []);
  } catch(e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET ALERTES UTILISATEUR ───────────────────────────────────
app.get("/api/alerts/:userId", async (req, res) => {
  try {
    const alerts = await sbGet("alerts", `?user_id=eq.${req.params.userId}&order=created_at.desc`);
    res.json(alerts || []);
  } catch(e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── AUDIT FORMULAIRE ──────────────────────────────────────────
app.post("/api/audit", async (req, res) => {
  try {
    const messages = [
      {
        role: "system",
        content: "Tu es un expert en conformité (RGPD, cybersécurité, RSE, ISO). Renvoie UNIQUEMENT un JSON valide sans markdown avec : score (0-100), risques (array de strings), recommandations (array de strings), résumé (string détaillé).",
      },
      { role: "user", content: JSON.stringify(req.body) },
    ];
    const raw = await callOpenAI(messages);
    res.json(JSON.parse(cleanJSON(raw)));
  } catch (e) {
    res.status(500).json({ error: "Erreur IA", details: String(e) });
  }
});

// ─── WEBHOOK TALLY ─────────────────────────────────────────────
app.post("/webhook/tally", async (req, res) => {
  try {
    const fields = req.body?.data?.fields || [];

    const getValue = (label) => {
      const field = fields.find((f) => f.label?.toLowerCase().includes(label.toLowerCase()));
      if (!field) return null;
      if (Array.isArray(field.value)) {
        return field.value.map((v) => {
          const opt = field.options?.find((o) => o.id === v);
          return opt ? opt.text : v;
        }).join(", ");
      }
      return field.value;
    };

    const companyName = getValue("entreprise") || getValue("société") || getValue("nom") || "Entreprise";
    const secteur = getValue("secteur") || "Non précisé";
    const taille = getValue("taille") || "Non précisé";
    const domaines = getValue("domaines") || "Non précisé";
    const dpo = getValue("responsable") || getValue("dpo") || "Non précisé";

    const messages = [
      {
        role: "system",
        content: "Tu es un expert en conformité (RGPD, cybersécurité, RSE, ISO). Renvoie UNIQUEMENT un JSON valide sans markdown avec : score (0-100), risques (array de strings), recommandations (array de strings), résumé (string détaillé).",
      },
      { role: "user", content: JSON.stringify({ entreprise: companyName, secteur, taille, domaines_concernés: domaines, a_dpo: dpo }) },
    ];

    const raw = await callOpenAI(messages);
    const report = JSON.parse(cleanJSON(raw));
    await sendReportEmail(AUDILIX_EMAIL, companyName, report);

    console.log(`✅ Rapport Tally envoyé — Score: ${report.score}`);
    res.status(200).json({ success: true, score: report.score });
  } catch (e) {
    console.error("❌ Erreur webhook:", e);
    res.status(500).json({ error: "Erreur traitement", details: String(e) });
  }
});


// ─── AI CHAT ───────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !messages.length) return res.status(400).json({ error: "Messages manquants" });

    const systemPrompt = {
      role: "system",
      content: `Tu es l'assistant virtuel d'Audilix, une plateforme SaaS d'audit de conformité automatisé par IA.
      
      Réponds en français, de manière concise et professionnelle (max 3-4 phrases).
      
      Informations sur Audilix :
      - Scanner gratuit : analyse un site web et génère un Compliance Trust Score™ /100 en moins de 2 minutes
      - Plan Starter : 69€/mois — 1 site, audit mensuel, documents juridiques générés, alertes email
      - Plan Business : 149€/mois — 5 sites, audit continu, AI Compliance Chat, Regulatory Watch™, corrections suggérées
      - Plan Expert : 299€/mois — sites illimités, moteur juridique IA avancé, API conformité, Badge Audilix Verified
      - Sans engagement, résiliable à tout moment
      - Paiement sécurisé par Stripe
      - Données hébergées en Europe (RGPD)
      - Contact : contact.audilix@gmail.com
      
      Tu peux répondre aux questions sur :
      - Le RGPD et la conformité réglementaire (cookies, mentions légales, politique de confidentialité, etc.)
      - Les plans et tarifs Audilix
      - Le fonctionnement du scanner et des rapports
      - La cybersécurité, NIS2, AI Act, RSE
      
      Si la question dépasse tes connaissances, suggère de contacter contact.audilix@gmail.com`
    };

    const allMessages = [systemPrompt, ...messages.slice(-6)]; // garder les 6 derniers messages
    const raw = await callOpenAI(allMessages, 300);
    res.json({ reply: raw });
  } catch(e) {
    console.error("❌ Chat error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ─── STRIPE CHECKOUT ───────────────────────────────────────────
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;

app.post("/api/stripe/checkout", async (req, res) => {
  try {
    const { priceId, userId, email, successUrl, cancelUrl, plan } = req.body;
    if (!priceId) return res.status(400).json({ error: "Price ID manquant" });

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        "mode": "subscription",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "success_url": successUrl || "https://audilix.com/dashboard.html?payment=success",
        "cancel_url": cancelUrl || "https://audilix.com/pricing.html",
        "customer_email": email || "",
        "metadata[userId]": userId || "",
        "metadata[plan]": plan || "",
        "allow_promotion_codes": "true",
        "billing_address_collection": "auto",
        "locale": "fr"
      })
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) throw new Error(session.error?.message || "Erreur Stripe");

    console.log(`💳 Checkout créé — Plan: ${plan} — Session: ${session.id}`);
    res.json({ url: session.url, sessionId: session.id });
  } catch(e) {
    console.error("❌ Stripe error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ─── STRIPE WEBHOOK ────────────────────────────────────────────
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    if (webhookSecret) {
      // Vérification signature (optionnel pour l'instant)
      event = JSON.parse(req.body);
    } else {
      event = req.body;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;

      if (userId && SUPABASE_URL) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ plan, stripe_customer_id: session.customer })
          });
          console.log(`✅ Plan mis à jour: ${userId} → ${plan}`);
        } catch(e) {
          console.warn("⚠️ Erreur mise à jour plan:", e.message);
        }
      }
    }

    res.json({ received: true });
  } catch(e) {
    console.error("❌ Stripe webhook error:", e);
    res.status(400).json({ error: String(e) });
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Audilix backend en ligne ✅", version: "4.0", supabase: !!SUPABASE_URL });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Audilix backend v4.0 en ligne sur le port", PORT));
