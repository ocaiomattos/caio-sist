# Relatório de testes

> Execução: 2026-10-21, Node 22.22.0, Linux, vitest 5.0.5. Todos os resultados abaixo foram **executados de fato** neste ambiente.

## Resumo

| Verificação | Comando | Resultado |
|---|---|---|
| Testes automatizados | `npm test` | **67 de 67 passaram**, 5 arquivos, ~7–8 s |
| Typecheck (src + test) | `npm run typecheck` | sem erros |
| Build | `npm run build` | ok |
| Dependências | `npm audit` | 0 vulnerabilidades (depois de atualizar o vitest; ver S-01) |
| Smoke test do servidor real | `node dist/server.js` + curl | `/health` 200; cadastro 202; `/me` sem token 401; e-mail gravado em `var/outbox`; **0** ocorrências de `token=` no log |

## Cobertura por área

| Arquivo | Testes | Áreas |
|---|---|---|
| `test/auth.test.ts` | 20 | cadastro, idade mínima, anti-enumeração, validação, limite por IP, verificação de e-mail, login, limite de falhas, sessões (hash, logout, expiração, revogação, isolamento), redefinição e troca de senha, cadastro concorrente |
| `test/social.test.ts` | 19 | exposição mínima de dados, arredondamento de localização, mass assignment, perfil oculto, faixas de atividade, anti-scraping, bloqueio bidirecional, revogação de acesso privado, IDOR em conversas, idempotência, limites anti-spam, sincronização incremental, descoberta (filtros, cursor, inativos) |
| `test/media.test.ts` | 10 | remoção de EXIF, validação por conteúdo, SVG recusado, limite de tamanho e de quantidade, path traversal, posse da foto, fotos privadas, URLs assinadas (adulteração, troca de id, extensão do `exp`, expiração), bloqueio |
| `test/moderation-account.test.ts` | 16 | denúncias (evidência, alvo invisível, idempotência, prioridade), escalada de privilégio, suspensão, recurso e auditoria, limites do moderador, desativação, exportação, exclusão, e-mail restrito, cabeçalhos, CORS, erros sem vazamento, JSON malformado e 413, IDs inválidos |
| `test/rateLimiter.test.ts` | 2 | janela deslizante, limpeza de memória |

As verificações obrigatórias do pedido e os testes que as cobrem:

| Verificação | Teste |
|---|---|
| Um usuário não lê mensagens de outro | "terceiros não leem nem marcam como lidas conversas alheias (IDOR/BOLA)" |
| Um usuário não altera recursos sem autorização | "somente o dono altera ou exclui a foto…", "usuário lista e revoga apenas as próprias sessões" |
| O backend respeita bloqueios | "bloqueio é imposto pelo servidor nas duas direções" (+2) |
| Dados privados não aparecem em respostas indevidas | "resposta pública não expõe e-mail…", "exportação contém somente os dados do próprio titular" |
| A recuperação de senha não permite tomar contas alheias | 4 testes de "recuperação de senha" |
| Sem escalada de privilégio | "PATCH rejeita campos não permitidos", "usuário comum não acessa a fila…" |
| A exclusão de conta dispara os procedimentos previstos | "exclusão exige senha e confirmação, remove dados e anonimiza mensagens" |
| Erros não revelam segredos | "erros internos não vazam detalhes", "JSON malformado…" |

## Testes de mutação (os testes detectam regressões?)

Desliguei cada controle temporariamente e rodei a suíte. Em todos os casos pelo menos um teste falhou, e o código foi restaurado em seguida.

| Controle removido | Testes que falharam |
|---|---|
| Checagem de bloqueio em `canViewProfile` | 3 |
| Filtro de participante na conversa | 1 |
| `.strict()` no PATCH de perfil | 1 |
| Sanitização de imagem | 3 |
| Verificação da assinatura HMAC | 1 |
| Uso único do token (`used_at IS NULL`) | 3 |
| Arredondamento da localização | 1 |

## Desempenho (descoberta)

Script de benchmark fora do repositório: SQLite em memória, perfis sintéticos, 30 requisições por cenário via `inject`, sem rede.

| Cenário (100 mil perfis) | Antes do índice (p50 / p95) | Depois (p50 / p95) |
|---|---|---|
| `/discover?limit=20` | 2,8 / 5,7 ms | 2,5 / 4,8 ms |
| idade + gênero | 3,1 / 4,5 ms | 2,5 / 3,0 ms |
| `maxDistanceKm=50` | 4,2 / 5,9 ms | 3,7 / 4,4 ms |
| interesse | 3,2 / 4,4 ms | 2,6 / 3,4 ms |

Plano de consulta: antes, `SCAN p … USE TEMP B-TREE FOR ORDER BY`; depois, `SCAN p USING INDEX idx_profiles_discovery`. O ganho é modesto nesta escala. A medição em memória **não representa** latência de produção (disco, rede, concorrência).

## Limitações e o que não foi testado

- **Sem frontend**, então não houve testes end-to-end de interface nem de acessibilidade.
- O **limite diário de denúncias** está implementado, mas sem teste dedicado.
- A **corrida de cadastro entre processos** (S-02) não foi reproduzida. O teste existente roda num único processo, onde a corrida não ocorre.
- Sem testes de carga concorrente, de multi-instância ou com PostgreSQL/Redis.
- Arquivos de imagem maliciosos específicos (exploits de libvips/libjpeg) não foram testados. A mitigação depende de manter o `sharp` atualizado.
- Os e-mails são verificados só pelo `MemoryMailer`; não houve entrega real.
- Nenhum teste foi executado contra o FET ou contra serviços de terceiros.
