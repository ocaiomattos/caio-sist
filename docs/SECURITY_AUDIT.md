# Auditoria de segurança

> Ciclo 1 — 2026-10-21. Referências: OWASP ASVS 4.0 (níveis 1–2), OWASP Top 10 2021 e OWASP API Security Top 10 2023.
> Escopo: **somente este repositório**. Nenhum teste foi feito contra o FET ou contra outros sistemas de terceiros.

## 1. Contexto

O repositório estava vazio, então não havia código legado para auditar. Esta auditoria cobre:
1. os achados de segurança encontrados **durante a construção e a revisão** deste código;
2. o mapeamento de cada controle exigido para a implementação e para o teste que o comprova;
3. os riscos residuais.

Nenhuma afirmação aqui significa "seguro". Os controles reduzem riscos específicos, e a segurança efetiva também depende de infraestrutura, configuração e operação.

## 2. Achados deste ciclo

| ID | Gravidade | Achado | Status |
|---|---|---|---|
| S-01 | Alta (cadeia de desenvolvimento) | `vitest@3` puxava `tinypool ≤ 2.1.1` com 2 avisos **críticos** (prototype pollution → RCE, GHSA-5gmw-xhrv-c9v3 e GHSA-85c8-ppgw-ccpr). Afeta só o ambiente de desenvolvimento e CI | **Validado**: atualizado para `vitest@5`; `npm audit` = 0 vulnerabilidades |
| S-02 | Média | Cadastro concorrente com o mesmo e-mail estouraria a `UNIQUE` e devolveria 500, o que revelaria a existência da conta. Só é reproduzível com **múltiplos processos**; com better-sqlite3 num processo único a checagem e a inserção ficam sem `await` entre elas | **Implementado**: captura `SQLITE_CONSTRAINT_UNIQUE` e devolve a resposta genérica. O teste cobre o comportamento num processo único, mas **não reproduz a corrida** |
| S-03 | Média (DoS) | O rate limiter em memória nunca descartava chaves; com rotação de IPs ou e-mails a memória cresceria sem limite | **Validado**: varredura periódica de chaves inativas; teste unitário |
| S-04 | Baixa (desempenho) | Índice de descoberta com direção incompatível com o `ORDER BY` (ordenação temporária a cada consulta) | **Validado**: índice corrigido; plano de consulta e medição em `TEST_REPORT.md` |

Nenhuma vulnerabilidade foi deixada aberta de propósito. Os itens da seção 4 são riscos residuais, não falhas conhecidas no código.

## 3. Controles implementados e evidências

### Autenticação e sessões (ASVS V2, V3)
| Controle | Onde | Teste |
|---|---|---|
| scrypt N=2¹⁷, r=8, p=1, salt de 16 bytes, comparação em tempo constante | `src/lib/password.ts` | "cria conta não verificada…" (formato do hash) |
| Senha de 10 a 128 caracteres + lista de senhas comuns | `src/routes/auth.ts` | "rejeita datas inválidas, senha fraca…" |
| Anti-enumeração: respostas idênticas em cadastro, login e "esqueci a senha"; verificação de senha falsa quando o usuário não existe (tempo equivalente) | `auth.ts`, `burnPasswordCheck` | 3 testes de anti-enumeração |
| Limites: cadastro por IP; login por IP; **falhas** de login por conta (sem bloqueio permanente, evitando DoS contra a vítima); "esqueci a senha" por IP e por e-mail | `src/lib/rateLimiter.ts` | "limita cadastros por IP", "limita tentativas falhas…" |
| Token de sessão opaco de 256 bits; só o SHA-256 vai para o banco; expiração absoluta e por inatividade; logout, logout-all e revogação por dispositivo | `context.ts`, `auth.ts` | 5 testes de sessão |
| Redefinição de senha: token de uso único, validade de 30 min, só o mais recente vale, separado por finalidade; revoga todas as sessões; avisa por e-mail | `auth.ts` | 4 testes |
| Troca de senha exige a senha atual e encerra as outras sessões | `auth.ts` | "troca de senha exige…" |
| Tokens nunca vão para os logs; em desenvolvimento os e-mails são gravados em `var/outbox` com permissão 0600 | `app.ts`, `server.ts`, `mailer.ts` | smoke test (0 ocorrências de `token=` no log) |

### Autorização e dados (ASVS V4, V5; API1, API3, API5)
| Controle | Teste |
|---|---|
| Toda consulta de recurso filtra pelo dono ou participante (sessões, conversas, fotos, concessões); recurso alheio → 404 | "terceiros não leem…", "somente o dono altera…", "usuário lista e revoga apenas as próprias sessões" |
| Bloqueio aplicado no servidor em perfil, descoberta, mensagens, lista de conversas, fotos e concessões; resposta indistinguível de "não existe" | "bloqueio é imposto pelo servidor nas duas direções" |
| Mass assignment: schemas zod `.strict()` + mapa explícito de colunas | "PATCH rejeita campos não permitidos" |
| Papéis no servidor; moderador não age sobre a equipe nem sobre si mesmo | "usuário comum não acessa a fila…", "moderador não pode agir…" |
| Exposição mínima: a resposta pública não contém e-mail, data de nascimento, coordenadas nem horário de atividade | "resposta pública não expõe…" |
| Denúncia só sobre o que o denunciante pode ver (evita usar a denúncia para ler mensagens alheias) | "não permite denunciar (e ler) mensagem de conversa alheia" |
| SQL 100% parametrizado (better-sqlite3 `prepare`); IDs validados como UUID | "ids inválidos na rota retornam 400" |
| XSS: a API só devolve JSON com CSP `default-src 'none'` e `nosniff`. **O cliente precisa renderizar textos de usuário como texto, não HTML** | "envia cabeçalhos de segurança" |
| CSRF: autenticação por cabeçalho `Authorization`, sem cookies, então não há envio automático de credenciais | por desenho |
| CORS por lista de origens, sem credenciais | "CORS só reflete origens da lista" |
| SSRF: o servidor não busca URLs fornecidas por usuários | por desenho |

### Upload e mídia (ASVS V12)
| Controle | Teste |
|---|---|
| Tipo validado pelo **conteúdo** (decodificação com sharp), sem confiar em extensão ou Content-Type; só JPEG, PNG e WebP (SVG recusado) | 2 testes |
| Re-codificação remove EXIF/GPS e aplica a orientação | "re-codifica a imagem e remove metadados EXIF" |
| 10 MB por arquivo, 40 MP por imagem (bomba de descompressão), 12 fotos por usuário, 30 uploads por hora | 2 testes (tamanho e quantidade) |
| Chave de armazenamento gerada pelo servidor, validada por regex (contra path traversal) | "nome do arquivo enviado nunca vira caminho…" |
| Fotos privadas só com concessão do dono; URL HMAC com expiração de 5 min, comparação em tempo constante | 3 testes |

### Infraestrutura e erros (ASVS V7, V8, V14)
- Helmet: CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, CORP; HSTS em produção.
- Corpo JSON limitado a 64 KB; o multipart aceita 1 arquivo.
- Erro 500 genérico com `requestId`; o detalhe fica só no log. Validações devolvem 400 com o campo e a mensagem.
- Falha rápida em produção sem `MEDIA_URL_SECRET` forte ou sem `Mailer` real.
- `audit_log` para login, falhas de login, redefinições, bloqueios, concessões, moderação, recursos, exportação e exclusão. Não registra senhas, tokens nem conteúdo.

### Privacidade e segurança social
- Idade mínima de 18 anos aferida no servidor. A data de nascimento nunca é exposta a terceiros. **Limite:** é uma autodeclaração, não uma verificação de idade.
- A localização é arredondada (~5 km) **antes** de ser gravada; a distância só aparece em faixas a partir de "até 10 km". Isso reduz o risco de trilateração. Mesmo assim, quem conhece o algoritmo pode estimar a célula de ~5 km.
- Opções de visibilidade e descoberta, ocultar idade e distância, receber mensagens só de conversas existentes.
- Exportação (LGPD art. 18, II e V) e exclusão (art. 18, VI).

## 4. Riscos residuais e recomendações

| Risco | Recomendação | Responsável |
|---|---|---|
| Rate limit e sessões em instância única | Redis para os limites; banco gerenciado com backup e PITR | Infra |
| Sem CAPTCHA nem detecção de bots no cadastro | Turnstile ou hCaptcha após N tentativas | Produto + infra |
| Sem MFA | TOTP opcional para usuários; obrigatório para moderadores e administradores | Engenharia (próximo ciclo) |
| A URL assinada pode ser repassada a terceiros durante os 5 min de validade | Aceitável para fotos privadas? Alternativa: servir só com Bearer; marca d'água por destinatário | Produto |
| Sem moderação automática de imagens (nudez não consentida, CSAM) | Integrar hashing (PhotoDNA ou equivalente) e o canal de denúncia exigido por lei | Jurídico + produto |
| Verificação de idade por autodeclaração | Avaliar exigências legais por país (ex.: ECA Digital no Brasil, Online Safety Act no Reino Unido) | Jurídico |
| O texto de denúncias e evidências é guardado após a exclusão da conta | Definir prazo de retenção e base legal (LGPD art. 16) | Jurídico/DPO |
| `audit_log` guarda o id pseudônimo após a exclusão | Definir retenção | DPO |
| Entrega de e-mail | Provedor com SPF, DKIM e DMARC; monitorar bounces | Infra |
| Sem TLS no app (ele espera um proxy reverso) | Terminar TLS 1.2+ no proxy; `TRUST_PROXY=true` só nesse caso | Infra |
| Sem monitoramento nem alertas | Exportar métricas de 401, 429 e 5xx e de eventos do `audit_log` | Infra |
| Dependências | `npm audit` no CI + Dependabot | Engenharia |
