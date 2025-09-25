import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "50mb" })); // garante suporte a mídia/base64

// endpoint público para o Kinbox enviar
app.post("/kinbox-hook", async (req, res) => {
  try {
    const body = req.body;

    // resposta imediata para o Kinbox (evita timeout)
    res.status(200).json({ ok: true, received: true });

    // --- normalização ---
    const payload = {
      name: body?.contact?.name || "Desconhecido",
      phone: body?.contact?.phone || null,
      conversation_id: body?.conversation?.id || null,
      message: body?.message?.text || null,
      media_url: body?.attachments?.[0]?.url || null,
      timestamp: body?.timestamp || new Date().toISOString(),
    };

    // envia para o n8n
    await axios.post(
      "https://n8n.srv1025988.hstgr.cloud/webhook/kinbox/comprovantes",
      payload,
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    console.log("Payload encaminhado para n8n:", payload);
  } catch (err) {
    console.error("Erro no proxy:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy ativo na porta ${PORT}`);
});
