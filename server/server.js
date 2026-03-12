import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

// ─── Envoi email ───────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
});

async function sendReportEmail(toEmail, companyName, report) {
  const { score, risques, recommandations, résumé } = report;

  const risquesHtml = risques
    .map((r) => `<li style="margin-bottom:6px;">⚠️ ${r}</li>`)
    .join("");

  const recoHtml = recommandations
    .map((r) => `<li style="margin-bottom:6px;">✅ ${r}</li>`)
    .join("");

  const scoreColor = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";

  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 640px; margin: auto; background: #0f172a; color: #e2e8f0; border-radius: 12px; overflow: hidden;">
    
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #1e293b, #0f172a); padding: 32px; text-align: center; border-bottom: 1px solid #334155;">
      <h1 style="margin: 0; font-size: 28px; color: #ffffff; letter-spacing: 2px;">AUDILIX</h1>
      <p style="margin: 8px 0 0; color: #94a3b8; font-size: 13px;">Rapport d'audit de conformité IA</p>
    </div>

    <!-- Score -->
    <div style="padding: 32px; text-align: center;">
      <p style="margin: 0 0 8px; color: #94a3b8; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Score de conformité</p>
      <div style="display: inline-block; background: ${scoreColor}22; border: 3px solid ${scoreColor}; border-radius: 50%; width: 100px; height: 100px; line-height: 100px; font-size: 32px; font-weight: bold; color: ${scoreColor};">
        ${score}
      </div>
      <p style="margin: 16px 0 0; color: #94a3b8; font-size: 13px;">sur 100 — ${companyName}</p>
    </div>

    <!-- Résumé -->
    <div style="padding: 0 32px 24px;">
      <h2 style="color: #e2e8f0; font-size: 16px; border-left: 3px solid #6366f1; padding-left: 12px;">Analyse</h2>
      <p style="color: #94a3b8; font-size: 14px; line-height: 1.7;">${résumé}</p>
    </div>

    <!-- Risques -->
    <div style="padding: 0 32px 24px;">
      <h2 style="color: #e2e8f0; font-size: 16px; border-left: 3px solid #ef4444; padding-left: 12px;">Risques identifiés</h2>
      <ul style="color: #94a3b8; font-size: 14px; line-height: 1.7; padding-left: 16px;">${risquesHtml}</ul>
    </div>

    <!-- Recommandations -->
    <div style="padding: 0 32px 32px;">
      <h2 style="color: #e2e8f0; font-size: 16px; border-left: 3px solid #22c55e; padding-left: 12px;">Recommandations prioritaires</h2>
      <ul style="color: #94a3b8; font-size: 14px; line-height: 1.7; padding-left: 16px;">${recoHtml}</ul>
    </div>

    <!-- CTA -->
    <div style="padding: 24px 32px; text-align: center; background: #1e293b; border-top: 1px solid #334155;">
      <p style="color: #94a3b8; font-size: 13px; margin: 0 0 16px;">Passez à l'action avec un plan complet</p>
      <a href="https://audilix.onrender.com/#tarifs" style="background: #6366f1; color: #ffffff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 14px;">Voir nos offres →</a>
    </div>

    <!-- Footer -->
    <div style="padding: 20px; text-align: center;">
      <p style="color: #475569; font-size: 12px; margin: 0;">© 2026 AUDILIX — contact.audilix@gmail.com</p>
    </div>
  </div>
  `;

  await transporter.sendMail({
    from: `"Audilix IA" <${GMAIL_USER}>`,
    to: toEmail,
    subject: `🔍 Votre rapport Audilix — Score ${score}/100`,
    html,
  });
}

// ─── Appel OpenAI ──────────────────────────────────────────────
async function callOpenAI(messages) {
  // MODE MOCK si pas de clé OpenAI (pour tester)
  if (!OPENAI_KEY || OPENAI_KEY === "mock") {
    return JSON.stringify({
      score: 62,
      risques: [
        "Absence de politique RGPD formalisée",
        "Pas de DPO désigné",
        "Sauvegardes non chiffrées",
      ],
      recommandations: [
        "Nommer un DPO ou référent conformité",
        "Mettre en place un registre des traitements",
        "Chiffrer les sauvegardes et tester les restaurations",
      ],
      résumé:
        "Votre entreprise présente un niveau de conformité intermédiaire. Plusieurs points critiques nécessitent une attention immédiate, notamment sur la protection des données personnelles et la sécurité informatique.",
    });
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.15,
      max_tokens: 900,
    }),
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

function buildPrompt(p) {
  return [
    {
      role: "system",
      content:
        "Tu es un expert en conformité (RGPD, cybersécurité, RSE, ISO). Renvoie UNIQUEMENT un JSON valide sans markdown avec : score (0-100), risques (array de strings), recommandations (array de strings), résumé (string détaillé).",
    },
    { role: "user", content: JSON.stringify(p) },
  ];
}

// ─── Route audit direct (depuis le site) ──────────────────────
app.post("/api/audit", async (req, res) => {
  try {
    const messages = buildPrompt(req.body);
    const raw = await callOpenAI(messages);
    const clean = raw.replace(/```json|```/g, "").trim();
    res.json(JSON.parse(clean));
  } catch (e) {
    res.status(500).json({ error: "Erreur IA", details: String(e) });
  }
});

// ─── Webhook Tally ─────────────────────────────────────────────
app.post("/webhook/tally", async (req, res) => {
  try {
    const body = req.body;
    const fields = body?.data?.fields || [];

    // Extraire les réponses du formulaire Tally
    const getValue = (label) => {
      const field = fields.find((f) =>
        f.label?.toLowerCase().includes(label.toLowerCase())
      );
      if (!field) return null;
      if (Array.isArray(field.value)) {
        return field.value
          .map((v) => {
            const opt = field.options?.find((o) => o.id === v);
            return opt ? opt.text : v;
          })
          .join(", ");
      }
      return field.value;
    };

    const companyName = getValue("nom de votre entreprise") || "Entreprise";
    const secteur = getValue("secteur") || "Non précisé";
    const taille = getValue("taille") || "Non précisé";
    const domaines = getValue("domaines") || "Non précisé";
    const dpo = getValue("responsable conformité") || "Non précisé";
    const clientEmail = getValue("e-mail") || getValue("email");

    if (!clientEmail) {
      return res.status(400).json({ error: "Email client introuvable" });
    }

    // Construire les données pour l'IA
    const auditData = {
      entreprise: companyName,
      secteur,
      taille,
      domaines_concernés: domaines,
      a_dpo_ou_responsable_conformité: dpo,
    };

    // Générer le rapport IA
    const messages = buildPrompt(auditData);
    const raw = await callOpenAI(messages);
    const clean = raw.replace(/```json|```/g, "").trim();
    const report = JSON.parse(clean);

    // Envoyer l'email au client
    await sendReportEmail(clientEmail, companyName, report);

    // Envoyer une copie à Audilix
    await sendReportEmail(GMAIL_USER, `[COPIE] ${companyName}`, report);

    console.log(`✅ Rapport envoyé à ${clientEmail} — Score: ${report.score}`);
    res.status(200).json({ success: true, score: report.score });
  } catch (e) {
    console.error("❌ Erreur webhook:", e);
    res.status(500).json({ error: "Erreur traitement", details: String(e) });
  }
});

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Audilix backend en ligne ✅", version: "2.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Audilix IA backend en ligne sur le port", PORT)
);
