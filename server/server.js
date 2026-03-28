import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const FROM_EMAIL    = "Audilix <onboarding@resend.dev>";

// Limites par plan
const LIMITES_PLAN = {
  starter:  10,
  business: -1,
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
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
  });
  return r.json();
}

async function sbInsert(table, data) {
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
    const { type, entreprise, activite, userId } = req.body;
    if (!type) return res.status(400).json({ error: "Type de document manquant" });

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
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

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

    const params = new URLSearchParams({
      "payment_method_types[0]": "card",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "mode": "subscription",
      "success_url": "https://audilix.com/dashboard.html?payment=success",
      "cancel_url": "https://audilix.com/pricing.html?payment=cancelled",
      "metadata[userId]": userId || "",
      "metadata[plan]": plan || "",
      "customer_email": email || ""
    });

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
    res.status(500).json({ error: "Erreur paiement", details: String(e) });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STRIPE — WEBHOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = JSON.parse(req.body);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId  = session.metadata?.userId;
      const plan    = session.metadata?.plan;
      const email   = session.customer_email || session.customer_details?.email;

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
    if (!req.file) return res.status(400).json({ error: "Aucun document fourni" });

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
    const { entreprise, activite } = req.body;
    if (!entreprise) return res.status(400).json({ error: "Informations manquantes" });

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
app.get("/", (req, res) => {
  res.json({ status: "Audilix backend en ligne ✅", version: "5.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Audilix backend v5.0 en ligne sur le port", PORT));
