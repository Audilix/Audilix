import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({limit:'50mb'}));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_KEY){
  console.warn("⚠️ OPENAI_API_KEY manquant");
}

async function callOpenAI(messages){
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${OPENAI_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      messages,
      temperature:0.15,
      max_tokens:900
    })
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

function buildPrompt(p){
  return [
    { role:"system", content:"Tu es un expert en conformité (RGPD, cybersécurité, RSE, ISO). Analyse la situation d'une PME et renvoie un JSON avec: score (0-100), risks[], recommendations[], details." },
    { role:"user", content:`Entreprise: ${p.company}
Secteur: ${p.sector}
Taille: ${p.size}
Domaines: ${(p.domains||[]).join(", ")}
DPO: ${p.has_dpo}
Notes: ${p.notes || "Aucune"}` }
  ];
}

app.post("/api/audit", async (req,res)=>{
  try{
    const p = req.body;
    const messages = buildPrompt(p);
    const out = await callOpenAI(messages);
    const clean = out.replace(/```json|```/g,"");
    const json = JSON.parse(clean);
    res.json(json);
  }catch(e){
    console.error("Erreur IA:",e);
    res.status(500).json({error:"IA indisponible",details:String(e)});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("🚀 Audilix backend IA actif sur le port", PORT));
