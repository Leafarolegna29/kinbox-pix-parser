import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// URL do seu n8n
const N8N_URL = "https://n8n.srv1025988.hstgr.cloud/webhook/kinbox/comprovantes";

// Rota principal que o Kinbox vai chamar
app.post("/", async (req, res) => {
  try {
    console.log("📩 Recebi POST do Kinbox:");
    console.log(JSON.stringify(req.body, null, 2));

    // Repassa para o n8n
    const response = await axios.post(N8N_URL, req.body, {
      headers: { "Content-Type": "application/json" }
    });

    console.log("✅ Repassado para n8n:", response.status);

    // Confirma para o Kinbox
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Erro ao repassar para n8n:", err.message);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});

// Subir servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server ON:", PORT);
});
