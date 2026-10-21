// Cada item é uma migração; nunca edite uma migração já publicada, acrescente uma nova.
// Timestamps são INTEGER em milissegundos desde a época Unix (UTC).
export const migrations: string[] = [
  /* 001 — esquema inicial */ `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'suspended')),
  birthdate TEXT NOT NULL,
  email_verified_at INTEGER,
  suspended_reason TEXT,
  password_changed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT 'unspecified',
  looking_for TEXT NOT NULL DEFAULT '[]',
  interests TEXT NOT NULL DEFAULT '[]',
  city TEXT NOT NULL DEFAULT '',
  -- Coordenadas já arredondadas (~5 km). A posição precisa nunca é persistida.
  lat_approx REAL,
  lng_approx REAL,
  visibility TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('members', 'hidden')),
  discoverable INTEGER NOT NULL DEFAULT 1,
  show_age INTEGER NOT NULL DEFAULT 1,
  show_distance INTEGER NOT NULL DEFAULT 1,
  allow_messages_from TEXT NOT NULL DEFAULT 'everyone' CHECK (allow_messages_from IN ('everyone', 'existing_conversations')),
  last_active_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Mesma direção nas duas colunas: o SQLite percorre o índice ao contrário para ORDER BY ... DESC, DESC.
CREATE INDEX idx_profiles_discovery ON profiles (last_active_at, user_id);
CREATE INDEX idx_profiles_geo ON profiles (lat_approx, lng_approx);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Tokens de uso único (verificação de e-mail e redefinição de senha). Só o hash é armazenado.
CREATE TABLE one_time_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_ott_user ON one_time_tokens (user_id, purpose);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX idx_blocks_blocked ON blocks (blocked_id);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  -- user_a < user_b para garantir uma única conversa por par
  user_a TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_b TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE INDEX idx_conv_a ON conversations (user_a, last_message_at DESC);
CREATE INDEX idx_conv_b ON conversations (user_b, last_message_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX idx_messages_conv_seq ON messages (conversation_id, seq);
CREATE UNIQUE INDEX idx_messages_idempotency ON messages (sender_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_photos_owner ON photos (owner_id, created_at);

CREATE TABLE private_access_grants (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, grantee_id)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'message', 'photo')),
  target_id TEXT NOT NULL,
  category TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  -- Cópia do conteúdo denunciado, preservada como evidência mesmo se o original for apagado.
  evidence TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolution TEXT,
  resolution_note TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_queue ON reports (status, priority DESC, created_at);
CREATE UNIQUE INDEX idx_reports_dedupe ON reports (reporter_id, target_type, target_id) WHERE status = 'open';

CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'reinstated')),
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_appeals_one_open ON appeals (user_id) WHERE status = 'open';

-- Hash do e-mail de contas suspensas que foram excluídas, para impedir recadastro imediato.
-- Somente o hash é guardado (minimização de dados).
CREATE TABLE restricted_emails (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Trilha de auditoria de ações sensíveis. Não armazena senhas, tokens nem conteúdo privado.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_user_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_target ON audit_log (target_user_id, created_at);
`,
];
