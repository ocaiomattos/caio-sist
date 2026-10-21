# Engenharia reversa funcional — FET

> Data da pesquisa: 2026-10-21. Método: somente fontes públicas, via buscador.

## 1. Produto identificado

**FET** é um aplicativo social e de encontros para o público kink/BDSM, publicado pela **Ideawise Ltd.** Existem várias fichas nas lojas: "FET: Kinky BDSM Dating App" (iOS, id 1478870872) e as fichas Android `de.ideawise.fet` e `com.fet.ideawise` (com títulos como "FET: Connect, Date & Explore"). Domínio de suporte observado: `fet-app.com` (e-mail `support@fet-app.com`).

Não confundir com **FetLife**, que é outra plataforma. Os resultados de busca misturam as duas com frequência. Nenhuma informação da FetLife foi atribuída ao FET neste documento.

## 2. Limitações da investigação (leia antes de usar este documento)

- **A rede deste ambiente bloqueou o acesso direto** a apps.apple.com, play.google.com, justuseapp.com, appfollow.io, chrome-stats.com e similares (falha de DNS ou proxy 403). Só consegui ler **trechos devolvidos pelo buscador**. Não li páginas completas, não vi capturas de tela e não contei avaliações.
- Não houve teste manual com uma conta própria. Nenhuma credencial foi fornecida, e criar uma conta num serviço de terceiros não estava autorizado.
- Não tentei acessar APIs internas, engenharia reversa do binário nem tráfego de rede do app. Isso está fora do escopo autorizado.
- Logo, **todo o funcionamento interno descrito abaixo é hipótese**. Só o que está marcado "Verificado (fonte pública)" foi observado em texto de terceiros, e mesmo isso depende da fidelidade dos trechos.

## 3. Fatos observados em fontes públicas

| Fato | Confiança | Fonte |
|---|---|---|
| Editora Ideawise Ltd.; iOS e Android; gratuito com compras no app | Alta | [App Store](https://apps.apple.com/us/app/-/id1478870872), [Google Play](https://play.google.com/store/apps/details?id=de.ideawise.fet&gl=gb&hl=en-GB) |
| Feed de notícias (newsfeed), chat/mensagens, eventos locais | Média | [mwm.ai](https://mwm.ai/apps/fet-kinky-bdsm-dating-app/1478870872), trechos das fichas da Google Play |
| "Verificação de perfil" gratuita, apresentada como prova de que a pessoa "não é um bot" | Média | ficha da App Store (trecho), [appfollow](https://apps.appfollow.io/ios/fet-kinky-bdsm-dating-app/1478870872?country=us) |
| Upload de fotos e texto de apresentação ("share your story") | Média | trechos das fichas da Google Play |
| Assinatura de 1, 6 e 12 meses (≈ US$ 18,49/mês, ≈ US$ 90,99/ano nos EUA), renovação automática pela loja | Média | trecho da App Store; [apppricinglab](https://www.apppricinglab.com/app/google_play/com.fet.ideawise) |
| Recursos básicos (curtir/mensagens) limitados para quem não assina; "presentes" pagos para enviar mensagens | Baixa–média (relatos de usuários) | trechos de avaliações (App Store, [justuseapp](https://justuseapp.com/en/app/1478870872/fet-kink-bdsm-dating/reviews)) |
| Fluxo de redefinição de senha em `fet-app.com/in_app/lost_password/...` | Baixa (apenas a URL apareceu num resultado) | resultado de busca |
| Notas: ≈4,2–4,3 na App Store (≈20 mil avaliações, conforme o agregador), ≈3,9–4,1 na Google Play | Média (os números variam entre agregadores) | resultados de busca acima |
| Fórum e álbuns privados de fotos | **Não confirmados.** Uma busca mencionou "forum", outra não encontrou | — |

## 4. Mapa funcional e comparação com este projeto

Legenda de estado no projeto: **Validado** (implementado e com testes que passaram), **Ausente**, **Bloqueado** (depende de algo externo).

### 4.1 Cadastro, verificação e login
- **Finalidade:** criar conta adulta e entrar.
- **Fluxo observado (FET):** cadastro no app; há login com Apple ID (relato); recuperação por e-mail ou SMS (relato).
- **Falhas relatadas:** logout inesperado sem conseguir voltar; e-mail ou SMS de redefinição que não chega; bloqueio de acesso após enviar a foto de verificação (ver `USER_COMPLAINTS.md`, C2 e C3).
- **Hipótese de causa (não verificável):** sessões invalidadas sem aviso; recuperação dependente de canal único; verificação manual que bloqueia o login enquanto está pendente.
- **No projeto (Validado):** cadastro com idade ≥ 18 aferida no servidor, e-mail de verificação, respostas genéricas (sem enumeração de contas), scrypt, sessões listáveis e revogáveis, expiração absoluta e por inatividade, redefinição com token de uso único e validade de 30 min que revoga todas as sessões. Uma conta não verificada **consegue logar** e ver o que falta; ela não fica trancada do lado de fora.
- **Critérios de aceitação:** testes em `test/auth.test.ts`.
- **Ausente:** login social (Apple/Google), SMS, MFA. Ver o plano.

### 4.2 Perfil e privacidade
- **FET (observado):** fotos e texto; verificação de perfil.
- **No projeto (Validado):** perfil com campos em lista fechada; visibilidade `members`/`hidden`; opção de não aparecer na descoberta; ocultar idade e distância; localização arredondada a ~5 km antes de ser gravada; distância só em faixas; atividade em faixas ("ativo hoje"), sem horário exato.
- **Ausente:** verificação de identidade/selfie. Isso é deliberado: exige uma análise de privacidade (dado biométrico, LGPD art. 11) e uma decisão de produto.

### 4.3 Descoberta e busca
- **FET (relatos):** muitos perfis inativos ou falsos aparecem na busca.
- **No projeto (Validado):** filtros de idade, gênero, objetivo, interesse e distância; paginação por cursor estável; exclui contas inativas há mais de 90 dias, não verificadas, ocultas, desativadas, suspensas e bloqueadas em qualquer direção; limite de 60 consultas por minuto.

### 4.4 Mensagens
- **FET (relatos):** limite de mensagens para quem não assina; spam e golpes por mensagem.
- **No projeto (Validado):** conversa 1:1; idempotência por `clientId`; sincronização incremental por `seq`; confirmação de leitura; no máximo 3 mensagens antes da primeira resposta; 20 conversas novas por dia; opção "somente conversas existentes".
- **Ausente:** entrega em tempo real e push.

### 4.5 Fotos
- **No projeto (Validado):** JPEG/PNG/WebP validados pelo conteúdo real; re-codificação que remove EXIF/GPS; limite de 10 MB e de 40 MP; 12 fotos por usuário; fotos privadas com acesso concedido e revogado pelo dono; URLs assinadas válidas por 5 min.
- **Ausente:** moderação automática de imagens (nudez não consentida, CSAM). Exige um provedor externo; ver o plano.

### 4.6 Bloqueio, denúncia, moderação e recurso
- **FET (relatos):** banimento sem contato nem explicação; suporte demorado (até 3 dias, segundo resposta do desenvolvedor).
- **No projeto (Validado):** bloqueio bidirecional aplicado pelo servidor, que também revoga acessos a fotos privadas; denúncia por categoria, com evidência preservada e opção de bloquear junto; fila priorizada (`underage` e `non_consensual_content` no topo); suspensão revoga sessões; o usuário vê o motivo e pode recorrer; moderador não age sobre a equipe nem sobre si mesmo; trilha de auditoria.

### 4.7 Feed, eventos, fórum e "presentes"
- **No projeto: Ausente.** São recursos de produto que não ajudam a resolver nenhuma das reclamações priorizadas. Ficam para depois, com decisão de produto.

### 4.8 Assinatura e pagamentos
- **No projeto: Bloqueado** (depende de conta de desenvolvedor e da integração com App Store e Google Play Billing). As recomendações estão em `USER_COMPLAINTS.md`, C5.

### 4.9 Pausar ou excluir conta
- **FET (relato):** "mesmo com a conta pausada, as pessoas continuam vendo meu perfil"; dificuldade para excluir a conta.
- **No projeto (Validado):** a desativação esconde o perfil na hora, em todos os pontos de acesso (perfil, descoberta, mensagens, fotos); exclusão definitiva com senha e confirmação; exportação dos dados em JSON (LGPD art. 18).

## 5. O que não foi copiado

Nenhum código, texto, marca, logotipo ou ativo do FET. Só foram reproduzidos padrões funcionais genéricos do segmento: perfil, descoberta, mensagens, bloqueio e denúncia.
