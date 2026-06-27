[README.md](https://github.com/user-attachments/files/29419569/README.md)
# BST Webhook Server

Servidor que recebe respostas dos motoristas via Evolution API e salva no Firebase.

## Deploy no Railway

1. Faça upload desta pasta como novo projeto no Railway
2. Configure as variáveis de ambiente (Variables):

```
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"trackingbst",...}
EVO_URL=https://evolution-api-production-4f04.up.railway.app
EVO_KEY=e33b722cda8840b081914391ef5e55bc7ee16d72f85e6559d4ab180073c10d27
EVO_INST=bst-tracking
PORT=3000
```

3. Pegue a URL pública do servidor (ex: https://bst-webhook-xxxx.up.railway.app)
4. Configure o webhook na Evolution API apontando para: https://bst-webhook-xxxx.up.railway.app/webhook
