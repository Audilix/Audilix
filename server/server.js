import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = "Audilix <onboarding@resend.dev>";
const AUDILIX_EMAIL = "mohamed7azouzi@gmail.com";

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
      <a href="https://audilix.onrender.com/#tarifs" style="background:#C9A84C;color:#0B2545;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Voir nos offres →</a>
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

// ─── Appel OpenAI ──────────────────────────────────────────────
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

// ─── Route SCAN PUBLIC ─────────────────────────────────────────
app.post("/api/scan", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL manquante" });

    console.log(`🔍 Scan demandé pour: ${url}`);

    const messages = [
      {
        role: "system",
        content: `Tu es un expert en conformité réglementaire européenne (RGPD, NIS2, AI Act, RSE, cybersécurité). 
        Analyse l'URL fournie et génère un rapport de conformité réaliste.
        Renvoie UNIQUEMENT un JSON valide sans markdown avec exactement cette structure :
        {
          "score": (nombre 0-100),
          "risques": [
            { "titre": "...", "description": "...", "niveau": "critique|important|modéré" },
            { "titre": "...", "description": "...", "niveau": "critique|important|modéré" },
            { "titre": "...", "description": "...", "niveau": "critique|important|modéré" }
          ],
          "résumé": "..."
        }
        Génère exactement 3 risques réalistes basés sur le type de site. Sois précis et professionnel.`
      },
      {
        role: "user",
        content: `Analyse la conformité de ce site web : ${url}
        
        Évalue notamment :
        - Présence et conformité de la politique de confidentialité
        - Gestion des cookies et consentement
        - Mentions légales
        - Sécurité (HTTPS, headers de sécurité)
        - Conformité RGPD globale
        - Risques juridiques potentiels
        
        Génère un score réaliste et 3 risques concrets pour ce type de site.`
      }
    ];

    const raw = await callOpenAI(messages, 600);
    const report = JSON.parse(cleanJSON(raw));

    console.log(`✅ Scan terminé pour ${url} — Score: ${report.score}`);
    res.json(report);

  } catch (e) {
    console.error("❌ Erreur scan:", e);
    res.status(500).json({ error: "Erreur analyse", details: String(e) });
  }
});

// ─── Route audit formulaire ────────────────────────────────────
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

// ─── Webhook Tally ─────────────────────────────────────────────
app.post("/webhook/tally", async (req, res) => {
  try {
    const fields = req.body?.data?.fields || [];

    console.log("📋 Champs reçus:", JSON.stringify(fields.map(f => ({
      label: f.label, type: f.type, value: f.value
    })), null, 2));

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
      { role: "user", content: JSON.stringify({ entreprise: companyName, secteur, taille, domaines_concernés: domaines, a_dpo_ou_responsable_conformité: dpo }) },
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

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Audilix backend en ligne ✅", version: "3.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Audilix backend en ligne sur le port", PORT));
