export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Guarda e-mails em memória. Usado em testes e desenvolvimento. Em produção, implemente um
 * Mailer com o provedor transacional escolhido (pendência externa, ver docs/IMPLEMENTATION_PLAN.md).
 */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.outbox.push(mail);
  }
}

/**
 * Somente desenvolvimento: grava cada e-mail como arquivo (permissão 0600) em vez de enviá-lo,
 * para que links de verificação e redefinição possam ser abertos sem aparecer em logs.
 */
export class FileOutboxMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(mail: Mail): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    await writeFile(join(this.dir, name), `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`, { mode: 0o600 });
  }
}
