# Arquitetura

> Estado em 2026-10-21. O repositório estava **vazio** (sem commits nem branches) quando o trabalho começou; tudo aqui foi criado neste ciclo.

## Visão geral

Backend HTTP/JSON de uma rede social para adultos, com foco em segurança aplicada no servidor. **Não há frontend** neste repositório: os fluxos de UX foram tratados no nível da API (mensagens de erro, códigos estáveis, paginação, idempotência). Ver `IMPLEMENTATION_PLAN.md`.

| Camada | Escolha | Motivo |
|---|---|---|
| Runtime | Node.js 22, TypeScript (ESM, `strict`) | Disponível no ambiente; tipagem estrita reduz erros de contrato |
| HTTP | Fastify 5 + `@fastify/helmet`, `@fastify/cors`, `@fastify/multipart` | Validação, limites de corpo e cabeçalhos de segurança maduros |
| Validação | zod com schemas `.strict()` | Rejeita campos desconhecidos (proteção contra mass assignment) |
| Persistência | SQLite (better-sqlite3), WAL, `foreign_keys=ON` | Zero infraestrutura, transações síncronas, testes rápidos em memória. Caminho de migração para PostgreSQL documentado abaixo |
| Imagens | sharp (libvips) | Decodifica/re-codifica: valida o conteúdo real e remove EXIF/GPS |
| Senhas | `crypto.scrypt` nativo (N=2¹⁷, r=8, p=1) | Parâmetros recomendados pelo OWASP; sem dependência nativa extra |
| Testes | vitest 5 + `fastify.inject` | Testes de integração HTTP sem abrir porta |

## Estrutura

```
src/
  app.ts            # monta o Fastify: plugins, tratamento de erros, rotas
  server.ts         # ponto de entrada (somente desenvolvimento; bloqueia NODE_ENV=production sem Mailer real)
  config.ts         # leitura e validação de variáveis de ambiente
  context.ts        # Context (db, relógio, mailer, storage, limiter), autenticação, auditoria, bloqueio
  db/
    index.ts        # abertura do banco e execução de migrações (PRAGMA user_version)
    migrations.ts   # esquema
  lib/              # crypto, senha, rate limiter, geo, storage, mailer, validação, erros
  services/profiles.ts  # regra única de visibilidade e serialização de perfis
  routes/           # auth, account, profiles(+discover), blocks, messages, media, moderation
test/               # testes de integração e unitários
docs/               # este conjunto de documentos
```

## Modelo de dados (resumo)

- `users` — e-mail (minúsculo, único), hash scrypt, papel (`user`/`moderator`/`admin`), status (`active`/`deactivated`/`suspended`), data de nascimento, verificação de e-mail, motivo de suspensão.
- `profiles` — dados exibíveis + configurações de privacidade. Coordenadas **já arredondadas** (grade de 0,05° ≈ 5 km).
- `sessions` — somente `sha256(token)`; expiração absoluta (30 dias) e por inatividade (14 dias); revogação.
- `one_time_tokens` — verificação de e-mail e redefinição de senha; só hash; uso único; expiração.
- `blocks`, `private_access_grants`.
- `conversations` (um par único por conversa, `user_a < user_b`) e `messages` (com `seq` global monotônico para sincronização e `client_id` para idempotência).
- `photos` — metadados; o arquivo fica no `MediaStorage` sob chave gerada pelo servidor.
- `reports` (com cópia da evidência), `appeals`, `audit_log`, `restricted_emails` (só hash).

Exclusões usam `ON DELETE CASCADE`/`SET NULL` para que excluir um usuário limpe tudo o que é dele de forma atômica.

## Fluxos principais

**Autenticação.** `POST /auth/register` → conta não verificada + e-mail com token → `POST /auth/verify-email` → `POST /auth/login` devolve token Bearer opaco. Cada requisição autenticada passa por `authenticate()` (`src/context.ts`), que valida a sessão e aplica o status da conta (suspensa, desativada, não verificada) e o papel exigido pela rota.

**Visibilidade.** `canViewProfile()` (`src/services/profiles.ts`) é a regra única usada por perfil, descoberta, mensagens, fotos e denúncias: conta ativa + verificada, sem bloqueio em nenhuma direção, e perfil não oculto (ou com conversa prévia). Quando a regra nega, a API responde **404** — o solicitante não consegue distinguir "bloqueado" de "não existe".

**Mídia.** Upload multipart → limite de tamanho → `sanitizeImage()` decodifica com limite de pixels, aplica orientação, redimensiona para ≤2048 px e re-codifica em JPEG sem metadados → grava com chave aleatória. A leitura é feita via `GET /photos/:id/url` (verifica permissão e devolve URL assinada por HMAC, válida por 5 min) → `GET /files/:id?exp&sig`.

**Mensagens.** `POST /messages` (cria a conversa no primeiro envio). Sincronização: `GET /conversations/:id/messages?after=<seq>`. Reenvio com o mesmo `clientId` devolve a mensagem existente.

**Moderação.** `POST /reports` → fila priorizada `GET /moderation/reports` → `POST /moderation/reports/:id/resolve` (`dismiss`/`warn`/`remove_content`/`suspend`) → usuário suspenso vê o motivo em `GET /me` e recorre em `POST /me/appeals` → `POST /moderation/appeals/:id/decide`. Tudo registrado em `audit_log`.

## Endpoints

| Método e rota | Autenticação | Observação |
|---|---|---|
| `POST /auth/register`, `/auth/verify-email`, `/auth/resend-verification` | — | respostas genéricas |
| `POST /auth/login` | — | limites por IP e por conta |
| `POST /auth/logout`, `/auth/logout-all`; `GET /auth/sessions`; `DELETE /auth/sessions/:id` | sessão (qualquer status) | |
| `POST /auth/password/forgot`, `/auth/password/reset` | — | |
| `POST /auth/password/change` | sessão | |
| `GET /me`, `GET /me/export`, `DELETE /me` | sessão (qualquer status) | LGPD: acesso, portabilidade, exclusão |
| `POST /me/deactivate`, `/me/reactivate` | sessão | |
| `GET/PATCH /me/profile` | sessão (inclusive não verificada) | |
| `GET /users/:id`, `GET /discover` | ativo + verificado | rate limit anti-scraping |
| `GET/POST /blocks`, `DELETE /blocks/:id` | ativo + verificado | |
| `POST /messages`, `GET /conversations`, `GET /conversations/:id/messages`, `POST /conversations/:id/read` | ativo + verificado | |
| `POST/GET /me/photos`, `PATCH/DELETE /me/photos/:id`, `GET /photos/:id/url` | ativo + verificado | |
| `GET /files/:id?exp&sig` | URL assinada | |
| `GET/POST /me/private-access`, `DELETE /me/private-access/:id` | ativo + verificado | |
| `POST /reports`, `GET /reports/mine` | ativo + verificado | |
| `POST /me/appeals` | suspenso | |
| `/moderation/*` | `moderator` ou `admin` | |

Formato de erro uniforme: `{ "error": { "code": "...", "message": "...", "details"?: ... } }`. Erros 500 retornam apenas `requestId`.

## Operação e implantação

- Variáveis em `.env.example`. Em produção, `MEDIA_URL_SECRET` (≥ 32 caracteres) é obrigatório e `server.ts` recusa iniciar sem um `Mailer` real.
- `TRUST_PROXY=true` **somente** atrás de proxy confiável; caso contrário todos os clientes compartilham o IP do proxy nos limites por IP.
- Logs: `authorization`, `cookie` e corpo das requisições não são registrados; a URL é registrada sem query string.

### Limites conhecidos da arquitetura atual

1. **Rate limiter e SQLite são de instância única.** Para mais de uma instância: mover `RateLimiter` para Redis (mesma interface) e o banco para PostgreSQL (o SQL usado é padrão, exceto `json_each` → `jsonb_array_elements_text` e `RETURNING`, suportado em ambos).
2. **Sem tempo real.** Mensagens são sincronizadas por consulta incremental (`after=seq`). WebSocket/push dependem de decisão de infraestrutura (FCM/APNs).
3. **Armazenamento de mídia em disco local.** Para produção, implementar `MediaStorage` sobre um object storage privado.
4. **Serialização de perfis na descoberta faz uma consulta de fotos por perfil** (N+1, até 50 por página). Medido como aceitável (ver `TEST_REPORT.md`), mas é o primeiro ponto a otimizar.
