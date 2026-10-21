# caio-sist

Backend de uma rede social adulta (perfis, descoberta, mensagens, fotos privadas, bloqueio, denúncia e moderação). É uma implementação independente, baseada em padrões funcionais públicos do app FET, e as regras de segurança e privacidade são aplicadas no servidor.

## Requisitos

- Node.js ≥ 22

## Uso

```bash
npm install
cp .env.example .env     # ajuste os valores
npm run dev              # http://127.0.0.1:3000 ; e-mails de desenvolvimento ficam em ./var/outbox
npm test                 # suíte automatizada
npm run typecheck
```

Produção ainda não é suportada: falta configurar um provedor de e-mail. Ver `docs/IMPLEMENTATION_PLAN.md`.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md): componentes, endpoints e fluxos
- [Engenharia reversa do FET](docs/PRODUCT_REVERSE_ENGINEERING.md)
- [Reclamações de usuários](docs/USER_COMPLAINTS.md)
- [Auditoria de segurança](docs/SECURITY_AUDIT.md)
- [Plano de implementação](docs/IMPLEMENTATION_PLAN.md)
- [Relatório de testes](docs/TEST_REPORT.md)
