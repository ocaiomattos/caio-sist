import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createUser, setup, type TestEnv, type TestUser } from './helpers.js';

function multipart(filename: string, contentType: string, data: Buffer) {
  const boundary = '----testboundary7MA4YWxk';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } })
    .jpeg()
    .withExif({ IFD0: { Artist: 'SEGREDO-DO-AUTOR', Copyright: 'rua exata 123' } })
    .toBuffer();
}

async function upload(env: TestEnv, user: TestUser, data: Buffer, opts: { name?: string; type?: string; visibility?: string } = {}) {
  const mp = multipart(opts.name ?? 'foto.jpg', opts.type ?? 'image/jpeg', data);
  return env.req({
    method: 'POST',
    url: `/me/photos${opts.visibility ? `?visibility=${opts.visibility}` : ''}`,
    token: user.token,
    payload: mp.payload,
    headers: mp.headers,
  });
}

describe('upload de mídia', () => {
  it('re-codifica a imagem e remove metadados EXIF', async () => {
    const env = await setup();
    const u = await createUser(env);
    const input = await jpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const res = await upload(env, u, input);
    expect(res.statusCode).toBe(201);
    const [stored] = [...env.storage.files.values()];
    const meta = await sharp(stored!).metadata();
    expect(meta.exif).toBeUndefined();
    expect(stored!.includes(Buffer.from('SEGREDO-DO-AUTOR'))).toBe(false);
    expect(meta.format).toBe('jpeg');
  });

  it('rejeita arquivo que não é imagem mesmo com extensão e Content-Type de imagem', async () => {
    const env = await setup();
    const u = await createUser(env);
    const res = await upload(env, u, Buffer.from('<?php system($_GET["c"]); ?>'), { name: 'shell.jpg', type: 'image/jpeg' });
    expect(res.statusCode).toBe(415);
    expect(env.storage.files.size).toBe(0);
  });

  it('rejeita formatos fora da lista (ex.: SVG, que pode conter script)', async () => {
    const env = await setup();
    const u = await createUser(env);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    expect((await upload(env, u, svg, { name: 'a.svg', type: 'image/svg+xml' })).statusCode).toBe(415);
  });

  it('rejeita arquivos acima do limite de tamanho', async () => {
    const env = await setup();
    const u = await createUser(env);
    const big = Buffer.alloc(env.ctx.config.maxUploadBytes + 1024, 1);
    expect((await upload(env, u, big)).statusCode).toBe(413);
  });

  it('nome do arquivo enviado nunca vira caminho de armazenamento', async () => {
    const env = await setup();
    const u = await createUser(env);
    await upload(env, u, await jpegWithExif(), { name: '../../etc/passwd.jpg' });
    const [key] = [...env.storage.files.keys()];
    expect(key).toMatch(/^[a-f0-9-]{36}\.jpg$/);
  });

  it('aplica limite de fotos por usuário', async () => {
    const env = await setup();
    const u = await createUser(env);
    const img = await jpegWithExif();
    for (let i = 0; i < env.ctx.config.maxPhotosPerUser; i++) expect((await upload(env, u, img)).statusCode).toBe(201);
    const res = await upload(env, u, img);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('photo_limit');
  });

  it('somente o dono altera ou exclui a foto; exclusão remove o arquivo', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const photo = (await upload(env, a, await jpegWithExif())).json();
    expect((await env.req({ method: 'DELETE', url: `/me/photos/${photo.id}`, token: b.token })).statusCode).toBe(404);
    expect((await env.req({ method: 'PATCH', url: `/me/photos/${photo.id}`, token: b.token, payload: { visibility: 'private' } })).statusCode).toBe(404);
    expect((await env.req({ method: 'DELETE', url: `/me/photos/${photo.id}`, token: a.token })).statusCode).toBe(204);
    expect(env.storage.files.size).toBe(0);
  });
});

describe('fotos privadas e URLs assinadas', () => {
  it('foto privada só é acessível com concessão do dono, e a concessão pode ser revogada', async () => {
    const env = await setup();
    const owner = await createUser(env);
    const viewer = await createUser(env);
    const photo = (await upload(env, owner, await jpegWithExif(), { visibility: 'private' })).json();

    const profile = (await env.req({ method: 'GET', url: `/users/${owner.id}`, token: viewer.token })).json();
    expect(profile.photos).toHaveLength(0);
    expect(profile.privatePhotoCount).toBe(1);
    expect((await env.req({ method: 'GET', url: `/photos/${photo.id}/url`, token: viewer.token })).statusCode).toBe(404);

    await env.req({ method: 'POST', url: '/me/private-access', token: owner.token, payload: { userId: viewer.id } });
    const signed = await env.req({ method: 'GET', url: `/photos/${photo.id}/url`, token: viewer.token });
    expect(signed.statusCode).toBe(200);
    const file = await env.req({ method: 'GET', url: signed.json().url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['cache-control']).toMatch(/^private/);

    await env.req({ method: 'DELETE', url: `/me/private-access/${viewer.id}`, token: owner.token });
    expect((await env.req({ method: 'GET', url: `/photos/${photo.id}/url`, token: viewer.token })).statusCode).toBe(404);
  });

  it('URL assinada expira e não aceita assinatura adulterada nem troca de id', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const p1 = (await upload(env, a, await jpegWithExif())).json();
    const p2 = (await upload(env, a, await jpegWithExif())).json();
    const { url } = (await env.req({ method: 'GET', url: `/photos/${p1.id}/url`, token: b.token })).json();
    expect((await env.req({ method: 'GET', url: url.replace(p1.id, p2.id) })).statusCode).toBe(404);
    expect((await env.req({ method: 'GET', url: url.replace(/sig=.{4}/, 'sig=AAAA') })).statusCode).toBe(404);
    const longer = url.replace(/exp=(\d+)/, (_: string, e: string) => `exp=${Number(e) + 3600_000}`);
    expect((await env.req({ method: 'GET', url: longer })).statusCode).toBe(404);
    env.clock.advance(6 * 60 * 1000);
    expect((await env.req({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('bloqueado não obtém URL de foto pública de quem o bloqueou', async () => {
    const env = await setup();
    const a = await createUser(env);
    const b = await createUser(env);
    const photo = (await upload(env, a, await jpegWithExif())).json();
    await env.req({ method: 'POST', url: '/blocks', token: a.token, payload: { userId: b.id } });
    expect((await env.req({ method: 'GET', url: `/photos/${photo.id}/url`, token: b.token })).statusCode).toBe(404);
  });
});
