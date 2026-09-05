import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  aliasPublishableKeyHeader,
  CONTRACT_PUBLISHABLE_KEY_HEADER,
  MEDUSA_PUBLISHABLE_KEY_HEADER,
} from '../src/http/publishable-key-alias';

function app() {
  const a = express();
  a.use(aliasPublishableKeyHeader);
  a.get('/store/echo', (req, res) => {
    res.json({
      contract: req.headers[CONTRACT_PUBLISHABLE_KEY_HEADER] ?? null,
      medusa: req.headers[MEDUSA_PUBLISHABLE_KEY_HEADER] ?? null,
    });
  });
  return a;
}

describe('aliasPublishableKeyHeader (runs ahead of Medusa on /store)', () => {
  it('copies X-Publishable-Key to x-publishable-api-key', async () => {
    const res = await request(app()).get('/store/echo').set('X-Publishable-Key', 'pk_brand-a_dev');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contract: 'pk_brand-a_dev', medusa: 'pk_brand-a_dev' });
  });

  it('leaves both headers absent when the client sent none', async () => {
    const res = await request(app()).get('/store/echo');
    expect(res.body).toEqual({ contract: null, medusa: null });
  });

  it('never overwrites a Medusa header the client already sent', async () => {
    const res = await request(app())
      .get('/store/echo')
      .set('X-Publishable-Key', 'ours')
      .set('x-publishable-api-key', 'theirs');
    expect(res.body).toEqual({ contract: 'ours', medusa: 'theirs' });
  });
});
