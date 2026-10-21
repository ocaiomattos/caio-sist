import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, type Context, isBlockedEitherWay } from '../context.js';
import { forbidden, notFound } from '../lib/errors.js';
import { newId } from '../lib/crypto.js';
import { limits } from '../lib/rateLimiter.js';
import { idParam, parse } from '../lib/validation.js';
import { canViewProfile, getProfileRow } from '../services/profiles.js';

/** Quantas mensagens alguém pode enviar antes de receber a primeira resposta (anti-spam/assédio). */
export const MAX_MESSAGES_BEFORE_REPLY = 3;

interface ConversationRow {
  id: string;
  user_a: string | null;
  user_b: string | null;
  created_at: number;
  last_message_at: number;
}

interface MessageRow {
  id: string;
  seq: number;
  conversation_id: string;
  sender_id: string | null;
  body: string | null;
  client_id: string | null;
  created_at: number;
  read_at: number | null;
}

const sendSchema = z
  .object({
    recipientId: z.string().uuid(),
    body: z.string().trim().min(1, 'Mensagem vazia').max(2000),
    // Identificador gerado pelo cliente: reenvios após falha de rede não duplicam a mensagem.
    clientId: z.string().uuid().optional(),
  })
  .strict();

const listQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function serializeMessage(m: MessageRow, viewerId: string) {
  return {
    id: m.id,
    seq: m.seq,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    fromMe: m.sender_id === viewerId,
    body: m.body,
    clientId: m.sender_id === viewerId ? m.client_id : null,
    createdAt: m.created_at,
    readAt: m.read_at,
  };
}

export function messageRoutes(app: FastifyInstance, ctx: Context): void {
  const { db, clock, limiter } = ctx;

  /** Carrega a conversa apenas se o usuário for participante; caso contrário, 404. */
  function loadOwnConversation(conversationId: string, userId: string): ConversationRow {
    const conv = db
      .prepare('SELECT * FROM conversations WHERE id = ? AND (user_a = ? OR user_b = ?)')
      .get(conversationId, userId, userId) as ConversationRow | undefined;
    if (!conv) throw notFound('Conversa não encontrada');
    return conv;
  }

  const otherParticipant = (c: ConversationRow, me: string) => (c.user_a === me ? c.user_b : c.user_a);

  app.post('/messages', async (req, reply) => {
    const user = authenticate(ctx, req);
    const body = parse(sendSchema, req.body);

    if (body.clientId) {
      const existing = db
        .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?')
        .get(user.id, body.clientId) as MessageRow | undefined;
      if (existing) return reply.code(200).send({ message: serializeMessage(existing, user.id), duplicate: true });
    }

    if (body.recipientId === user.id) throw notFound('Perfil não encontrado');
    const recipient = getProfileRow(ctx, body.recipientId);
    // Bloqueio, conta inativa ou perfil invisível são indistinguíveis de "não existe" para o remetente.
    if (!canViewProfile(ctx, user.id, recipient)) throw notFound('Perfil não encontrado');

    const [a, b] = user.id < body.recipientId ? [user.id, body.recipientId] : [body.recipientId, user.id];
    let conv = db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b) as
      | ConversationRow
      | undefined;

    if (!conv) {
      if (recipient.allow_messages_from === 'existing_conversations') {
        throw forbidden('recipient_not_accepting', 'Este perfil não está aceitando novas conversas.');
      }
      limiter.assertNotLimited(`new-conv:${user.id}`, limits.newConversationsPerUser);
    } else {
      const repliesFromRecipient = db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?')
        .get(conv.id, body.recipientId) as { n: number };
      if (repliesFromRecipient.n === 0) {
        const mine = db
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id = ?')
          .get(conv.id, user.id) as { n: number };
        if (mine.n >= MAX_MESSAGES_BEFORE_REPLY) {
          throw forbidden('awaiting_reply', 'Aguarde uma resposta antes de enviar mais mensagens.');
        }
      }
    }
    limiter.consume(`msg:${user.id}`, limits.messagesPerUser);

    const now = clock.now();
    const message = db.transaction(() => {
      if (!conv) {
        conv = { id: newId(), user_a: a, user_b: b, created_at: now, last_message_at: now };
        db.prepare('INSERT INTO conversations (id, user_a, user_b, created_at, last_message_at) VALUES (?, ?, ?, ?, ?)').run(
          conv.id,
          a,
          b,
          now,
          now,
        );
        limiter.record(`new-conv:${user.id}`, limits.newConversationsPerUser);
      }
      const { next } = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages').get() as { next: number };
      const row: MessageRow = {
        id: newId(),
        seq: next,
        conversation_id: conv.id,
        sender_id: user.id,
        body: body.body,
        client_id: body.clientId ?? null,
        created_at: now,
        read_at: null,
      };
      db.prepare(
        'INSERT INTO messages (id, seq, conversation_id, sender_id, body, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.seq, row.conversation_id, row.sender_id, row.body, row.client_id, row.created_at);
      db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now, conv.id);
      return row;
    })();

    return reply.code(201).send({ message: serializeMessage(message, user.id), duplicate: false });
  });

  app.get('/conversations', async (req) => {
    const user = authenticate(ctx, req);
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id IS NOT @me AND m.read_at IS NULL) AS unread,
           (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY seq DESC LIMIT 1) AS last_body
         FROM conversations c
         WHERE (c.user_a = @me OR c.user_b = @me)
         ORDER BY c.last_message_at DESC LIMIT 200`,
      )
      .all({ me: user.id }) as Array<ConversationRow & { unread: number; last_body: string | null }>;

    const result = [];
    for (const c of rows) {
      const otherId = otherParticipant(c, user.id);
      // Conversas com quem há bloqueio (em qualquer direção) não aparecem.
      if (otherId && isBlockedEitherWay(ctx, user.id, otherId)) continue;
      const other = otherId ? getProfileRow(ctx, otherId) : undefined;
      const visible = other && other.status === 'active';
      result.push({
        id: c.id,
        participant: visible ? { id: other.user_id, displayName: other.display_name } : { id: null, displayName: 'Usuário indisponível' },
        lastMessagePreview: c.last_body ? c.last_body.slice(0, 80) : null,
        lastMessageAt: c.last_message_at,
        unread: c.unread,
      });
    }
    return { conversations: result };
  });

  app.get('/conversations/:id/messages', async (req) => {
    const user = authenticate(ctx, req);
    const { id } = parse(idParam, req.params);
    const q = parse(listQuery, req.query);
    const conv = loadOwnConversation(id, user.id);
    const otherId = otherParticipant(conv, user.id);
    if (otherId && isBlockedEitherWay(ctx, user.id, otherId)) throw notFound('Conversa não encontrada');

    let rows: MessageRow[];
    if (q.after !== undefined) {
      // Sincronização incremental: tudo o que chegou depois do último seq conhecido pelo cliente.
      rows = db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
        .all(id, q.after, q.limit) as MessageRow[];
    } else {
      rows = (
        db
          .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(id, q.before ?? Number.MAX_SAFE_INTEGER, q.limit) as MessageRow[]
      ).reverse();
    }
    return { messages: rows.map((m) => serializeMessage(m, user.id)), hasMore: rows.length === q.limit };
  });

  app.post('/conversations/:id/read', async (req) => {
    const user = authenticate(ctx, req);
    const { id } = parse(idParam, req.params);
    const { upToSeq } = parse(z.object({ upToSeq: z.number().int().min(1) }).strict(), req.body);
    loadOwnConversation(id, user.id);
    const res = db
      .prepare('UPDATE messages SET read_at = ? WHERE conversation_id = ? AND seq <= ? AND sender_id IS NOT ? AND read_at IS NULL')
      .run(clock.now(), id, upToSeq, user.id);
    return { marked: res.changes };
  });
}
