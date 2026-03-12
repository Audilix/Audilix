import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = "Audilix <onboarding@resend.dev>";

// ─── Envoi email via Resend ────────────────────────────────────
async function sendReportEmail(toEmail, companyName, report) {
  const { score, risques, recommandations, résumé } = report;
  const scoreColor = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";

  const risquesHtml = risques.map((r) => `<li style="margin-bottom:8px;">⚠️ ${r}</li>`).join("");
  const recoHtml = recommandations.map((r) => `<li style="margin-bottom:8px;">✅ ${r}</li>`).join("");

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
      <p style="font-size:15px;line-height:1.75;color:rgba(255,255,255,0.6);margin:0;">${résumé}</p>
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
      <p style="font-size:13px;color:rgba(255,255,255,0.35);margin:0 0 20px;">Passez à l'étape suivante avec un accompagnement complet</p>
      <a href="https://audilix.onrender.com/#tarifs" style="background:#C9A84C;color:#0B2545;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Voir nos offres →</a>
    </div>
    <div style="padding:24px 40px;text-align:center;">
      <p style="font-size:11px;color:rgba(255,255,255,0.2);margin:0;">© 2026 AUDILIX — contact.audilix@gmail.com</p>
    </div>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [toEmail],
      subject: `🔍 Votre rapport Audilix — Score ${score}/100`,
      html,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
  return data;
}

// ─── Appel OpenAI ──────────────────────────────────────────────
async function callOpenAI(messages) {
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
      résumé: "Votre entreprise présente un niveau de conformité intermédiaire. Plusieurs points critiques nécessitent une attention immédiate, notamment sur la protection des données personnelles et la sécurité informatique.",
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
      content: "Tu es un expert en conformité (RGPD, cybersécurité, RSE, ISO). Renvoie UNIQUEMENT un JSON valide sans markdown avec : score (0-100), risques (array de strings), recommandations (array de strings), résumé (string détaillé).",
    },
    { role: "user", content: JSON.stringify(p) },
  ];
}

// ─── Route audit direct ────────────────────────────────────────
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
    const fields = req.body?.data?.fields || [];

    // Log pour debug
    console.log("📋 Champs reçus:", JSON.stringify(fields.map(f => ({
      label: f.label,
      type: f.type,
      value: f.value
    })), null, 2));

    // Extraction email — cherche d'abord par type INPUT_EMAIL, puis par label
    const clientEmail =
      fields.find(f => f.type === "INPUT_EMAIL")?.value ||
      fields.find(f => f.label?.toLowerCase().includes("mail"))?.value ||
      fields.find(f => f.label?.toLowerCase().includes("email"))?.value ||
      fields.find(f => f.label?.toLowerCase().includes("e-mail"))?.value ||
      null;

    console.log("📧 Email trouvé:", clientEmail);

    if (!clientEmail || typeof clientEmail !== "string" || !clientEmail.includes("@")) {
      console.error("❌ Email invalide:", clientEmail);
      return res.status(400).json({ error: "Email client invalide ou introuvable" });
    }

    // Extraction autres champs
    const getValue = (label) => {
      const field = fields.find((f) =>
        f.label?.toLowerCase().includes(label.toLowerCase())
      );
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

    const auditData = { entreprise: companyName, secteur, taille, domaines_concernés: domaines, a_dpo_ou_responsable_conformité: dpo };

    const messages = buildPrompt(auditData);
    const raw = await callOpenAI(messages);
    const clean = raw.replace(/```json|```/g, "").trim();
    const report = JSON.parse(clean);

    await sendReportEmail(clientEmail, companyName, report);
    await sendReportEmail("contact.audilix@gmail.com", `[COPIE] ${companyName}`, report);

    console.log(`✅ Rapport envoyé à ${clientEmail} — Score: ${report.score}`);
    res.status(200).json({ success: true, score: report.score });
  } catch (e) {
    console.error("❌ Erreur webhook:", e);
    res.status(500).json({ error: "Erreur traitement", details: String(e) });
  }
});

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Audilix backend en ligne ✅", version: "2.2" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Audilix backend en ligne sur le port", PORT));
