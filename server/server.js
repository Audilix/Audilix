import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";
import multer from "multer";

const app = express();
app.use(cors({
  origin: [
    'https://audilix.com',
    'https://www.audilix.com',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const STRIPE_SECRET         = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const FROM_EMAIL    = "Audilix <contact@audilix.com>";

// Limites par plan
const LIMITES_PLAN = {
  essai:    1,
  starter:  10,
  business: -1,
  pro:      -1,
  expert:   -1
};

// ─── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "text/plain",
      "text/html",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Format non supporté. Utilisez PDF, TXT ou DOCX."));
  }
});

// ─── Helpers ───────────────────────────────────────────────────
function hashPassword(p) {
  return crypto.createHash("sha256").update(p + "audilix_salt_2026").digest("hex");
}

function generateToken(userId) {
  return crypto.createHash("sha256").update(userId + Date.now() + "audilix_secret").digest("hex");
}

function cleanJSON(raw) {
  return raw.replace(/```json|```/g, "").trim();
}

// Nettoie un buffer binaire (PDF/DOCX) sans regex complexe
function cleanBuffer(buffer) {
  return buffer.toString("latin1")
    .split("")
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return (code >= 32 && code <= 255) || ch === "\n";
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 8000);
}

async function sbGet(table, query = "") {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Configuration Supabase manquante");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || data.error || `Supabase error ${r.status}`);
  return Array.isArray(data) ? data : [];
}

async function sbInsert(table, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Configuration Supabase manquante");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify(data)
  });
  const rows = await r.json();
  if (!r.ok) throw new Error((Array.isArray(rows) ? rows[0]?.message : rows?.message) || `Supabase insert error ${r.status}`);
  return Array.isArray(rows) ? rows[0] : rows;
}

async function callOpenAI(messages, maxTokens = 1000) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: maxTokens, temperature: 0.3 })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function sendEmail(to, subject, html) {
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
  } catch(e) { console.warn("⚠️ Email non envoyé:", e.message); }
}

async function compterAnalysesMois(userId) {
  try {
    const debut = new Date();
    debut.setDate(1); debut.setHours(0, 0, 0, 0);
    const r = await sbGet("analyses", `?user_id=eq.${userId}&created_at=gte.${debut.toISOString()}&select=id`);
    return r ? r.length : 0;
  } catch(e) { return 0; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH — REGISTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/auth/register", async (req, res) => {
  try {
    const { firstname, lastname, email, company, password, plan } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
    if (password.length < 8) return res.status(400).json({ error: "Mot de passe trop court (8 caractères min)" });

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
    console.log(`✅ Nouveau compte: ${email}`);
    res.json({ token, user: safeUser });
  } catch(e) {
    console.error("❌ Register error:", e);
    res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH — LOGIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCAN PUBLIC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/scan", async (req, res) => {
  try {
    const { url, userId } = req.body;
    if (!url) return res.status(400).json({ error: "URL manquante" });

    let htmlContent = "";
    try {
      const pageRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 Audilix-Bot/1.0" },
        signal: AbortSignal.timeout(10000)
      });
      htmlContent = await pageRes.text();
      htmlContent = htmlContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 6000);
    } catch(e) {
      htmlContent = `URL: ${url}`;
    }

    const messages = [
      {
        role: "system",
        content: `Tu es un expert RGPD. Analyse ce site web.
        Réponds UNIQUEMENT en JSON valide sans markdown :
        {
          "score": (0-100),
          "risques": ["risque 1", "risque 2", "risque 3"],
          "recommandations": ["reco 1", "reco 2", "reco 3"],
          "resume": "Résumé en 2-3 phrases"
        }`
      },
      { role: "user", content: `Analyse ce site (${url}) :\n\n${htmlContent}` }
    ];

    const raw = await callOpenAI(messages, 800);
    const report = JSON.parse(cleanJSON(raw));

    if (userId) {
      try {
        await sbInsert("scans", { user_id: userId, url, score: report.score, risques: report.risques, resume: report.resume });
      } catch(e) { console.warn("⚠️ Sauvegarde scan échouée"); }
    }

    res.json({ ...report, url });
  } catch(e) {
    console.error("❌ Scan error:", e);
    res.status(500).json({ error: "Erreur lors du scan", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HISTORIQUE SCANS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/api/scans/:userId", async (req, res) => {
  try {
    const scans = await sbGet("scans", `?user_id=eq.${req.params.userId}&order=created_at.desc&limit=50`);
    res.json(scans || []);
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ANALYSE DE DOCUMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/analyser-document", upload.single("document"), async (req, res) => {
  try {
    const { userId, planUtilisateur } = req.body;
    if (!req.file) return res.status(400).json({ error: "Aucun document fourni" });
    if (!userId)   return res.status(400).json({ error: "Utilisateur non identifié" });

    const plan = planUtilisateur || "starter";
    const limite = LIMITES_PLAN[plan] !== undefined ? LIMITES_PLAN[plan] : 10;
    if (limite !== -1) {
      const nb = await compterAnalysesMois(userId);
      if (nb >= limite) return res.status(403).json({
        error: `Limite mensuelle atteinte (${limite} analyses). Passez au plan Professionnel.`,
        limitAtteinte: true
      });
    }

    const nomFichier = req.file.originalname;
    let contenu = "";

    if (req.file.mimetype === "text/plain" || req.file.mimetype === "text/html") {
      contenu = req.file.buffer.toString("utf-8").substring(0, 8000);
    } else {
      contenu = cleanBuffer(req.file.buffer);
    }

    if (!contenu || contenu.trim().length < 50) {
      return res.status(400).json({ error: "Document vide ou illisible. Essayez un fichier .txt" });
    }

    const messages = [
      {
        role: "system",
        content: `Tu es un expert en conformité réglementaire européenne (RGPD, droit du travail, droit commercial).
        Réponds UNIQUEMENT en JSON valide sans markdown :
        {
          "score": (0-100),
          "type_document": "Type identifié",
          "problemes": [{ "titre": "", "description": "", "gravite": "critique|important|mineur", "article_reference": "" }],
          "points_positifs": ["Point 1"],
          "recommandations": ["Action 1"],
          "resume": "2-3 phrases"
        }`
      },
      { role: "user", content: `Analyse ce document "${nomFichier}" :\n\n${contenu}` }
    ];

    const raw = await callOpenAI(messages, 1000);
    const analyse = JSON.parse(cleanJSON(raw));

    let analyseId = null;
    try {
      const saved = await sbInsert("analyses", {
        user_id: userId, nom_fichier: nomFichier,
        type_document: analyse.type_document || "Document",
        score: analyse.score, problemes: analyse.problemes,
        recommandations: analyse.recommandations, resume: analyse.resume,
        points_positifs: analyse.points_positifs
      });
      analyseId = saved?.id;
    } catch(e) { console.warn("⚠️ Sauvegarde analyse échouée:", e.message); }

    console.log(`✅ Analyse: ${nomFichier} — Score: ${analyse.score}`);
    res.json({ ...analyse, id: analyseId, nomFichier });
  } catch(e) {
    console.error("❌ Erreur analyse:", e);
    res.status(500).json({ error: "Erreur lors de l'analyse", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HISTORIQUE ANALYSES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/api/analyses/:userId", async (req, res) => {
  try {
    const r = await sbGet("analyses", `?user_id=eq.${req.params.userId}&order=created_at.desc&limit=50`);
    res.json(r || []);
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GÉNÉRER UN DOCUMENT JURIDIQUE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/generer-document", async (req, res) => {
  try {
    const { type, entreprise, activite, userId, plan } = req.body;
    if (!type) return res.status(400).json({ error: "Type de document manquant" });
    const planOk = ['starter','business','pro','expert'].includes(plan);
    if (!planOk) return res.status(403).json({ error: "Cette fonctionnalité nécessite un abonnement.", planRequis: 'starter' });

    const typesDisponibles = {
      confidentialite: "Politique de confidentialité conforme au RGPD",
      mentions: "Mentions légales complètes",
      cookies: "Politique de gestion des cookies",
      cgu: "Conditions générales d'utilisation",
      cgv: "Conditions générales de vente",
      nda: "Accord de non-divulgation (NDA)",
      registre: "Registre des activités de traitement RGPD (Article 30)"
    };

    const messages = [
      {
        role: "system",
        content: `Tu es un juriste spécialisé en droit européen.
        Réponds UNIQUEMENT en JSON valide sans markdown :
        {
          "titre": "Titre du document",
          "contenu": "Contenu complet (utilise \\n pour les sauts de ligne)",
          "avertissement": "Note sur les limites"
        }`
      },
      {
        role: "user",
        content: `Génère une ${typesDisponibles[type] || type} pour :
        - Entreprise : ${entreprise || "PME française"}
        - Secteur : ${activite || "Services numériques"}
        Document complet, conforme au droit français et européen.`
      }
    ];

    const raw = await callOpenAI(messages, 1500);
    const doc = JSON.parse(cleanJSON(raw));

    if (userId) {
      try {
        await sbInsert("documents_generes", { user_id: userId, type_document: type, titre: doc.titre, contenu: doc.contenu });
      } catch(e) { console.warn("⚠️ Sauvegarde document échouée"); }
    }

    res.json(doc);
  } catch(e) {
    console.error("❌ Erreur génération:", e);
    res.status(500).json({ error: "Erreur lors de la génération", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HISTORIQUE DOCUMENTS GÉNÉRÉS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/api/documents/:userId", async (req, res) => {
  try {
    const r = await sbGet("documents_generes", `?user_id=eq.${req.params.userId}&order=created_at.desc`);
    res.json(r || []);
  } catch(e) { res.status(500).json({ error: String(e) }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ASSISTANT IA (CHAT)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], userId, plan } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });
    const plansChat = ['business','pro','expert'];
    if (userId && !plansChat.includes(plan)) return res.status(403).json({ error: "L'assistant est disponible à partir du plan Business.", planRequis: 'business' });

    const messages = [
      {
        role: "system",
        content: `Tu es l'assistant conformité Audilix. Tu aides les PME françaises sur le RGPD, la cybersécurité, le RSE et l'AI Act.
        Réponds en français, de manière claire et professionnelle. Pour les questions juridiques complexes, recommande un avocat.`
      },
      ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ];

    const reponse = await callOpenAI(messages, 250);
    res.json({ reponse });
  } catch(e) {
    console.error("❌ Chat error:", e);
    res.status(500).json({ error: "Erreur assistant", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STRIPE — CRÉER SESSION CHECKOUT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/stripe/checkout", async (req, res) => {
  try {
    const { priceId, plan, userId, email } = req.body;
    if (!priceId) return res.status(400).json({ error: "priceId manquant" });

    const paramsObj = {
      "payment_method_types[0]": "card",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "mode": "subscription",
      "success_url": "https://audilix.com/dashboard.html?payment=success",
      "cancel_url": "https://audilix.com/pricing.html?payment=cancelled",
      "metadata[userId]": userId || "",
      "metadata[plan]": plan || ""
    };
    if (email) paramsObj["customer_email"] = email;
    const params = new URLSearchParams(paramsObj);

    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const session = await r.json();
    if (session.error) return res.status(400).json({ error: session.error.message });
    res.json({ url: session.url });
  } catch(e) {
    console.error("❌ Stripe checkout error:", e);
    res.status(500).json({ error: e.message || "Erreur paiement" });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STRIPE — WEBHOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    let event;

    // Vérifier la signature Stripe si le secret est configuré
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers["stripe-signature"];
      // Vérification manuelle de la signature (sans SDK Stripe)
      try {
        const payload = req.body.toString("utf8");
        const parts = sig.split(",");
        const timestamp = parts.find(p => p.startsWith("t="))?.split("=")[1];
        const signedPayload = `${timestamp}.${payload}`;
        const crypto = await import("crypto");
        const expectedSig = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
          .update(signedPayload).digest("hex");
        const receivedSig = parts.find(p => p.startsWith("v1="))?.split("=")[1];
        if (expectedSig !== receivedSig) {
          console.warn("⚠️ Signature webhook invalide");
          return res.status(400).json({ error: "Signature invalide" });
        }
      } catch(sigErr) {
        console.warn("⚠️ Erreur vérification signature:", sigErr.message);
      }
    }

    event = JSON.parse(req.body);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId  = session.metadata?.userId;
      const plan    = session.metadata?.plan;
      const email   = session.customer_email || session.customer_details?.email;

      console.log(`📦 Webhook reçu: ${event.type} — userId:${userId} plan:${plan}`);

      if (userId && SUPABASE_URL) {
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
            method: "PATCH",
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": `Bearer ${SUPABASE_KEY}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal"
            },
            body: JSON.stringify({ plan, stripe_customer_id: session.customer })
          });
          if (r.ok) {
            console.log(`✅ Plan mis à jour: ${userId} → ${plan}`);
          } else {
            console.warn(`⚠️ Échec mise à jour plan [${r.status}]`);
          }
        } catch(e) { console.warn("⚠️ Erreur mise à jour plan:", e.message); }
      }

      if (email) {
        const planNames = { starter: "Essentiel", business: "Professionnel", expert: "Entreprise" };
        await sendEmail(
          email,
          `Bienvenue sur Audilix — Plan ${planNames[plan] || plan}`,
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#0B2545;color:white;padding:40px;border-radius:12px;">
            <h1 style="color:#C9A84C;">Bienvenue sur Audilix !</h1>
            <p style="color:rgba(255,255,255,0.8);">Votre abonnement <strong style="color:#C9A84C;">${planNames[plan] || plan}</strong> est activé.</p>
            <a href="https://audilix.com/dashboard.html" style="display:inline-block;background:#C9A84C;color:#0B2545;padding:14px 30px;border-radius:6px;text-decoration:none;font-weight:700;margin-top:16px;">Accéder au dashboard →</a>
          </div>`
        );
      }
    }

    res.json({ received: true });
  } catch(e) {
    console.error("❌ Stripe webhook error:", e);
    res.status(400).json({ error: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RÉSUMÉ DE CONTRAT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/resumer-contrat", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Aucun document fourni" });

    let contenu = "";
    if (req.file.mimetype === "text/plain") {
      contenu = req.file.buffer.toString("utf-8").substring(0, 8000);
    } else {
      contenu = cleanBuffer(req.file.buffer);
    }

    if (!contenu || contenu.trim().length < 50) {
      return res.status(400).json({ error: "Document illisible. Essayez un fichier .txt" });
    }

    const messages = [
      {
        role: "system",
        content: `Tu es un juriste expert. Résume ce document en points clés.
        Réponds UNIQUEMENT en JSON valide sans markdown :
        {
          "titre": "Titre court",
          "type": "Type de document identifié",
          "points_cles": ["Point 1", "Point 2", "Point 3", "Point 4", "Point 5"],
          "points_vigilance": ["Point à surveiller 1", "Point à surveiller 2"],
          "duree": "Durée ou échéances si applicable",
          "resume_global": "Résumé en 2-3 phrases"
        }`
      },
      { role: "user", content: `Résume ce document :\n\n${contenu}` }
    ];

    const raw = await callOpenAI(messages, 800);
    res.json(JSON.parse(cleanJSON(raw)));
  } catch(e) {
    console.error("❌ Résumé contrat error:", e);
    res.status(500).json({ error: "Erreur lors du résumé", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DÉTECTION DE CLAUSES ABUSIVES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/detecter-clauses", upload.single("document"), async (req, res) => {
  try {
    const plan = req.body.plan || 'essai';
    const userId = req.body.userId;
    if (!req.file) return res.status(400).json({ error: "Aucun document fourni" });
    const plansClauses = ['business','pro','expert'];
    if (!plansClauses.includes(plan)) return res.status(403).json({ error: "La détection de clauses abusives est disponible à partir du plan Business.", planRequis: 'business' });

    const contenu = cleanBuffer(req.file.buffer);
    if (!contenu || contenu.trim().length < 50) {
      return res.status(400).json({ error: "Document illisible." });
    }

    const messages = [
      {
        role: "system",
        content: `Tu es un avocat spécialisé en droit des contrats français.
        Détecte les clauses problématiques, abusives ou illégales.
        Réponds UNIQUEMENT en JSON valide sans markdown :
        {
          "score_equite": 75,
          "clauses_abusives": [
            {
              "clause": "Extrait ou description",
              "probleme": "Pourquoi c'est problématique",
              "gravite": "critique|important|mineur",
              "reference_legale": "Article applicable"
            }
          ],
          "clauses_manquantes": ["Clause manquante 1"],
          "recommandations": ["Recommandation 1"],
          "resume": "Bilan en 2-3 phrases"
        }`
      },
      { role: "user", content: `Analyse ce contrat :\n\n${contenu}` }
    ];

    const raw = await callOpenAI(messages, 1000);
    res.json(JSON.parse(cleanJSON(raw)));
  } catch(e) {
    console.error("❌ Détection clauses error:", e);
    res.status(500).json({ error: "Erreur lors de l'analyse", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REGISTRE DES TRAITEMENTS RGPD (Article 30)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/registre-traitements", async (req, res) => {
  try {
    const { entreprise, activite, responsable, destinataires, pays, donneesCollectees, userId, plan } = req.body;
    if (!entreprise) return res.status(400).json({ error: "Informations manquantes" });
    const plansRegistre = ['business','pro','expert'];
    if (!plansRegistre.includes(plan)) return res.status(403).json({ error: "Le registre RGPD est disponible à partir du plan Business.", planRequis: 'business' });

    const today = new Date().toLocaleDateString("fr-FR");

    const messages = [
      {
        role: "system",
        content: `Tu es un DPO expert RGPD. Génère un registre des activités de traitement conforme à l'article 30 du RGPD.
        Réponds UNIQUEMENT en JSON valide sans markdown :
        {
          "titre": "Registre des activités de traitement",
          "date_creation": "${today}",
          "traitements": [
            {
              "nom": "Nom du traitement",
              "finalite": "Finalité",
              "base_legale": "Base légale",
              "categories_donnees": ["Donnée 1", "Donnée 2"],
              "destinataires": ["Destinataire 1"],
              "duree_conservation": "Durée",
              "mesures_securite": "Mesures techniques"
            }
          ],
          "responsable": "Responsable : ${entreprise}",
          "avertissement": "Ce registre est généré automatiquement. Il doit être validé par votre DPO ou un juriste."
        }`
      },
      {
        role: "user",
        content: `Génère un registre RGPD pour :
        - Entreprise : ${entreprise}
        - Activité : ${activite || "Non précisée"}
        Génère entre 4 et 8 traitements réalistes selon le secteur.`
      }
    ];

    const raw = await callOpenAI(messages, 1500);
    res.json(JSON.parse(cleanJSON(raw)));
  } catch(e) {
    console.error("❌ Registre traitements error:", e);
    res.status(500).json({ error: "Erreur lors de la génération", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HEALTH CHECK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ESSAI GRATUIT — Inscription après analyse
// Crée le compte, sauvegarde l'analyse, envoie les identifiants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/api/essai-inscription", async (req, res) => {
  try {
    const { email, analyseData } = req.body;
    if (!email) return res.status(400).json({ error: "Email requis" });

    // Vérifier si compte existe déjà
    const existing = await sbGet("users", `?email=eq.${encodeURIComponent(email)}`);
    if (existing && existing.length > 0) {
      // Compte déjà existant — on ne connecte JAMAIS automatiquement sans mot de passe (sécurité).
      // On sauvegarde quand même l'analyse sur le compte existant pour qu'elle soit retrouvable après connexion.
      const existingUser = existing[0];
      if (analyseData && existingUser.id) {
        try {
          await sbInsert("analyses", {
            user_id: existingUser.id,
            nom_fichier: analyseData.nom_fichier || "Document essai",
            type_document: analyseData.type_document || "Document",
            score: analyseData.score || 0,
            resume: analyseData.resume || "",
            problemes: analyseData.problemes || [],
            points_positifs: analyseData.points_positifs || [],
            recommandations: analyseData.recommandations || []
          });
        } catch(e) {
          console.warn("⚠️ Analyse (compte existant) non sauvegardée:", e.message);
        }
      }
      return res.json({
        success: true,
        dejaClient: true,
        message: "Un compte existe déjà avec cet email. Connectez-vous pour retrouver votre historique."
      });
    }

    // Générer un mot de passe temporaire lisible
    const motsPasse = ["Confor", "Secure", "Audit", "Legal", "Rgpd"];
    const nums = Math.floor(1000 + Math.random() * 9000);
    const mdpClair = motsPasse[Math.floor(Math.random() * motsPasse.length)] + nums + "!";

    // Créer le compte Essai
    const user = await sbInsert("users", {
      email,
      password_hash: hashPassword(mdpClair),
      firstname: "",
      lastname: "",
      plan: "essai"
    });

    if (!user || !user.id) {
      return res.status(500).json({ error: "Erreur création du compte" });
    }

    // Sauvegarder l'analyse en base si fournie
    if (analyseData && user.id) {
      try {
        await sbInsert("analyses", {
          user_id: user.id,
          nom_fichier: analyseData.nom_fichier || "Document essai",
          type_document: analyseData.type_document || "Document",
          score: analyseData.score || 0,
          resume: analyseData.resume || "",
          problemes: analyseData.problemes || [],
          points_positifs: analyseData.points_positifs || [],
          recommandations: analyseData.recommandations || []
        });
      } catch(e) {
        console.warn("⚠️ Analyse non sauvegardée:", e.message);
      }
    }

    const token = generateToken(user.id);

    // Email de bienvenue avec identifiants
    const score = analyseData ? analyseData.score : null;
    const nbProblemes = analyseData && analyseData.problemes ? analyseData.problemes.length : 0;
    const scoreColor = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";
    const scoreTexte = score !== null ? `<div style="text-align:center;margin:20px 0;padding:20px;background:#0F2456;border-radius:8px;"><div style="font-size:13px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Votre score de conformité</div><div style="font-size:52px;font-weight:700;color:${scoreColor};line-height:1;">${score}</div><div style="color:rgba(255,255,255,0.4);font-size:13px;">/100 — ${nbProblemes} problème(s) détecté(s)</div></div>` : "";

    // Construire les blocs problèmes pour l'email
    const scoreLabel = score >= 80 ? 'Conforme' : score >= 60 ? 'Conforme avec réserves' : score >= 40 ? 'Non conforme' : 'Risque élevé';
    const scoreColEmail = score >= 80 ? '#16a34a' : score >= 60 ? '#f59e0b' : score >= 40 ? '#ea580c' : '#dc2626';
    const scoreBgEmail = score >= 80 ? '#f0fdf4' : score >= 60 ? '#fffbeb' : score >= 40 ? '#fff7ed' : '#fef2f2';

    let problemesHTML = '';
    if (analyseData && analyseData.problemes && analyseData.problemes.length > 0) {
      const probsAffichés = analyseData.problemes.slice(0,5);
      problemesHTML = probsAffichés.map(p => {
        const gc = p.gravite === 'critique' ? { col:'#dc2626', bg:'#fef2f2', label:'CRITIQUE' }
                 : p.gravite === 'important' ? { col:'#ea580c', bg:'#fff7ed', label:'IMPORTANT' }
                 : { col:'#a16207', bg:'#fefce8', label:'MODÉRÉ' };
        return `<div style="margin-bottom:10px;background:${gc.bg};border-left:3px solid ${gc.col};border-radius:0 6px 6px 0;padding:12px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="font-size:13px;font-weight:700;color:#0B2545;margin-bottom:4px;">${p.titre || ''}</div>
            <span style="background:${gc.col};color:white;font-size:9px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap;flex-shrink:0;">${gc.label}</span>
          </div>
          <div style="font-size:12px;color:#4B5563;line-height:1.6;">${(p.description || '').substring(0,160)}${(p.description||'').length > 160 ? '…' : ''}</div>
          ${p.article_reference ? `<div style="font-size:11px;color:#6366f1;margin-top:6px;font-style:italic;">⚖ ${p.article_reference}</div>` : ''}
        </div>`;
      }).join('');
      if (analyseData.problemes.length > 5) {
        problemesHTML += `<div style="text-align:center;font-size:12px;color:#6B7280;padding:8px;">+ ${analyseData.problemes.length - 5} autre(s) problème(s) dans votre rapport complet</div>`;
      }
    }

    let recosHTML = '';
    if (analyseData && analyseData.recommandations && analyseData.recommandations.length > 0) {
      recosHTML = analyseData.recommandations.slice(0,4).map((r,i) =>
        `<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;">
          <div style="width:20px;height:20px;background:#EEF2FF;border:1.5px solid #6366f1;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#6366f1;">${i+1}</div>
          <div style="font-size:12px;color:#374151;line-height:1.6;">${r}</div>
        </div>`
      ).join('');
    }

    await sendEmail(
      email,
      "Votre rapport de conformité — " + scoreLabel + " (" + score + "/100)",
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
      <div style="max-width:620px;margin:32px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- HEADER NAVY -->
        <div style="background:#0B2545;padding:0;">
          <div style="padding:28px 36px 20px;border-bottom:2px solid #C9A84C;">
            <table width="100%" cellpadding="0" cellspacing="0"><tr>
              <td><div style="font-size:22px;font-weight:800;color:white;letter-spacing:-0.02em;">AUDILIX</div>
                  <div style="font-size:11px;color:#C9A84C;margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Rapport de conformité réglementaire</div></td>
              <td align="right" style="vertical-align:top;"><div style="font-size:11px;color:rgba(255,255,255,0.4);">${new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'})}</div></td>
            </tr></table>
          </div>

          <!-- SCORE BLOC -->
          <div style="padding:24px 36px;display:flex;align-items:center;gap:20px;">
            <div style="width:72px;height:72px;border-radius:50%;background:${scoreBgEmail};border:3px solid ${scoreColEmail};display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
              <div style="font-size:22px;font-weight:800;color:${scoreColEmail};line-height:1;">${score}</div>
              <div style="font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:0.05em;">/100</div>
            </div>
            <div>
              <div style="display:inline-block;background:${scoreBgEmail};color:${scoreColEmail};font-size:10px;font-weight:700;padding:3px 12px;border-radius:20px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">${scoreLabel}</div>
              <div style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.6;">${(analyseData && analyseData.resume ? analyseData.resume.substring(0,180) : 'Analyse de conformité disponible dans votre espace client.')}${analyseData && analyseData.resume && analyseData.resume.length > 180 ? '…' : ''}</div>
            </div>
          </div>

          <!-- STATS -->
          <div style="padding:0 36px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:6px 0;">
              <tr>
                <td style="background:rgba(220,38,38,0.15);border-radius:6px;padding:10px;text-align:center;width:25%;">
                  <div style="font-size:20px;font-weight:800;color:#fca5a5;">${analyseData ? (analyseData.problemes||[]).filter(p=>p.gravite==='critique').length : 0}</div>
                  <div style="font-size:9px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.06em;">Critiques</div>
                </td>
                <td style="background:rgba(234,88,12,0.15);border-radius:6px;padding:10px;text-align:center;width:25%;">
                  <div style="font-size:20px;font-weight:800;color:#fdba74;">${analyseData ? (analyseData.problemes||[]).filter(p=>p.gravite==='important').length : 0}</div>
                  <div style="font-size:9px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.06em;">Importants</div>
                </td>
                <td style="background:rgba(22,163,74,0.15);border-radius:6px;padding:10px;text-align:center;width:25%;">
                  <div style="font-size:20px;font-weight:800;color:#86efac;">${analyseData ? (analyseData.points_positifs||[]).length : 0}</div>
                  <div style="font-size:9px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.06em;">Conformes</div>
                </td>
                <td style="background:rgba(99,102,241,0.15);border-radius:6px;padding:10px;text-align:center;width:25%;">
                  <div style="font-size:20px;font-weight:800;color:#a5b4fc;">${analyseData ? (analyseData.recommandations||[]).length : 0}</div>
                  <div style="font-size:9px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.06em;">Recos</div>
                </td>
              </tr>
            </table>
          </div>
        </div>

        <!-- CORPS -->
        <div style="padding:32px 36px;">

          ${problemesHTML.length > 0 ? `
          <div style="margin-bottom:28px;">
            <div style="font-size:13px;font-weight:700;color:#0B2545;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #E5E7EB;">Problèmes détectés</div>
            ${problemesHTML}
          </div>` : ''}

          ${recosHTML.length > 0 ? `
          <div style="margin-bottom:28px;">
            <div style="font-size:13px;font-weight:700;color:#0B2545;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #E5E7EB;">Plan d'action</div>
            ${recosHTML}
          </div>` : ''}

          <!-- IDENTIFIANTS -->
          <div style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:20px;margin-bottom:24px;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6B7280;margin-bottom:14px;">Vos identifiants de connexion</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:6px 0;border-bottom:1px solid #F3F4F6;">
                <span style="color:#6B7280;font-size:12px;">Email</span>
              </td><td align="right" style="padding:6px 0;border-bottom:1px solid #F3F4F6;">
                <strong style="color:#0B2545;font-size:12px;">${email}</strong>
              </td></tr>
              <tr><td style="padding:8px 0 0;">
                <span style="color:#6B7280;font-size:12px;">Mot de passe temporaire</span>
              </td><td align="right" style="padding:8px 0 0;">
                <strong style="color:#0B2545;font-size:15px;letter-spacing:0.08em;font-family:monospace;">${mdpClair}</strong>
              </td></tr>
            </table>
            <div style="font-size:11px;color:#9CA3AF;margin-top:12px;">Modifiez votre mot de passe dans les paramètres de votre compte après connexion.</div>
          </div>

          <!-- CTA -->
          <div style="text-align:center;margin-bottom:8px;">
            <a href="https://audilix.com/login.html" style="display:inline-block;background:#0B2545;color:white;padding:15px 36px;border-radius:6px;font-size:14px;font-weight:700;text-decoration:none;">Accéder à mon rapport complet →</a>
          </div>
          <div style="text-align:center;">
            <a href="https://audilix.com/pricing.html" style="display:inline-block;color:#C9A84C;font-size:12px;font-weight:600;text-decoration:underline;text-underline-offset:3px;">Voir les plans disponibles</a>
          </div>
        </div>

        <!-- FOOTER -->
        <div style="background:#F8FAFC;border-top:1px solid #E5E7EB;padding:16px 36px;text-align:center;">
          <div style="font-size:11px;color:#9CA3AF;line-height:1.7;">
            © 2026 Audilix · SIRET 10452924300016<br>
            Ce rapport est généré automatiquement à titre informatif et ne remplace pas un avis juridique professionnel.<br>
            <a href="https://audilix.com" style="color:#C9A84C;text-decoration:none;">audilix.com</a>
          </div>
        </div>
      </div>
      </body></html>`
    );

    // Programmer email de relance J+1 (via flag en base)
    try {
      await sbInsert("relances_email", {
        user_id: user.id,
        email: email,
        type: "relance_j1",
        score: score,
        nb_problemes: nbProblemes,
        envoyer_le: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        envoye: false
      });
    } catch(e) {
      console.warn("⚠️ Relance non programmée (table manquante?):", e.message);
    }

    const { password_hash, ...safeUser } = user;
    console.log(`✅ Essai inscrit: ${email} — score: ${score}`);
    res.json({ success: true, token, user: safeUser, mdp: mdpClair });

  } catch(e) {
    console.error("❌ Essai inscription error:", e);
    res.status(500).json({ error: "Erreur serveur", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EMAIL RELANCE J+1 — À appeler par un cron ou manuellement
// GET /api/envoyer-relances
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get("/api/envoyer-relances", async (req, res) => {
  try {
    const now = new Date().toISOString();
    const relances = await sbGet("relances_email", `?envoye=eq.false&envoyer_le=lte.${now}`);
    
    if (!Array.isArray(relances) || relances.length === 0) {
      return res.json({ envoyes: 0, message: "Aucune relance à envoyer" });
    }

    let envoyes = 0;
    for (const r of relances) {
      const scoreColor = r.score >= 70 ? "#22c55e" : r.score >= 40 ? "#f59e0b" : "#ef4444";
      await sendEmail(
        r.email,
        `⚠️ Vos ${r.nb_problemes} risques Audilix sont toujours non corrigés`,
        `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#FAF8F4;border-radius:12px;overflow:hidden;">
          <div style="background:#0B2545;padding:32px 40px;text-align:center;">
            <div style="font-size:28px;font-weight:700;color:#C9A84C;">Audilix</div>
          </div>
          <div style="padding:32px 40px;">
            <h2 style="color:#0B2545;font-size:20px;margin-bottom:12px;">Vos risques n'ont pas disparu.</h2>
            <p style="color:#6B7280;font-size:14px;line-height:1.7;margin-bottom:20px;">Hier, votre analyse a révélé <strong style="color:#0B2545;">${r.nb_problemes} problème(s)</strong> avec un score de <strong style="color:${scoreColor};">${r.score}/100</strong>. Chaque jour sans correction, c'est un risque d'amende qui reste ouvert.</p>
            <div style="background:#fff3cd;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin-bottom:20px;">
              <div style="font-size:13px;color:#92400e;font-weight:600;">💡 Le saviez-vous ?</div>
              <div style="font-size:13px;color:#78350f;margin-top:4px;">La CNIL peut sanctionner une PME jusqu'à 20 000€ pour une politique de confidentialité non conforme.</div>
            </div>
            <div style="text-align:center;margin:24px 0;">
              <a href="https://audilix.com/login.html" style="display:inline-block;background:#C9A84C;color:#0B2545;padding:14px 32px;border-radius:6px;font-size:14px;font-weight:700;text-decoration:none;">Corriger mes risques maintenant →</a>
            </div>
            <p style="color:#9CA3AF;font-size:12px;text-align:center;">À partir de 69€/mois · Sans engagement · Accès immédiat</p>
          </div>
        </div>`
      );

      // Marquer comme envoyé
      await fetch(`${SUPABASE_URL}/rest/v1/relances_email?id=eq.${r.id}`, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ envoye: true, envoye_le: new Date().toISOString() })
      });
      envoyes++;
    }

    console.log(`✅ ${envoyes} relance(s) envoyée(s)`);
    res.json({ envoyes, message: `${envoyes} email(s) envoyé(s)` });
  } catch(e) {
    console.error("❌ Relances error:", e);
    res.status(500).json({ error: String(e) });
  }
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PARAMÈTRES UTILISATEUR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Mettre à jour l'email
app.post("/api/user/update", async (req, res) => {
  try {
    const { userId, email } = req.body;
    if (!userId || !email) return res.status(400).json({ error: "Données manquantes" });

    // Vérifier que l'email n'est pas déjà pris
    const existing = await sbGet("users", `?email=eq.${encodeURIComponent(email)}&id=neq.${userId}`);
    if (existing && existing.length > 0) return res.status(400).json({ error: "Cet email est déjà utilisé par un autre compte" });

    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });

    console.log(`✅ Email mis à jour: ${userId}`);
    res.json({ success: true });
  } catch(e) {
    console.error("❌ Update email error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Changer le mot de passe
app.post("/api/user/update-name", async (req, res) => {
  try {
    const { userId, firstname, lastname } = req.body;
    if (!userId) return res.status(400).json({ error: "userId requis" });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
      body: JSON.stringify({ firstname: firstname || '', lastname: lastname || '' })
    });
    if (!r.ok) return res.status(500).json({ error: "Erreur mise à jour" });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/user/change-password", async (req, res) => {
  try {
    const { userId, ancienMdp, nouveauMdp } = req.body;
    if (!userId || !ancienMdp || !nouveauMdp) return res.status(400).json({ error: "Données manquantes" });
    if (nouveauMdp.length < 8) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères" });

    // Vérifier l'ancien mot de passe
    const users = await sbGet("users", `?id=eq.${userId}`);
    if (!users || users.length === 0) return res.status(404).json({ error: "Compte introuvable" });

    const user = users[0];
    if (user.password_hash !== hashPassword(ancienMdp)) {
      return res.status(400).json({ error: "Mot de passe actuel incorrect" });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password_hash: hashPassword(nouveauMdp) })
    });

    console.log(`✅ Mot de passe changé: ${userId}`);
    res.json({ success: true });
  } catch(e) {
    console.error("❌ Change password error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Supprimer le compte
app.delete("/api/user/delete", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "Utilisateur manquant" });

    // Supprimer analyses, documents, relances puis le compte
    await fetch(`${SUPABASE_URL}/rest/v1/analyses?user_id=eq.${userId}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } });
    await fetch(`${SUPABASE_URL}/rest/v1/documents_generes?user_id=eq.${userId}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } });
    await fetch(`${SUPABASE_URL}/rest/v1/relances_email?user_id=eq.${userId}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } });
    await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, { method: "DELETE", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } });

    console.log(`✅ Compte supprimé: ${userId}`);
    res.json({ success: true });
  } catch(e) {
    console.error("❌ Delete account error:", e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


app.get("/api/ping", (req, res) => {
  const config = {
    status: "ok",
    ts: Date.now(),
    env: {
      supabase: !!SUPABASE_URL && !!SUPABASE_KEY,
      openai: !!OPENAI_KEY,
      stripe: !!STRIPE_SECRET,
      resend: !!RESEND_KEY
    }
  };
  res.json(config);
});

app.get("/", (req, res) => {
  res.json({ status: "Audilix backend en ligne ✅", version: "5.0" });
});

const PORT = process.env.PORT || 3000;

// Vérification des variables d'environnement critiques
const VARS_REQUISES = ['SUPABASE_URL','SUPABASE_SERVICE_KEY','OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
const VARS_MANQUANTES = VARS_REQUISES.filter(v => !process.env[v]);
if (VARS_MANQUANTES.length > 0) {
  console.error('❌ Variables d\'environnement manquantes:', VARS_MANQUANTES.join(', '));
}

app.listen(PORT, () => {
  console.log("🚀 Audilix backend v5.0 en ligne sur le port", PORT);
  if (VARS_MANQUANTES.length === 0) {
    console.log("✅ Toutes les variables d'environnement sont configurées");
  }
});
