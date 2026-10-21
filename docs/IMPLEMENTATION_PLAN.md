# Plano de implementação

Estados: Pendente · Em investigação · Em implementação · Implementado, aguardando validação · Validado · Bloqueado por dependência externa.

"Validado" significa que o código existe e que os testes automatizados listados passaram neste ambiente (ver `TEST_REPORT.md`). Não significa que houve validação em produção nem testes com usuários reais.

## P0 — risco crítico

| # | Tarefa | Critério de aceitação | Estado |
|---|---|---|---|
| P0-1 | Isolamento entre usuários (conversas, fotos, sessões) | Recurso alheio → 404 e conteúdo ausente da resposta | Validado |
| P0-2 | Senhas com KDF forte e tokens só em hash | O hash começa com `scrypt$`; o token de sessão não aparece no banco | Validado |
| P0-3 | Bloqueio aplicado no servidor em todas as superfícies | O bloqueado não vê o perfil nem as fotos, não envia mensagens e não aparece na descoberta | Validado |
| P0-4 | Controle de acesso a fotos privadas e URLs não forjáveis | Sem concessão → 404; assinatura adulterada ou expirada → 404 | Validado |
| P0-5 | Idade mínima de 18 anos aferida no servidor | 17 anos e 364 dias → 400 `underage`; 18 anos → 202 | Validado |
| P0-6 | Dependência com vulnerabilidade crítica (S-01) | `npm audit` = 0 | Validado |

## P1 — segurança relevante e fluxos essenciais

| # | Tarefa | Critério de aceitação | Estado |
|---|---|---|---|
| P1-1 | Anti-enumeração em cadastro, login e "esqueci a senha" | Respostas idênticas | Validado |
| P1-2 | Rate limiting (cadastro, login, recuperação, perfis, descoberta, mensagens, uploads, denúncias) | 429 + `Retry-After` ao exceder | Validado (exceto o limite de denúncias, sem teste dedicado: **Implementado, aguardando validação**) |
| P1-3 | Redefinição de senha robusta | Uso único, 30 min, só o link mais recente vale, revoga sessões | Validado |
| P1-4 | Gestão de sessões (listar, revogar, logout-all, expiração) | Testes de sessão | Validado |
| P1-5 | Remoção de EXIF/GPS e validação real das imagens | Saída sem EXIF; arquivo não-imagem → 415 | Validado |
| P1-6 | Denúncia, fila priorizada, suspensão, recurso e auditoria | Fluxo completo testado | Validado |
| P1-7 | Desativação efetiva, exportação e exclusão (LGPD) | Perfil some na hora; dados apagados; mensagens anonimizadas | Validado |
| P1-8 | Mass assignment | `role`/`status`/`email` no PATCH → 400 | Validado |
| P1-9 | Erros sem vazamento e cabeçalhos de segurança | 500 genérico; CSP/nosniff presentes | Validado |
| P1-10 | Corrida no cadastro concorrente (S-02) | Sem 500 com múltiplos processos | Implementado, aguardando validação (exige teste multi-processo) |
| P1-11 | Mailer de produção (SPF/DKIM/DMARC) | E-mails entregues; `server.ts` libera `NODE_ENV=production` | **Bloqueado** (provedor e domínio) |
| P1-12 | MFA (TOTP) para moderadores e administradores | Login da equipe exige o segundo fator | Pendente |

## P2 — usabilidade, confiabilidade e desempenho

| # | Tarefa | Critério de aceitação | Estado |
|---|---|---|---|
| P2-1 | Anti-spam: 3 mensagens antes da primeira resposta; 20 conversas novas por dia; opção "somente conversas existentes" | Testes de mensagens | Validado |
| P2-2 | Mensagens idempotentes e sincronização incremental | Reenvio não duplica; `after=seq` traz só o delta | Validado |
| P2-3 | Descoberta: filtros, cursor estável, exclusão de inativos | Testes de descoberta | Validado |
| P2-4 | Índice de descoberta (S-04) | Plano sem ordenação temporária | Validado |
| P2-5 | Limpeza de memória do rate limiter (S-03) | Teste unitário | Validado |
| P2-6 | Conta não verificada consegue logar e ver o status (evita "ficar trancado") | Teste | Validado |
| P2-7 | Mensagens de erro em português com `code` estável para o cliente | Formato uniforme | Validado |
| P2-8 | Redis para rate limit e PostgreSQL para multi-instância | Mesma interface; suíte passando | Pendente |
| P2-9 | Tempo real (WebSocket) e push (FCM/APNs) | Entrega < 2 s com o app aberto | **Bloqueado** (credenciais FCM/APNs e infraestrutura) |
| P2-10 | Object storage privado para mídia | `MediaStorage` sobre S3/GCS | **Bloqueado** (conta de nuvem) |
| P2-11 | Eliminar o N+1 de fotos na descoberta | 1 consulta por página | Pendente |
| P2-12 | CAPTCHA adaptativo no cadastro | Exigido após comportamento suspeito | Bloqueado (provedor) |

## P3 — refinamentos e produto

| # | Tarefa | Estado |
|---|---|---|
| P3-1 | Frontend (web ou mobile) com acessibilidade (WCAG 2.2 AA), estados vazios, de carregamento e de erro | Pendente: decisão de stack |
| P3-2 | Feed, eventos e fórum | Pendente: decisão de produto |
| P3-3 | Assinatura (App Store/Play Billing) com cancelamento transparente | Bloqueado (contas de desenvolvedor) |
| P3-4 | Verificação de perfil por selfie | Pendente: exige RIPD (dado biométrico) |
| P3-5 | Moderação automática de imagens (CSAM/NCII) | Bloqueado (provedor + jurídico) |
| P3-6 | Detecção de padrões de golpe em mensagens | Pendente |
| P3-7 | CI (GitHub Actions: typecheck, testes, `npm audit`) | Pendente |

## Dependências externas e decisões humanas

1. Provedor de e-mail transacional e domínio verificado.
2. Infraestrutura: banco gerenciado, Redis, object storage, TLS e proxy.
3. Contas FCM/APNs; contas de desenvolvedor Apple/Google para pagamentos.
4. Jurídico/DPO: retenção de evidências e auditoria, verificação de idade por país, termos de uso e política de privacidade, base legal do processamento de dados sensíveis (vida sexual: LGPD art. 11).
5. Produto: stack do frontend, escopo de feed, eventos e fórum, política de fotos privadas (URL assinada ou somente Bearer).
