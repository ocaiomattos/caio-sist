# Reclamações públicas de usuários — FET

> Pesquisa feita em 2026-10-21. **Limitação importante:** só tive acesso aos trechos que o buscador devolve; as páginas das lojas e dos agregadores foram bloqueadas pela rede deste ambiente. Por isso não consegui contar relatos de forma sistemática. "Frequência observada" indica quantas fontes ou trechos distintos mencionaram o problema, não a proporção real de usuários afetados. Reclamações sobre a FetLife, que é outra plataforma, foram descartadas.

Legenda: **Confirmado** = vários relatos independentes e coerentes, ou resposta pública do desenvolvedor. **Suspeita** = poucos relatos ou uma única fonte. **Pedido** = solicitação de funcionalidade.

| # | Problema | Tipo | Frequência observada | Confiança |
|---|---|---|---|---|
| C1 | Perfis falsos, bots, golpistas e perfis inativos | Confirmado | Várias avaliações na App Store, JustUseApp e um comparador; o desenvolvedor respondeu que trabalha em filtros | Média–alta |
| C2 | Logout inesperado e falha na recuperação de senha (e-mail/SMS não chegam) | Confirmado | ≥ 3 relatos (App Store CA, ago/2024; JustUseApp; um blog); o desenvolvedor respondeu pedindo contato por e-mail | Média |
| C3 | Sem acesso por cerca de 36 h após enviar a foto de verificação | Suspeita | 1–2 relatos | Baixa |
| C4 | Banimento ou suspensão sem explicação nem canal de contato | Suspeita | 2 relatos (um sobre um post de fórum) | Baixa–média |
| C5 | Paywall agressivo; não é possível cancelar no meio do período | Confirmado (regra da loja) / Pedido | Trecho da ficha + relatos | Média |
| C6 | Perfil "pausado" continua visível; dificuldade para excluir a conta | Suspeita | 1 relato direto + 1 resumo | Baixa |
| C7 | Suporte lento (até 3 dias) | Confirmado | Resposta do próprio desenvolvedor | Média |
| C8 | Mensagens não entregues ou notificações falhando | **Não encontrado** | 0 relatos específicos do FET | — |

---

### C1 — Perfis falsos, bots e golpes
- **Descrição:** usuários dizem que boa parte dos perfis femininos é falsa ou está inativa, e que há golpistas pedindo cartões-presente ou cartões pré-pagos.
- **Fontes:** [App Store — avaliações](https://apps.apple.com/us/app/fet-kinky-bdsm-dating-app/id1478870872?see-all=reviews); [JustUseApp](https://justuseapp.com/en/app/1478870872/fet-kink-bdsm-dating/reviews); [go3fun](https://www.go3fun.co/poly-blog/best-bdsm-dating-sites/) (conteúdo com cara de patrocinado, peso baixo). Datas: não disponíveis nos trechos.
- **Impacto:** alto (confiança, segurança financeira, churn).
- **Causa-raiz provável (hipótese):** cadastro barato, sem verificação de canal; perfis abandonados continuam na descoberta; envio de mensagens em massa sem limite.
- **Solução implementada:** e-mail verificado antes de qualquer interação social; limite de cadastros por IP; descoberta exclui inativos há mais de 90 dias; limite de 20 conversas novas por dia e de 3 mensagens antes da primeira resposta; denúncias `scam` e `fake_profile` com prioridade; suspensão com revogação de sessões; e-mail de conta suspensa e excluída não pode ser reutilizado.
- **Validação:** `test/social.test.ts` ("limita novas conversas por dia", "limita mensagens antes da primeira resposta", "exclui perfis inativos há mais de 90 dias"); `test/auth.test.ts` ("limita cadastros por IP").
- **Pendente:** detecção de padrões de golpe no texto das mensagens (ex.: "gift card", links externos), verificação por selfie e CAPTCHA. Todos dependem de decisão de produto e de privacidade.

### C2 — Logout inesperado e recuperação de senha que falha
- **Fontes:** [App Store CA](https://apps.apple.com/ca/app/fet-kinky-bdsm-dating-app/id1478870872) (avaliação de 2024-08-01, resposta do desenvolvedor em 2024-08-05); [JustUseApp](https://justuseapp.com/en/app/1478870872/fet-kink-bdsm-dating/reviews).
- **Impacto:** alto (perda de acesso à conta).
- **Causa-raiz provável (hipótese):** sessões invalidadas sem critério visível; entrega de e-mail ou SMS falhando sem alternativa.
- **Solução implementada:** expiração de sessão explícita e previsível (30 dias absolutos, 14 dias sem uso), com lista de sessões ativas para o usuário; redefinição por link de uso único com validade de 30 min, em que só o link mais recente funciona e todas as sessões são revogadas ao final; reenvio de verificação; mensagens de erro claras ("Link inválido ou expirado. Solicite um novo.").
- **Validação:** `test/auth.test.ts`, bloco "recuperação de senha" e "sessão expira por inatividade".
- **Bloqueado:** a confiabilidade da entrega de e-mail depende de um provedor transacional com SPF, DKIM e DMARC, que ainda não existe.

### C3 — Bloqueio durante a verificação de perfil
- **Fonte:** trecho de avaliação na App Store, sem data.
- **Solução de projeto:** uma conta não verificada **consegue logar**, editar o perfil e ver o que falta (`emailVerified: false`). Só os recursos sociais exigem verificação. A verificação nunca tranca o usuário fora da conta.
- **Validação:** `test/auth.test.ts` ("conta não verificada pode logar mas não usa recursos sociais").

### C4 — Suspensão sem explicação
- **Fontes:** trechos de avaliações na App Store.
- **Solução implementada:** o motivo fica registrado e aparece para o usuário em `GET /me`; existe recurso (`POST /me/appeals`) com decisão registrada; a trilha de auditoria registra quem decidiu; moderadores não podem moderar a si mesmos nem colegas da equipe.
- **Validação:** `test/moderation-account.test.ts` ("suspensão revoga sessões; usuário vê o motivo e pode recorrer").

### C5 — Assinatura e cancelamento
- **Fonte:** trecho da ficha da App Store (renovação automática; "não é possível cancelar a assinatura atual durante o período ativo").
- **Situação:** **bloqueado.** Não existe módulo de pagamentos.
- **Recomendações para a futura integração:** mostrar preço, período e data de renovação antes da compra; incluir um link direto para "gerenciar assinatura" na loja; validar os recibos no servidor; avisar que excluir a conta não cancela a assinatura da loja.

### C6 — Perfil pausado continua visível
- **Fonte:** trecho de resumo do JustUseApp (relato único, peso baixo).
- **Solução implementada:** a desativação é aplicada em um ponto único (`canViewProfile`), então o perfil some do perfil direto, da descoberta, do envio de mensagens e das URLs de fotos. Também existe exclusão definitiva com exportação prévia.
- **Validação:** `test/moderation-account.test.ts` ("perfil desativado some imediatamente…", "exclusão exige senha e confirmação…").

### C7 — Suporte lento
- **Fora do escopo de código.** Mitigação parcial: autoatendimento para redefinir senha, gerenciar sessões, desativar e excluir a conta, além de um status transparente de denúncias e recursos.

### C8 — Mensagens e notificações
- **Não encontrei relatos específicos do FET.** Mesmo assim, implementei idempotência e sincronização incremental por serem boas práticas, mas **não apresento isso como resposta a uma reclamação verificada**.
