import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({limit:"50mb"}));

const OPENAI_KEY = process.env.OPENAI_API_KEY;

async function callOpenAI(messages){
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.15,
      max_tokens: 900
    })
  });

  const data = await res.json();
  return data.choices[0].message.content;
}

function prompt(p){
  return [
    { role: "system", content: "Tu es un expert en conformité (RGPD, cybersécurité, RSE, ISO). Renvoie un JSON avec : score (0-100), risques[], recommandations[], résumé détaillé." },
    { role: "user", content: JSON.stringify(p) }
  ];
}

app.post("/api/audit", async (req,res)=>{
  try {
    const messages = prompt(req.body);
    const raw = await callOpenAI(messages);
    const clean = raw.replace(/```json|```/g, "");
    res.json(JSON.parse(clean));
  } catch (e) {
    res.status(500).json({ error: "Erreur IA", details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Audilix IA backend en ligne sur le port", PORT));
