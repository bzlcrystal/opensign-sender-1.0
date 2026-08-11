# OpenSign Sender

Interface Docker/Portainer pour envoyer un PDF déjà rempli vers OpenSign avec une signature à position fixe.

## Déploiement

1. Copiez `.env.example` vers `.env`.
2. Renseignez `OPENSIGN_API_TOKEN`. Le token se crée dans OpenSign via Settings > API Token.
3. Construisez le projet : `docker compose build`.
4. Démarrez : `docker compose up -d`.
5. Dans Nginx Proxy Manager, envoyez un sous-domaine vers le port `3100`.

## Important

Le payload peut varier selon la version OpenSign. Si OpenSign refuse la requête, utilisez son Debug UI pour comparer le JSON attendu, puis adaptez uniquement `app/api/send-document/route.ts`. La route utilise `x-api-token` et l’endpoint self-hosted `/app/functions/createdocument`.
